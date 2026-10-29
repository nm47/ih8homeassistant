/**
 * The house: every configured device with its room, aliases and flags, and the rules for
 * switching them
 *
 * This is the layer the MCP tools sit on. It enforces the rules every client gets:
 * - names resolve exactly or fail with the candidates; nothing is sent for a bad request
 * - room-wide and house-wide actions and all_off never include printers, unless the
 *   request asks for kind printer
 * - a printer is switched off only when the caller passes a person's confirmation for it
 * - results report what the device confirmed, or say it was sent and not confirmed;
 *   never an assumed state
 *
 * A dry-run House runs the same rules on the same devices and publishes nothing.
 */

import type { DeviceConfig, DeviceKind } from "../types/config.js";
import type { MqttClient } from "../mqtt/MqttClient.js";
import type { BaseDeviceInterface, DeviceCapability, DeviceState } from "../mqtt/devices/metadata.js";
import { HouseError, NameIndex } from "./names.js";

/**
 * A configured device and the bridge that talks to it
 */
export interface HouseDevice {
    readonly config: DeviceConfig;
    readonly bridge: BaseDeviceInterface;
}

/**
 * Devices named explicitly, or a whole room
 */
export interface Selector {
    devices?: string[];
    room?: string;
}

/**
 * What turn_on and turn_off act on: devices named explicitly, or a room's or the whole
 * house's devices of one kind; either way less the devices in except
 */
export interface SwitchSelector extends Selector {
    kind?: DeviceKind;
    except?: string[];
}

/**
 * A selector resolved to device ids
 */
interface Selection {
    ids: string[];
    /** Given as devices, which then must all switch */
    named: boolean;
    /** Named, or kind printer: printers are switched, with a person's confirmation to switch off */
    includePrinters: boolean;
    room?: string;
    /** Devices except took out of the selection */
    excepted?: string[];
}

/** The tool each capability makes available */
const CAPABILITY_TOOLS: Partial<Record<DeviceCapability, string[]>> = {
    onoff: ["turn_on", "turn_off"],
    dimming: ["set_light"],
    color: ["set_light"],
    input: ["set_tv_input"],
    switch: ["bubble"],
};

/**
 * Named colors set_light accepts besides "#rrggbb"
 */
export const NAMED_COLORS: Readonly<Record<string, string>> = {
    "red": "#ff0000",
    "orange": "#ff8000",
    "yellow": "#ffff00",
    "green": "#00ff00",
    "cyan": "#00ffff",
    "blue": "#0000ff",
    "purple": "#8000ff",
    "magenta": "#ff00ff",
    "pink": "#ff4080",
    "white": "#ffffff",
    "warm white": "#ffb060",
};

/**
 * What list_devices and get_state report for a device
 */
export interface DeviceInfo {
    id: string;
    name: string;
    aliases: string[];
    room: string;
    kind: DeviceKind;
    matter: boolean;
    /** The tools that work on this device */
    can: string[];
    inputs?: string[];
    /** null: not heard since startup or since the broker connection was lost */
    online: boolean | null;
    state: {
        on: boolean | null;
        brightness?: number | null;
        color?: string | null;
        input?: string | null;
    };
    /** "reported" by the device, or "last sent" for devices that cannot be queried */
    source: DeviceState["source"];
    reported_at: string | null;
}

type OnOff = "on" | "off";

/** A device left alone, with its state */
type LeftAlone = { id: string; state: OnOff | null; online: boolean | null };

/**
 * Outcome of turn_on, turn_off and all_off
 */
export interface SwitchResult {
    action: "turn_on" | "turn_off" | "all_off";
    /** Only in a dry run: nothing was sent, and switched lists what would have been */
    dry_run?: true;
    room?: string;
    kind?: DeviceKind;
    /** Sent, and the device then reported the requested state */
    switched: Array<{ id: string; state: OnOff; source: DeviceState["source"] }>;
    /** Already reported in the requested state; nothing sent */
    already: Array<{ id: string; state: OnOff }>;
    /** Sent, but no matching report arrived in time */
    not_confirmed: Array<{ id: string; sent: OnOff; last_reported: OnOff | null }>;
    /** Skipped: the device's availability topic says it is offline */
    offline: string[];
    /** Printers a room-wide action or all_off left alone, with their state */
    printers_skipped: LeftAlone[];
    /** Only when except was given: the devices it left alone, with their state */
    excepted?: LeftAlone[];
    /** Named printers not switched off, because no person confirmed it */
    refused: Array<{ id: string; reason: string }>;
    /** The publish itself failed */
    failed: Array<{ id: string; error: string }>;
    summary: string;
}

