/**
 * Shared base for device bridges
 *
 * Holds what every device does the same way: availability, the live state that MQTT
 * reports, and mirroring into a Matter endpoint when there is one. Devices Matter does not
 * see get a null endpoint and keep their state here only, so the MCP tools can still read
 * and switch them.
 */

import type { Endpoint } from "@matter/main";
import type { MqttClient } from "../MqttClient.js";
import type {
    BaseDeviceInterface,
    DeviceCapability,
    DeviceMetadata,
    DeviceState,
    ReportListener,
} from "./metadata.js";
import { matchToken } from "./metadata.js";

/**
 * The part of a device config the base class relies on
 */
export interface BridgedDeviceConfig {
    name: string;
    options: {
        onlineValue: string;
        offlineValue: string;
    };
}

export abstract class BridgedDevice<C extends BridgedDeviceConfig> implements BaseDeviceInterface {
    readonly state: DeviceState;
    private readonly reportListeners = new Set<ReportListener>();

    constructor(
        public readonly config: C,
        public readonly endpoint: Endpoint | null,
        public readonly mqttClient: MqttClient
    ) {
        this.state = this.unknownState();
    }

    /** The device class's static metadata */
    protected abstract metadata(): DeviceMetadata;

    /**
     * What this device can do
     *
     * A getter rather than a field, so subclasses can widen it from their config without
     * running into class-field initialization order.
     */
    get capabilities(): ReadonlySet<DeviceCapability> {
        return this.metadata().capabilities;
    }

    abstract initialize(): Promise<void>;

    abstract handleMqttMessage(topic: string, payload: Buffer): void;

    /**
     * State before anything has been heard
     *
     * Devices whose state is only an echo of the last command override the source.
     */
    protected unknownState(): DeviceState {
        return { online: null, on: null, source: "reported", reportedAt: null };
    }

    /**
     * Subscribe to state reports
     */
    onReport(listener: ReportListener): () => void {
        this.reportListeners.add(listener);
        return () => {
            this.reportListeners.delete(listener);
        };
    }

    /**
     * Record a state report and tell the listeners
     */
    protected report(changes: Partial<DeviceState>): void {
        Object.assign(this.state, changes, { reportedAt: new Date() });

        for (const listener of this.reportListeners) {
            try {
                listener(this.state);
            } catch (error) {
                console.error(`[${this.config.name}] Error in state report listener:`, error);
            }
        }
    }

    /**
     * Handle device availability updates
     */
    protected handleAvailability(message: string): void {
        const isOnline = matchToken(
            message,
            this.config.options.onlineValue,
            this.config.options.offlineValue
        );

        if (isOnline === null) {
            console.warn(`[${this.config.name}] Ignoring unrecognized availability value: ${message}`);
            return;
        }

        this.setReachable(isOnline);
    }

    /**
     * Set the reachable flag
     */
    setReachable(reachable: boolean): void {
        console.log(`[${this.config.name}] Availability: ${reachable ? "online" : "offline"}`);
        this.state.online = reachable;
        this.updateEndpoint({ bridgedDeviceBasicInformation: { reachable } }, "reachable status");
    }

    /**
     * Forget everything heard over MQTT after the broker connection dropped
     */
    handleBrokerLost(): void {
        Object.assign(this.state, this.unknownState());
        this.updateEndpoint({ bridgedDeviceBasicInformation: { reachable: false } }, "reachable status");
    }

    /**
     * Apply state to the Matter endpoint, if Matter sees this device
     *
     * This is an offline write, so the controller-change handlers do not republish it.
     */
    protected updateEndpoint(values: Record<string, unknown>, what: string): void {
        if (!this.endpoint) {
            return;
        }

        this.endpoint.set(values as any).catch((error) => {
            console.error(`[${this.config.name}] Failed to update ${what}:`, error);
        });
    }

    /**
     * Release any timers held by this device
     */
    close(): void {
        // No timers to release
    }
}
