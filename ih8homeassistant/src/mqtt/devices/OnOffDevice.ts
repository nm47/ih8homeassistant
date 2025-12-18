/**
 * On/Off devices: switches and basic lights
 * Supports: OnOffPlugInUnitDevice, OnOffLightDevice
 */

import type { Endpoint } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import type { MqttClient } from "../MqttClient.js";
import type {
    BaseDeviceInterface,
    DeviceMetadata,
    EndpointConfiguration,
    ValidationResult,
} from "./metadata.js";
import {
    createValidationResult,
    validateTopics,
    applyOptionDefaults,
} from "./metadata.js";

/**
 * Configuration for OnOff devices
 */
export interface OnOffDeviceConfig {
    type: "OnOffPlugInUnitDevice" | "OnOffLightDevice";
    name: string;
    topics: {
        getOnline: string;
        getOn: string;
        setOn: string;
    };
    options: {
        onValue: string;
        offValue: string;
        onlineValue: string;
        offlineValue: string;
    };
}

/**
 * OnOff device implementation
 */
export class OnOffDevice implements BaseDeviceInterface {
    constructor(
        public readonly config: OnOffDeviceConfig,
        public readonly endpoint: Endpoint,
        public readonly mqttClient: MqttClient
    ) {}

    /**
     * Initialize device: subscribe to topics and setup handlers
     */
    async initialize(): Promise<void> {
        const topics = [this.config.topics.getOnline, this.config.topics.getOn];
        await this.mqttClient.subscribe(topics);
        this.setupMatterEventHandlers();
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
        }
    }

    /**
     * Handle device availability updates
     */
    protected handleAvailability(message: string): void {
        const isOnline = message === this.config.options.onlineValue;
        console.log(`[${this.config.name}] Availability: ${isOnline ? "online" : "offline"}`);

        this.endpoint
            .set({
                bridgedDeviceBasicInformation: {
                    reachable: isOnline,
                },
            } as any)
            .catch((error) => {
                console.error(`[${this.config.name}] Failed to update reachable status:`, error);
            });
    }

    /**
     * Handle on/off state updates from MQTT
     */
    protected handleOnOffState(message: string): void {
        const isOn = message === this.config.options.onValue;
        console.log(`[${this.config.name}] MQTT state: ${isOn ? "ON" : "OFF"}`);

        this.endpoint
            .set({
                onOff: {
                    onOff: isOn,
                },
            } as any)
            .catch((error) => {
                console.error(`[${this.config.name}] Failed to update on/off state:`, error);
            });
    }

    /**
     * Setup Matter event handlers
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint.events as any;
        if (events.onOff?.onOff$Changed) {
            events.onOff.onOff$Changed.on((value: boolean) => {
                this.handleMatterOnOffChange(value);
            });
        }
    }

    /**
     * Handle Matter on/off state change
     */
    protected handleMatterOnOffChange(value: boolean): void {
        const mqttPayload = value ? this.config.options.onValue : this.config.options.offValue;
        console.log(`[${this.config.name}] Matter state changed to: ${value ? "ON" : "OFF"}`);
        this.mqttClient
            .publish(this.config.topics.setOn, mqttPayload)
            .catch((error) => console.error(`[${this.config.name}] Failed to publish on/off:`, error));
    }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "OnOffDevice",

        capabilities: new Set(["availability", "onoff"]),

        topicSchema: {
            required: ["getOnline", "getOn", "setOn"],
            optional: [],
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

            if (!config.name) {
                errors.push("Missing device name");
            }

            if (!config.type || (config.type !== "OnOffPlugInUnitDevice" && config.type !== "OnOffLightDevice")) {
                errors.push(`Invalid type for OnOffDevice: ${config.type}`);
            }

            // Validate topics
            errors.push(...validateTopics(config, this.topicSchema, config.name || "unknown"));

            // Apply option defaults
            config.options = applyOptionDefaults(config, this.optionSchema);

            return createValidationResult(errors);
        },

        createEndpointConfig(config: OnOffDeviceConfig): EndpointConfiguration {
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
                topics: [config.topics.getOnline, config.topics.getOn],
            };
        },

        getMatterDeviceType() {
            // This will be determined at runtime based on config.type
            // Return a factory function that takes the config
            return (config: OnOffDeviceConfig) => {
                if (config.type === "OnOffPlugInUnitDevice") {
                    return OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer);
                } else {
                    return OnOffLightDevice.with(BridgedDeviceBasicInformationServer);
                }
            };
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];
        },
    };
}
