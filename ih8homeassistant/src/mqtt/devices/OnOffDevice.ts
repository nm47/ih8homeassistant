/**
 * On/Off devices: switches and basic lights
 * Supports: OnOffPlugInUnitDevice, OnOffLightDevice
 */

import { OnOffPlugInUnitDevice, OnOffPlugInUnitRequirements } from "@matter/main/devices/on-off-plug-in-unit";
import { OnOffLightDevice, OnOffLightRequirements } from "@matter/main/devices/on-off-light";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import type {
    DeviceMetadata,
    EndpointConfiguration,
    ValidationResult,
} from "./metadata.js";
import {
    createValidationResult,
    validateDeviceConfig,
    matchToken,
    parseJsonObject,
} from "./metadata.js";
import { BridgedDevice } from "./BridgedDevice.js";
import type { DeviceKind } from "../../types/config.js";
import { onControllerChange } from "./matterEvents.js";

/**
 * Configuration for OnOff devices
 */
export interface OnOffDeviceConfig {
    type: "OnOffPlugInUnitDevice" | "OnOffLightDevice";
    name: string;
    /** Printers are on-only in Matter; switching them off needs a person's confirmation */
    kind?: DeviceKind;
    topics: {
        getOnline: string;
        getOn: string;
        setOn: string;
        /** Periodic JSON report with a POWER field, e.g. Tasmota's tele/<topic>/STATE */
        getState?: string;
    };
    options: {
        onValue: string;
        offValue: string;
        onlineValue: string;
        offlineValue: string;
    };
}

/**
 * Make an OnOff server that ignores every Matter "off"
 *
 * matter.js routes Off, Toggle-while-on, OffWithEffect and the timed-off paths through
 * off(), so overriding it covers them all. The attribute never changes, so the controller
 * keeps seeing the printer on. Offline writes from MQTT bypass off(), so a printer switched
 * off through MCP still shows as off.
 */
function onOnly<T extends new (...args: any[]) => { off(): unknown; endpoint: { id: string } }>(Base: T) {
    class OnOnlyOnOffServer extends Base {
        override off(): void {
            console.warn(
                `[${this.endpoint.id}] Ignoring Matter "off": printers switch off only through MCP, with a person's confirmation`
            );
        }
    }
    return OnOnlyOnOffServer;
}

const OnOnlyPlugOnOffServer = onOnly(OnOffPlugInUnitRequirements.OnOffServer as any);
const OnOnlyLightOnOffServer = onOnly(OnOffLightRequirements.OnOffServer as any);

/**
 * OnOff device implementation
 */
export class OnOffDevice extends BridgedDevice<OnOffDeviceConfig> {
    protected metadata(): DeviceMetadata {
        return OnOffDevice.metadata;
    }

    /**
     * Initialize device: subscribe to topics and setup handlers
     */
    async initialize(): Promise<void> {
        const topics = [this.config.topics.getOnline, this.config.topics.getOn];
        if (this.config.topics.getState) {
            topics.push(this.config.topics.getState);
        }
        await this.mqttClient.subscribe(topics);
        if (this.endpoint) {
            this.setupMatterEventHandlers();
        }
        console.log(`[${this.config.name}] OnOffDevice initialized`);
    }

    /**
     * Handle incoming MQTT messages
     */
    handleMqttMessage(topic: string, payload: Buffer): void {
        const message = payload.toString();

        if (topic === this.config.topics.getOnline) {
            this.handleAvailability(message);
        } else if (topic === this.config.topics.getOn) {
            this.handleOnOffState(message);
        } else if (topic === this.config.topics.getState) {
            this.handleStateReport(message);
        }
    }

    /**
     * Handle on/off state updates from MQTT
     */
    protected handleOnOffState(message: string): void {
        const isOn = matchToken(message, this.config.options.onValue, this.config.options.offValue);

        if (isOn === null) {
            console.warn(`[${this.config.name}] Ignoring unrecognized on/off value: ${message}`);
            return;
        }

        console.log(`[${this.config.name}] MQTT state: ${isOn ? "ON" : "OFF"}`);
        this.applyOnOff(isOn);
    }