/**
 * Outcome of set_light, set_tv_input and bubble
 */
export interface CommandResult {
    id: string;
    /** Only in a dry run: nothing was sent, so nothing is confirmed */
    dry_run?: true;
    /** True when the device reported the requested values within the timeout */
    confirmed: boolean;
    /** The state after the wait, as reported; not what was requested */
    state: DeviceInfo["state"];
    source: DeviceState["source"];
    summary: string;
}

/**
 * Options for turn_off
 */
export interface TurnOffOptions {
    /** Printer ids a person has confirmed switching off for this request */
    confirmedPrinters?: ReadonlySet<string>;
    /** Why unconfirmed printers are refused, for the result */
    refusalReason?: string;
}

export class House {
    private readonly devices: Map<string, HouseDevice>;
    private readonly names: NameIndex;
    /** Publish nothing; switching calls return what they would have done */
    readonly dryRun: boolean;

    constructor(
        devices: readonly HouseDevice[],
        private readonly mqttClient: MqttClient,
        private readonly confirmTimeoutMs: number,
        options: { dryRun?: boolean } = {}
    ) {
        this.devices = new Map(devices.map(device => [device.config.id, device]));
        this.names = new NameIndex(devices.map(device => device.config));
        this.dryRun = options.dryRun ?? false;
    }

    /**
     * The same devices and rules as a dry run: every check runs as here, but switching
     * calls publish nothing and return what they would have done, marked dry_run
     */
    asDryRun(): House {
        return new House([...this.devices.values()], this.mqttClient, this.confirmTimeoutMs, { dryRun: true });
    }

    /**
     * Every device with its state
     */
    listDevices(): DeviceInfo[] {
        return [...this.devices.values()].map(device => this.describe(device));
    }

    /**
     * State of named devices, a room, or (with neither) every device
     */
    getState(selector: Selector): DeviceInfo[] {
        if (selector.devices === undefined && selector.room === undefined) {
            return this.listDevices();
        }
        return this.select(selector).ids.map(id => this.describe(this.devices.get(id)!));
    }

    /**
     * Printers among the named devices, or chosen by kind printer, which turn_off would
     * need a person to confirm
     *
     * Other room and house selections never include printers, so this is empty for them. A
     * printer that is offline or reported itself off gets nothing sent, so needs nothing
     * confirmed. Throws for unknown or ambiguous names, like the switching calls do.
     */
    printersToConfirm(selector: SwitchSelector): HouseDevice[] {
        const selection = this.select(selector, "turn_off");
        if (!selection.includePrinters) {
            return [];
        }
        return selection.ids
            .map(id => this.devices.get(id)!)
            .filter(device => device.config.kind === "printer" && device.bridge.capabilities.has("onoff"))
            .filter(device => device.bridge.state.online !== false && !isReported(device.bridge.state, false));
    }

    /**
     * Switch named devices, or a room's or the house's devices (of a kind), on
     */
    async turnOn(selector: SwitchSelector): Promise<SwitchResult> {
        return this.switchSelection("turn_on", selector, true, {});
    }

    /**
     * Switch named devices, or a room's or the house's devices (of a kind), off
     */
    async turnOff(selector: SwitchSelector, options: TurnOffOptions = {}): Promise<SwitchResult> {
        return this.switchSelection("turn_off", selector, false, options);
    }

    /**
     * Switch off everything that switches, except printers and the devices in except
     */
    async allOff(except?: string[]): Promise<SwitchResult> {
        const all = [...this.devices.keys()].filter(id => this.devices.get(id)!.bridge.capabilities.has("onoff"));
        const { ids, excepted } = this.leaveOut(all, except);
        // Printers stay in ids, to be reported as left alone, but never count as something to switch
        if (except !== undefined && !ids.some(id => this.devices.get(id)!.config.kind !== "printer")) {
            throw nothingToSwitch({ except });
        }

        this.assertBrokerConnected();
        return this.switchDevices("all_off", ids.map(id => this.devices.get(id)!), false, {
            includePrinters: false,
            excepted: excepted?.map(id => this.devices.get(id)!),
        });
    }

