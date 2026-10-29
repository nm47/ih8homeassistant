/**
 * The house's MCP tools
 *
 * One McpServer is built per request (2026-07-28 clients) or per session (2025-era
 * clients), all sharing the same House and therefore the same live device state.
 *
 * Switching off a named printer needs a person's confirmation. It is requested from the
 * client with MCP elicitation (an input_required result; the SDK turns it into a real
 * elicitation/create request for 2025-era clients). The answer travels outside the tool
 * arguments, so a model cannot make it up, and the request state that comes back with it
 * is signed, bound to the printers asked about, and good for one use only.
 *
 * The dry-run server has the same tools on a dry-run House: the same names and checks,
 * but nothing is published and no person is asked anything.
 */

import { randomBytes } from "node:crypto";
import {
    McpServer,
    createRequestStateCodec,
    inputRequired,
    inputResponse,
    isInputRequiredResult,
} from "@modelcontextprotocol/server";
import type {
    CallToolResult,
    InputRequiredResult,
    RequestStateCodec,
    ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { House, NAMED_COLORS } from "../house/House.js";
import type { SwitchSelector } from "../house/House.js";
import { HouseError } from "../house/names.js";
import { DEVICE_KINDS } from "../types/config.js";

/** Key of the confirmation in inputRequests/inputResponses */
const CONFIRM_KEY = "confirm";

/** How long a person has to answer a confirmation */
const CONFIRMATION_TTL_SECONDS = 120;

/** Why printers are refused for a client that cannot ask a person */
const NO_ELICITATION = "this client cannot ask a person to confirm (no MCP elicitation support)";

/** Why a dry run refuses printers for a client that could ask a person */
const WOULD_ASK = "a person would be asked to confirm; a dry run asks no one";

/**
 * What a confirmation request carries through the client and back
 */
interface PrinterConfirmation {
    action: "turn_off";
    /** Sorted printer ids the person was asked about */
    printers: string[];
    nonce: string;
}

const deviceList = z
    .array(z.string())
    .min(1)
    .describe("Device ids, names or aliases, e.g. [\"den light\", \"tv\"]");
const room = z.string().describe("A room name, e.g. \"den\"; every switchable device in it except printers");

const kind = z.enum(DEVICE_KINDS).describe("Only devices of this kind, in the room given or else the whole house");
const except = z.array(z.string()).describe("Device ids, names or aliases to leave alone");

const selectorSchema = z.object({
    devices: deviceList.optional(),
    room: room.optional(),
});
const switchSchema = selectorSchema.extend({
    kind: kind.optional(),
    except: except.optional(),
});

export class HouseMcp {
    private readonly codec: RequestStateCodec<PrinterConfirmation>;
    /** Nonces of confirmations already used, with when they expire */
    private readonly usedNonces = new Map<string, number>();
    /** The same house as a dry run, for the dry-run server */
    private readonly dryRunHouse: House;

    constructor(private readonly house: House) {
        this.dryRunHouse = house.asDryRun();
        // A per-process key is enough: one process serves every round of a confirmation
        this.codec = createRequestStateCodec<PrinterConfirmation>({
            key: randomBytes(32),
            ttlSeconds: CONFIRMATION_TTL_SECONDS,
        });
    }

    /**
     * Build an McpServer with the house tools; with dryRun, on the dry-run House
     */
    createServer(options: { dryRun?: boolean } = {}): McpServer {
        const house = options.dryRun ? this.dryRunHouse : this.house;
        const log = (message: string) => console.log(`[MCP${house.dryRun ? " dry run" : ""}] ${message}`);

        const server = new McpServer(
            { name: "ih8homeassistant-house", version: "0.1.0" },
            {
                instructions:
                    "Controls the lights, plugs, TV and gadgets in this house. Use list_devices to see devices, " +
                    "rooms and states. Names must match a device id, name or alias exactly; unknown or ambiguous " +
                    "names are rejected with the valid candidates. Room-wide actions and all_off never switch " +
                    "printers; only kind printer selects them. Switching a printer off needs the person's " +
                    "confirmation, which this server asks for itself. Results say what each device confirmed; " +
                    "\"not confirmed\" means the command was sent but the device did not report back in time." +
                    (house.dryRun
                        ? " This is a dry run: the switching tools send nothing and ask no one, and return what " +
                          "they would have done, marked dry_run."
                        : ""),
                requestState: { verify: this.codec.verify },
                inputRequired: { roundTimeoutMs: CONFIRMATION_TTL_SECONDS * 1000 },
            }
        );

        server.registerTool(
            "list_devices",
            {
                description:
                    "List every device: id, name, aliases, room, kind (light, tv, printer, notifier or cooler), " +
                    "which tools work on it, whether it is online, its state, and where the state came from " +
                    "(\"reported\" by the device, or \"last sent\" for the TV, which cannot be queried). " +
                    "null means not known yet.",
                inputSchema: z.object({}),
                annotations: { readOnlyHint: true },
            },
            async () => this.json(house.listDevices())
        );

        server.registerTool(
            "get_state",
            {
                description: "Get the state of some devices, of a room, or (with neither) of every device.",
                inputSchema: selectorSchema,
                annotations: { readOnlyHint: true },
            },
            async ({ devices, room }) => this.guard(async () => house.getState({ devices, room }))
        );

        server.registerTool(
            "turn_on",
            {
                description:
                    "Switch devices on, or everything in a room except printers. Give devices or room, not both. " +
                    "Instead of devices, give kind to switch only devices of that kind, in the room given or else " +
                    "the whole house. Give except to leave some devices alone.",
                inputSchema: switchSchema,
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ devices, room, kind, except }) => this.guard(async () => {
                log(`turn_on ${describeSelector({ devices, room, kind, except })}`);
                return house.turnOn({ devices, room, kind, except });
            })
        );

        server.registerTool(
            "turn_off",
            {
                description:
                    "Switch devices off, or everything in a room except printers. Give devices or room, not both. " +
                    "Instead of devices, give kind to switch only devices of that kind, in the room given or else " +
                    "the whole house. Give except to leave some devices alone. Room results list the printers " +
                    "left alone. A named printer, or one chosen by kind printer, is only switched off after the " +
                    "person confirms in a prompt this server asks the client to show; there is no argument for it.",
                inputSchema: switchSchema,
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ devices, room, kind, except }, ctx) =>
                this.turnOff(server, house, log, { devices, room, kind, except }, ctx)
        );

        server.registerTool(
            "all_off",
            {
                description:
                    "Switch off everything in the house except printers. The result lists the printers left alone. " +
                    "Give except to leave some devices alone.",
                inputSchema: z.object({ except: except.optional() }),
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ except }) => this.guard(async () => {
                log(except !== undefined ? `all_off except=${except.join(",")}` : "all_off");
                return house.allOff(except);
            })
        );

        server.registerTool(
            "set_light",
            {
                description:
                    "Set a light's brightness (percent) and/or color. Color is \"#rrggbb\" or one of: " +
                    `${Object.keys(NAMED_COLORS).join(", ")}. Does not switch the light on or off.`,
                inputSchema: z.object({
                    device: z.string().describe("Device id, name or alias, e.g. \"nudge\""),
                    brightness: z.number().int().min(0).max(100).optional().describe("Percent, 0-100"),
                    color: z.string().optional().describe("\"#rrggbb\" or a color name"),
                }),
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ device, brightness, color }) => this.guard(async () => {
                log(`set_light ${device} brightness=${brightness ?? "-"} color=${color ?? "-"}`);
                return house.setLight(device, { brightness, color });
            })
        );

        server.registerTool(
            "set_tv_input",
            {
                description:
                    "Switch the TV's input, e.g. to \"HDMI2\". list_devices shows the inputs. The TV cannot be " +
                    "queried, so a confirmed result is the last command sent, not what the screen shows.",
                inputSchema: z.object({
                    input: z.string().describe("Input name, e.g. \"HDMI1\""),
                    device: z.string().optional().describe("Only needed if there is more than one TV"),
                }),
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ input, device }) => this.guard(async () => {
                log(`set_tv_input ${device ?? "(default)"} ${input}`);
                return house.setTvInput(device, input);
            })
        );

        server.registerTool(
            "bubble",
            {
                description: "Make blüp blow bubbles. It gives no confirmation, so the result only says it was sent.",
                inputSchema: z.object({
                    device: z.string().optional().describe("Only needed if there is more than one such device"),
                }),
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
            },
            async ({ device }) => this.guard(async () => {
                log(`bubble ${device ?? "(default)"}`);
                return house.bubble(device);
            })
        );

        return server;
    }

    /**
     * turn_off, with a person's confirmation for any printer named in it or chosen by kind
     *
     * Devices that are not printers are switched off either way; unconfirmed printers are
     * reported as refused. A dry run asks no one and takes no answer: its printers are
     * refused, saying a person would be asked, or as live when the client cannot ask.
     */
    private async turnOff(
        server: McpServer,
        house: House,
        log: (message: string) => void,
        selector: SwitchSelector,
        ctx: ServerContext
    ): Promise<CallToolResult | InputRequiredResult> {
        return this.guard(async () => {
            const printers = house.printersToConfirm(selector);
            if (printers.length === 0) {
                log(`turn_off ${describeSelector(selector)}`);
                return house.turnOff(selector);
            }

            const ids = printers.map(printer => printer.config.id).sort();

            if (house.dryRun) {
                const reason = supportsFormElicitation(server) ? WOULD_ASK : NO_ELICITATION;
                log(`turn_off ${describeSelector(selector)}: not confirming ${ids.join(", ")} (${reason})`);
                return house.turnOff(selector, { refusalReason: reason });
            }

            const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);

            if (answer.kind === "missing") {
                if (!supportsFormElicitation(server)) {
                    log(`turn_off ${describeSelector(selector)}: client cannot confirm ${ids.join(", ")}`);
                    return house.turnOff(selector, { refusalReason: NO_ELICITATION });
                }

                log(`turn_off ${describeSelector(selector)}: asking to confirm ${ids.join(", ")}`);
                const names = printers.map(printer => printer.config.name).join(" and ");
                return inputRequired({
                    inputRequests: {
                        [CONFIRM_KEY]: inputRequired.elicit({
                            message:
                                `Switch off ${names}? ` +
                                (printers.length === 1
                                    ? "It powers a 3D printer that may be in the middle of a print."
                                    : "They power 3D printers that may be in the middle of a print."),
                            requestedSchema: {
                                type: "object",
                                properties: {
                                    confirm: {
                                        type: "boolean",
                                        title: `Switch off ${names}`,
                                        default: false,
                                    },
                                },
                                required: ["confirm"],
                            },
                        }),
                    },
                    requestState: await this.codec.mint({
                        action: "turn_off",
                        printers: ids,
                        nonce: randomBytes(16).toString("hex"),
                    }),
                });
            }

            // The request state was verified before the handler ran. It still has to be
            // about these printers, and unused.
            const asked = ctx.mcpReq.requestState<PrinterConfirmation>();
            const matches =
                asked !== undefined &&
                asked.action === "turn_off" &&
                asked.printers.join(",") === ids.join(",") &&
                this.useNonce(asked.nonce);
            const accepted = answer.kind === "elicit" && answer.action === "accept" && answer.content?.confirm === true;

            if (matches && accepted) {
                log(`turn_off ${describeSelector(selector)}: person confirmed ${ids.join(", ")}`);
                return house.turnOff(selector, { confirmedPrinters: new Set(ids) });
            }

            const reason = !matches
                ? "the confirmation does not belong to this request"
                : answer.kind === "elicit" && answer.action === "decline"
                    ? "the person declined"
                    : answer.kind === "elicit" && answer.action === "cancel"
                        ? "the person cancelled"
                        : "the person did not confirm";
            log(`turn_off ${describeSelector(selector)}: not confirmed (${reason})`);
            return house.turnOff(selector, { refusalReason: reason });
        });
    }

    /**
     * Mark a confirmation nonce used; false if it already was
     */
    private useNonce(nonce: string): boolean {
        const now = Date.now();
        for (const [used, expires] of this.usedNonces) {
            if (expires < now) {
                this.usedNonces.delete(used);
            }
        }

        if (this.usedNonces.has(nonce)) {
            return false;
        }
        this.usedNonces.set(nonce, now + CONFIRMATION_TTL_SECONDS * 1000);
        return true;
    }

    /**
     * Run a house call, turning refusals into tool errors the client can show
     *
     * An input_required result passes through untouched; anything else is returned as JSON.
     */
    private async guard(call: () => Promise<unknown>): Promise<CallToolResult | InputRequiredResult> {
        try {
            const value = await call();
            return isInputRequiredResult(value) ? value : this.json(value);
        } catch (error) {
            if (error instanceof HouseError) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            throw error;
        }
    }

    private json(value: unknown): CallToolResult {
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    }
}

/**
 * Whether the client said it can show a form-mode elicitation
 *
 * An empty elicitation capability means form mode, per the spec.
 */
function supportsFormElicitation(server: McpServer): boolean {
    const elicitation = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
    if (elicitation === undefined) {
        return false;
    }
    return Object.keys(elicitation).length === 0 || elicitation.form !== undefined;
}

function describeSelector({ devices, room, kind, except }: SwitchSelector): string {
    return [
        devices !== undefined ? `devices=${devices.join(",")}` : null,
        room !== undefined ? `room=${room}` : null,
        kind !== undefined ? `kind=${kind}` : null,
        except !== undefined ? `except=${except.join(",")}` : null,
    ].filter(part => part !== null).join(" ");
}
