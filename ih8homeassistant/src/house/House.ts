/**
 * The house: every configured device with its room, aliases and flags, and the rules for
 * switching them
 *
 * This is the layer the MCP tools sit on. It enforces the rules every client gets:
 * - names resolve exactly or fail with the candidates; nothing is sent for a bad request
 * - room-wide actions and all_off never include printers
 * - a printer is switched off only when the caller passes a person's confirmation for it
 * - results report what the device confirmed, or say it was sent and not confirmed;
 *   never an assumed state
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

/**
 * Outcome of turn_on, turn_off and all_off
 */
export interface SwitchResult {
    action: "turn_on" | "turn_off" | "all_off";
    room?: string;
    /** Sent, and the device then reported the requested state */
    switched: Array<{ id: string; state: OnOff; source: DeviceState["source"] }>;
    /** Already reported in the requested state; nothing sent */
    already: Array<{ id: string; state: OnOff }>;
    /** Sent, but no matching report arrived in time */
    not_confirmed: Array<{ id: string; sent: OnOff; last_reported: OnOff | null }>;
    /** Skipped: the device's availability topic says it is offline */
    offline: string[];
    /** Printers a room-wide action or all_off left alone, with their state */
    printers_skipped: Array<{ id: string; state: OnOff | null; online: boolean | null }>;
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

    constructor(
        devices: readonly HouseDevice[],
        private readonly mqttClient: MqttClient,
        private readonly confirmTimeoutMs: number
    ) {
        this.devices = new Map(devices.map(device => [device.config.id, device]));
        this.names = new NameIndex(devices.map(device => device.config));
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
     * Printers among the named devices, which turn_off would need a person to confirm
     *
     * Room selections never include printers, so this is empty for them. A printer that is
     * offline or reported itself off gets nothing sent, so needs nothing confirmed. Throws
     * for unknown or ambiguous names, like the switching calls do.
     */
    printersToConfirm(selector: Selector): HouseDevice[] {
        const selection = this.select(selector);
        if (!selection.named) {
            return [];
        }
        return selection.ids
            .map(id => this.devices.get(id)!)
            .filter(device => device.config.kind === "printer" && device.bridge.capabilities.has("onoff"))
            .filter(device => device.bridge.state.online !== false && !isReported(device.bridge.state, false));
    }

    /**
     * Switch named devices, or a room's devices, on
     */
    async turnOn(selector: Selector): Promise<SwitchResult> {
        return this.switchSelection("turn_on", selector, true, {});
    }

    /**
     * Switch named devices, or a room's devices, off
     */
    async turnOff(selector: Selector, options: TurnOffOptions = {}): Promise<SwitchResult> {
        return this.switchSelection("turn_off", selector, false, options);
    }

    /**
     * Switch off everything that switches, except printers
     */
    async allOff(): Promise<SwitchResult> {
        this.assertBrokerConnected();
        const all = [...this.devices.values()].filter(device => device.bridge.capabilities.has("onoff"));
        return this.switchDevices("all_off", all, false, { includePrinters: false });
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
        const confirmed = await this.sendAndWait(
            device,
            () => device.bridge.setLight!({ brightness, color }),
            state =>
                (brightness === undefined || (typeof state.brightness === "number" && Math.abs(state.brightness - brightness) <= 1)) &&
                (color === undefined || state.color === color)
        );

        const requested = [
            brightness !== undefined ? `brightness ${brightness}%` : null,
            color !== undefined ? `color ${color}` : null,
        ].filter(part => part !== null).join(" and ");

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

        try {
            await device.bridge.press!();
        } catch (error) {
            throw new HouseError(`Publishing to ${device.config.id} failed: ${errorMessage(error)}`);
        }

        return this.commandResult(device, false, `Sent to ${device.config.id}; it gives no confirmation`);
    }

    /**
     * Resolve a selector to device ids, remembering whether they were named or a room
     */
    private select(selector: Selector): { ids: string[]; named: boolean; room?: string } {
        const hasDevices = selector.devices !== undefined;
        const hasRoom = selector.room !== undefined;

        if (hasDevices === hasRoom) {
            throw new HouseError("Give either devices or a room, not both and not neither");
        }

        if (hasDevices) {
            return { ids: this.names.resolveDevices(selector.devices!), named: true };
        }

        const { room, ids } = this.names.resolveRoom(selector.room!);
        return { ids, named: false, room };
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
        selector: Selector,
        on: boolean,
        options: TurnOffOptions
    ): Promise<SwitchResult> {
        const selection = this.select(selector);
        const devices = selection.ids.map(id => this.devices.get(id)!);

        if (selection.named) {
            const cannot = devices.filter(device => !device.bridge.capabilities.has("onoff"));
            if (cannot.length > 0) {
                throw new HouseError(
                    `${cannot.map(device => device.config.id).join(", ")} cannot be switched on or off. Nothing was sent.`
                );
            }
        }

        this.assertBrokerConnected();

        const switchable = devices.filter(device => device.bridge.capabilities.has("onoff"));
        const result = await this.switchDevices(action, switchable, on, {
            includePrinters: selection.named,
            confirmedPrinters: options.confirmedPrinters,
            refusalReason: options.refusalReason,
        });
        if (selection.room !== undefined) {
            result.room = selection.room;
            result.summary = `In the ${selection.room}: ${result.summary}`;
        }
        return result;
    }

    /**
     * Switch devices and collect what each one did
     *
     * Every device is handled in parallel, so a room takes one confirmation timeout at
     * most, not one per device.
     */
    private async switchDevices(
        action: SwitchResult["action"],
        devices: HouseDevice[],
        on: boolean,
        options: { includePrinters: boolean; confirmedPrinters?: ReadonlySet<string>; refusalReason?: string }
    ): Promise<SwitchResult> {
        const target: OnOff = on ? "on" : "off";
        const result: SwitchResult = {
            action,
            switched: [],
            already: [],
            not_confirmed: [],
            offline: [],
            printers_skipped: [],
            refused: [],
            failed: [],
            summary: "",
        };

        const toSend: HouseDevice[] = [];
        for (const device of devices) {
            const { config, bridge } = device;
            const { state } = bridge;

            if (config.kind === "printer" && !options.includePrinters) {
                result.printers_skipped.push({ id: config.id, state: onOff(state.on), online: state.online });
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * One line a client can read out
 */
function summarize(result: SwitchResult): string {
    const parts: string[] = [];
    const ids = (items: Array<{ id: string }>) => items.map(item => item.id).join(", ");

    for (const state of ["on", "off"] as const) {
        const switched = result.switched.filter(item => item.state === state);
        if (switched.length > 0) {
            parts.push(`switched ${state}: ${ids(switched)}`);
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
    if (result.printers_skipped.length > 0) {
        const described = result.printers_skipped
            .map(item => `${item.id} (${item.state ?? "state unknown"})`)
            .join(", ");
        parts.push(`printers left alone: ${described}`);
    }

    return parts.length > 0 ? `${parts.join("; ")}.` : "Nothing to switch.";
}