    /**
     * Set brightness (percent) and/or color on a light
     */
    async setLight(name: string, settings: { brightness?: number; color?: string }): Promise<CommandResult> {
        const device = this.devices.get(this.names.resolveDevice(name))!;
        const { capabilities } = device.bridge;

        if (!device.bridge.setLight || (!capabilities.has("dimming") && !capabilities.has("color"))) {
            throw new HouseError(`${device.config.id} has no brightness or color control`);
        }
        if (settings.brightness === undefined && settings.color === undefined) {
            throw new HouseError("Give a brightness, a color, or both");
        }
        if (settings.brightness !== undefined &&
            (!Number.isInteger(settings.brightness) || settings.brightness < 0 || settings.brightness > 100)) {
            throw new HouseError("Brightness must be a whole percentage from 0 to 100");
        }

        let color: string | undefined;
        if (settings.color !== undefined) {
            if (!capabilities.has("color")) {
                throw new HouseError(`${device.config.id} has no color control`);
            }
            color = parseColor(settings.color);
        }

        this.assertOnline(device);
        this.assertBrokerConnected();

        const brightness = settings.brightness;
        const requested = [
            brightness !== undefined ? `brightness ${brightness}%` : null,
            color !== undefined ? `color ${color}` : null,
        ].filter(part => part !== null).join(" and ");

        if (this.dryRun) {
            return this.commandResult(device, false, `Would send ${requested} to ${device.config.id}`);
        }

        const confirmed = await this.sendAndWait(
            device,
            () => device.bridge.setLight!({ brightness, color }),
            state =>
                (brightness === undefined || (typeof state.brightness === "number" && Math.abs(state.brightness - brightness) <= 1)) &&
                (color === undefined || state.color === color)
        );

        return this.commandResult(device, confirmed, confirmed
            ? `${device.config.id} confirmed ${requested}`
            : `Sent ${requested} to ${device.config.id}, not confirmed`);
    }

    /**
     * Select a TV input
     */
    async setTvInput(name: string | undefined, input: string): Promise<CommandResult> {
        const device = this.deviceWith("input", name, "set_tv_input");
        const inputs = device.bridge.inputs ?? [];
        const match = inputs.find(candidate => candidate.toLowerCase() === input.trim().toLowerCase());
        if (match === undefined) {
            throw new HouseError(`Unknown input "${input}" for ${device.config.id}. Inputs: ${inputs.join(", ")}`);
        }

        this.assertOnline(device);
        this.assertBrokerConnected();

        if (this.dryRun) {
            return this.commandResult(device, false, `Would send ${match} to ${device.config.id}`);
        }

        const confirmed = await this.sendAndWait(
            device,
            () => device.bridge.setInput!(match),
            state => state.input === match
        );

        return this.commandResult(device, confirmed, confirmed
            ? `${device.config.id} now on ${match} (${device.bridge.state.source})`
            : `Sent ${match} to ${device.config.id}, not confirmed`);
    }

    /**
     * Press a button device, e.g. make blüp blow bubbles
     *
     * Buttons report nothing back, so the result can only say the press was sent.
     */
    async bubble(name: string | undefined): Promise<CommandResult> {
        const device = this.deviceWith("switch", name, "bubble");
        this.assertOnline(device);
        this.assertBrokerConnected();

        if (this.dryRun) {
            return this.commandResult(device, false, `Would send to ${device.config.id}`);
        }

        try {
            await device.bridge.press!();
        } catch (error) {
            throw new HouseError(`Publishing to ${device.config.id} failed: ${errorMessage(error)}`);
        }

        return this.commandResult(device, false, `Sent to ${device.config.id}; it gives no confirmation`);
    }