    /**
     * Handle a periodic JSON state report, taking only its POWER field
     */
    protected handleStateReport(message: string): void {
        const state = parseJsonObject(message);
        if (state === null) {
            console.warn(`[${this.config.name}] Ignoring non-JSON state report: ${message}`);
            return;
        }
        if (state.POWER === undefined) {
            return;
        }

        const isOn = matchToken(String(state.POWER), this.config.options.onValue, this.config.options.offValue);
        if (isOn === null) {
            console.warn(`[${this.config.name}] Ignoring unrecognized POWER value: ${state.POWER}`);
            return;
        }

        this.applyOnOff(isOn);
    }

    /**
     * Record a reported on/off state and mirror it into Matter
     */
    private applyOnOff(isOn: boolean): void {
        this.report({ on: isOn });
        this.updateEndpoint({ onOff: { onOff: isOn } }, "on/off state");
    }

    /**
     * Publish an on/off command
     */
    async setOn(on: boolean): Promise<void> {
        const payload = on ? this.config.options.onValue : this.config.options.offValue;
        await this.mqttClient.publish(this.config.topics.setOn, payload);
    }

    /**
     * Setup Matter event handlers
     *
     * Only controller-originated changes are forwarded, so the state we just applied from
     * MQTT above is not immediately republished as an MQTT command.
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint!.events as any;
        onControllerChange<boolean>(events.onOff?.onOff$Changed, value =>
            this.handleMatterOnOffChange(value)
        );
    }

    /**
     * Handle Matter on/off state change
     */
    protected handleMatterOnOffChange(value: boolean): void {
        // The on-only server already ignores "off" for printers. This is the second guard,
        // in case some other path ever changes the attribute.
        if (!value && this.config.kind === "printer") {
            console.warn(`[${this.config.name}] Not forwarding a Matter "off" for a printer`);
            return;
        }

        console.log(`[${this.config.name}] Matter state changed to: ${value ? "ON" : "OFF"}`);
        this.setOn(value).catch((error) =>
            console.error(`[${this.config.name}] Failed to publish on/off:`, error)
        );
    }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "OnOffDevice",

        capabilities: new Set(["availability", "onoff"]),

        topicSchema: {
            required: ["getOnline", "getOn", "setOn"],
            optional: ["getState"],
        },

        optionSchema: {
            onValue: {
                type: "string",
                default: "ON",
                description: "Value representing 'on' state",
            },
            offValue: {
                type: "string",
                default: "OFF",
                description: "Value representing 'off' state",
            },
            onlineValue: {
                type: "string",
                default: "Online",
                description: "Value representing 'online' state",
            },
            offlineValue: {
                type: "string",
                default: "Offline",
                description: "Value representing 'offline' state",
            },
        },

        validateConfig(config: any): ValidationResult {
            const errors: string[] = [];

            if (!config.type || (config.type !== "OnOffPlugInUnitDevice" && config.type !== "OnOffLightDevice")) {
                errors.push(`Invalid type for OnOffDevice: ${config.type}`);
            }

            errors.push(
                ...validateDeviceConfig(config, this.topicSchema, this.optionSchema, [
                    ["onValue", "offValue"],
                    ["onlineValue", "offlineValue"],
                ]).errors
            );

            return createValidationResult(errors);
        },

        createEndpointConfig(config: OnOffDeviceConfig): EndpointConfiguration {
            const topics = [config.topics.getOnline, config.topics.getOn];
            if (config.topics.getState) {
                topics.push(config.topics.getState);
            }

            return {
                state: {
                    bridgedDeviceBasicInformation: {
                        nodeLabel: config.name,
                        productName: config.name,
                        productLabel: config.name,
                        serialNumber: `ih8-${config.name.toLowerCase().replace(/\s+/g, "-")}`,
                        reachable: false,
                    },
                    onOff: {
                        onOff: true,
                    },
                },
                topics,
            };
        },

        getMatterDeviceType() {
            // This will be determined at runtime based on config.type
            // Return a factory function that takes the config
            return (config: OnOffDeviceConfig) => {
                if (config.type === "OnOffPlugInUnitDevice") {
                    return config.kind === "printer"
                        ? OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer, OnOnlyPlugOnOffServer as any)
                        : OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer);
                } else {
                    return config.kind === "printer"
                        ? OnOffLightDevice.with(BridgedDeviceBasicInformationServer, OnOnlyLightOnOffServer as any)
                        : OnOffLightDevice.with(BridgedDeviceBasicInformationServer);
                }
            };
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];
        },
    };
}