    /**
     * Resolve a selector to device ids, remembering whether they were named, and which
     * devices except took out. The action only tailors the refusals.
     */
    private select(selector: SwitchSelector, action?: "turn_on" | "turn_off"): Selection {
        const hasDevices = selector.devices !== undefined;
        const hasRoom = selector.room !== undefined;
        const hasKind = selector.kind !== undefined;

        if (!hasDevices && !hasRoom && !hasKind && selector.except !== undefined) {
            throw new HouseError(
                "Give devices, a room or a kind alongside except." +
                (action === "turn_off" ? " To switch off everything but some devices, use all_off with except." : "")
            );
        }
        if (hasDevices && hasKind) {
            throw new HouseError("Give either devices or a kind, with or without a room, not both");
        }
        if (hasDevices === (hasRoom || hasKind)) {
            throw new HouseError("Give either devices or a room, not both and not neither");
        }

        let selection: Selection;
        if (hasDevices) {
            selection = { ids: this.names.resolveDevices(selector.devices!), named: true, includePrinters: true };
        } else {
            const { room, ids } = hasRoom
                ? this.names.resolveRoom(selector.room!)
                : { room: undefined, ids: [...this.devices.keys()] };
            selection = {
                ids: hasKind ? ids.filter(id => this.devices.get(id)!.config.kind === selector.kind) : ids,
                named: false,
                includePrinters: selector.kind === "printer",
                room,
            };
        }

        return { ...selection, ...this.leaveOut(selection.ids, selector.except) };
    }

    /**
     * Take the devices named in except out of a selection; every name must resolve
     */
    private leaveOut(ids: string[], except: readonly string[] | undefined): { ids: string[]; excepted?: string[] } {
        if (except === undefined) {
            return { ids };
        }
        const left = new Set(except.length > 0 ? this.names.resolveDevices(except) : []);
        return { ids: ids.filter(id => !left.has(id)), excepted: ids.filter(id => left.has(id)) };
    }

    /**
     * The device a single-device command applies to: the named one, or the only device
     * with the capability when no name is given
     */
    private deviceWith(capability: DeviceCapability, name: string | undefined, tool: string): HouseDevice {
        if (name !== undefined) {
            const device = this.devices.get(this.names.resolveDevice(name))!;
            if (!device.bridge.capabilities.has(capability)) {
                throw new HouseError(`${tool} does not work on ${device.config.id}`);
            }
            return device;
        }

        const candidates = [...this.devices.values()].filter(device => device.bridge.capabilities.has(capability));
        if (candidates.length !== 1) {
            throw new HouseError(
                candidates.length === 0
                    ? `No device supports ${tool}`
                    : `Name the device: ${tool} works on ${candidates.map(device => device.config.id).join(", ")}`
            );
        }
        return candidates[0];
    }

    private async switchSelection(
        action: "turn_on" | "turn_off",
        selector: SwitchSelector,
        on: boolean,
        options: TurnOffOptions
    ): Promise<SwitchResult> {
        const selection = this.select(selector, action);
        const devices = selection.ids.map(id => this.devices.get(id)!);

        if (selection.named) {
            const cannot = devices.filter(device => !device.bridge.capabilities.has("onoff"));
            if (cannot.length > 0) {
                throw new HouseError(
                    `${cannot.map(device => device.config.id).join(", ")} cannot be switched on or off. Nothing was sent.`
                );
            }
        }

        const canSwitch = (device: HouseDevice) => device.bridge.capabilities.has("onoff");
        const switchable = devices.filter(canSwitch);
        // Skipped printers stay in switchable, to be reported as left alone, but don't count here.
        // Without kind or except, a room with nothing to switch answers "Nothing to switch." as before.
        const eligible = switchable.filter(device => selection.includePrinters || device.config.kind !== "printer");
        if (eligible.length === 0 && (selector.kind !== undefined || selector.except !== undefined)) {
            throw nothingToSwitch(selector, selection.room);
        }

        this.assertBrokerConnected();

        const result = await this.switchDevices(action, switchable, on, {
            includePrinters: selection.includePrinters,
            confirmedPrinters: options.confirmedPrinters,
            refusalReason: options.refusalReason,
            excepted: selection.excepted?.map(id => this.devices.get(id)!).filter(canSwitch),
        });
        if (selection.room !== undefined) {
            result.room = selection.room;
            result.summary = `In the ${selection.room}: ${result.summary}`;
        }
        if (selector.kind !== undefined) {
            result.kind = selector.kind;
        }
        return result;
    }

    /**
     * Switch devices and collect what each one did
     *
     * Every device is handled in parallel, so a room takes one confirmation timeout at
     * most, not one per device. A dry run decides the same way and sends nothing.
     */
    private async switchDevices(
        action: SwitchResult["action"],
        devices: HouseDevice[],
        on: boolean,
        options: {
            includePrinters: boolean;
            confirmedPrinters?: ReadonlySet<string>;
            refusalReason?: string;
            excepted?: HouseDevice[];
        }
    ): Promise<SwitchResult> {
        const target: OnOff = on ? "on" : "off";
        const result: SwitchResult = {
            action,
            ...(this.dryRun ? { dry_run: true as const } : {}),
            switched: [],
            already: [],
            not_confirmed: [],
            offline: [],
            printers_skipped: [],
            ...(options.excepted ? { excepted: options.excepted.map(leftAlone) } : {}),
            refused: [],
            failed: [],
            summary: "",
        };

        const toSend: HouseDevice[] = [];
        for (const device of devices) {
            const { config, bridge } = device;
            const { state } = bridge;

            if (config.kind === "printer" && !options.includePrinters) {
                result.printers_skipped.push(leftAlone(device));
                continue;
            }
            // Offline first: an offline device's last report is stale
            if (state.online === false) {
                result.offline.push(config.id);
                continue;
            }
            if (isReported(state, on)) {
                result.already.push({ id: config.id, state: target });
                continue;
            }
            if (config.kind === "printer" && !on && !options.confirmedPrinters?.has(config.id)) {
                result.refused.push({
                    id: config.id,
                    reason: options.refusalReason ?? "switching off a printer needs a person's confirmation",
                });
                continue;
            }
            // A dry run stops here: what it would send is reported as switched
            if (this.dryRun) {
                result.switched.push({ id: config.id, state: target, source: state.source });
                continue;
            }
            toSend.push(device);
        }

        await Promise.all(toSend.map(async device => {
            const { config, bridge } = device;
            try {
                const confirmed = await this.sendAndWait(device, () => bridge.setOn!(on), state => state.on === on);
                if (confirmed) {
                    result.switched.push({ id: config.id, state: target, source: bridge.state.source });
                } else {
                    result.not_confirmed.push({ id: config.id, sent: target, last_reported: onOff(bridge.state.on) });
                }
            } catch (error) {
                result.failed.push({ id: config.id, error: errorMessage(error) });
            }
        }));

        // Parallel sends finish in any order; keep the output in config order
        const order = [...this.devices.keys()];
        const byOrder = (a: { id: string }, b: { id: string }) => order.indexOf(a.id) - order.indexOf(b.id);
        result.switched.sort(byOrder);
        result.not_confirmed.sort(byOrder);
        result.failed.sort(byOrder);

        result.summary = summarize(result);
        return result;
    }

    /**
     * Publish a command and wait for a report that matches it
     *
     * The listener is attached before publishing, because Tasmota answers within
     * milliseconds. A non-matching report does not end the wait: it may be a periodic
     * report that was already on its way.
     *
     * Resolves true when a matching report arrives in time; throws if the publish fails.
     */
    private async sendAndWait(
        device: HouseDevice,
        send: () => Promise<void>,
        matches: (state: Readonly<DeviceState>) => boolean
    ): Promise<boolean> {
        let unsubscribe: () => void = () => {};
        let timer: NodeJS.Timeout | undefined;

        const confirmation = new Promise<boolean>(resolve => {
            unsubscribe = device.bridge.onReport(state => {
                if (matches(state)) {
                    resolve(true);
                }
            });
            timer = setTimeout(() => resolve(false), this.confirmTimeoutMs);
        });

        try {
            await send();
            return await confirmation;
        } finally {
            unsubscribe();
            clearTimeout(timer);
        }
    }

    private assertBrokerConnected(): void {
        if (!this.mqttClient.isConnected()) {
            throw new HouseError("The MQTT broker is unavailable, so nothing was sent");
        }
    }

    private assertOnline(device: HouseDevice): void {
        if (device.bridge.state.online === false) {
            throw new HouseError(`${device.config.id} is offline, so nothing was sent`);
        }
    }

    private describe(device: HouseDevice): DeviceInfo {
        const { config, bridge } = device;
        const { state } = bridge;

        const can = new Set<string>();
        for (const capability of bridge.capabilities) {
            for (const tool of CAPABILITY_TOOLS[capability] ?? []) {
                can.add(tool);
            }
        }

        return {
            id: config.id,
            name: config.name,
            aliases: [...config.aliases],
            room: config.room,
            kind: config.kind,
            matter: config.matter,
            can: [...can],
            ...(bridge.inputs ? { inputs: [...bridge.inputs] } : {}),
            online: state.online,
            state: stateFields(state),
            source: state.source,
            reported_at: state.reportedAt?.toISOString() ?? null,
        };
    }

    private commandResult(device: HouseDevice, confirmed: boolean, summary: string): CommandResult {
        return {
            id: device.config.id,
            ...(this.dryRun ? { dry_run: true as const } : {}),
            confirmed,
            state: stateFields(device.bridge.state),
            source: device.bridge.state.source,
            summary,
        };
    }
}

/**
 * Accept "#rrggbb", "rrggbb" or a named color; return "#rrggbb" in lowercase
 */
export function parseColor(color: string): string {
    const named = NAMED_COLORS[color.trim().toLowerCase()];
    if (named !== undefined) {
        return named;
    }

    const match = color.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (!match) {
        throw new HouseError(
            `Unknown color "${color}". Use #rrggbb or one of: ${Object.keys(NAMED_COLORS).join(", ")}`
        );
    }
    return `#${match[1].toLowerCase()}`;
}

/**
 * The state fields that apply to a device, leaving out ones it doesn't have
 */
function stateFields(state: Readonly<DeviceState>): DeviceInfo["state"] {
    const fields: DeviceInfo["state"] = { on: state.on };
    if (state.brightness !== undefined) {
        fields.brightness = state.brightness;
    }
    if (state.color !== undefined) {
        fields.color = state.color;
    }
    if (state.input !== undefined) {
        fields.input = state.input;
    }
    return fields;
}

/**
 * Whether the device itself reported this on/off state
 *
 * Only a device's own report is trusted to skip a command; an echo of the last command
 * (the TV) may be out of date.
 */
function isReported(state: Readonly<DeviceState>, on: boolean): boolean {
    return state.source === "reported" && state.on === on;
}

function onOff(on: boolean | null): OnOff | null {
    return on === null ? null : on ? "on" : "off";
}

function leftAlone({ config, bridge }: HouseDevice): LeftAlone {
    return { id: config.id, state: onOff(bridge.state.on), online: bridge.state.online };
}

/**
 * The refusal for a selection that kind or except narrowed down to nothing switchable
 */
function nothingToSwitch(selector: SwitchSelector, room?: string): HouseError {
    const what = selector.kind !== undefined ? `device of kind ${selector.kind}` : "device";
    const where = selector.devices !== undefined
        ? "among the devices given"
        : room !== undefined ? `in the ${room}` : "in the house";
    const rest = selector.except !== undefined && selector.except.length > 0 ? " besides the ones in except" : "";
    return new HouseError(`No ${what} ${where}${rest} can be switched on or off. Nothing was sent.`);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * One line a client can read out
 */
function summarize(result: SwitchResult): string {
    const parts: string[] = [];
    const ids = (items: Array<{ id: string }>) => items.map(item => item.id).join(", ");
    const described = (items: LeftAlone[]) =>
        items.map(item => `${item.id} (${item.state ?? "state unknown"})`).join(", ");

    for (const state of ["on", "off"] as const) {
        const switched = result.switched.filter(item => item.state === state);
        if (switched.length > 0) {
            parts.push(`${result.dry_run ? "would switch" : "switched"} ${state}: ${ids(switched)}`);
        }
    }
    if (result.already.length > 0) {
        parts.push(`already ${result.already[0].state}: ${ids(result.already)}`);
    }
    if (result.not_confirmed.length > 0) {
        parts.push(`sent but not confirmed: ${ids(result.not_confirmed)}`);
    }
    if (result.offline.length > 0) {
        parts.push(`offline, skipped: ${result.offline.join(", ")}`);
    }
    if (result.failed.length > 0) {
        parts.push(`failed: ${ids(result.failed)}`);
    }
    if (result.refused.length > 0) {
        parts.push(`refused: ${result.refused.map(item => `${item.id} (${item.reason})`).join(", ")}`);
    }
    if (result.excepted !== undefined && result.excepted.length > 0) {
        parts.push(`left alone as asked: ${described(result.excepted)}`);
    }
    if (result.printers_skipped.length > 0) {
        parts.push(`printers left alone: ${described(result.printers_skipped)}`);
    }

    return parts.length > 0 ? `${parts.join("; ")}.` : "Nothing to switch.";
}
