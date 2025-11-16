/**
 * Momentary switch devices: stateless buttons that trigger actions
 * Supports: GenericSwitchDevice (with MomentarySwitch feature)
 */

import type { Endpoint } from "@matter/main";
import { GenericSwitchDevice } from "@matter/main/devices/generic-switch";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { SwitchServer } from "@matter/main/behaviors/switch";
import { Switch } from "@matter/main/clusters/switch";
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
 * Configuration for MomentarySwitch devices
 */
export interface MomentarySwitchDeviceConfig {
    type: "GenericSwitchDevice";
    name: string;
    topics: {
        getOnline: string;
        setCommand: string;
    };
    options: {
        onlineValue: string;
        offlineValue: string;
        commandValue: string;
    };
}

/**
 * MomentarySwitch device implementation
 */
export class MomentarySwitchDevice implements BaseDeviceInterface {
    constructor(
        public readonly config: MomentarySwitchDeviceConfig,
        public readonly endpoint: Endpoint,
        public readonly mqttClient: MqttClient
    ) {}

    /**
     * Initialize device: subscribe to topics and setup handlers
     */
    async initialize(): Promise<void> {
        const topics = [this.config.topics.getOnline];
        await this.mqttClient.subscribe(topics);
        this.setupMatterEventHandlers();
        console.log(`[${this.config.name}] MomentarySwitchDevice initialized`);
    }

    /**
     * Handle incoming MQTT messages
     */
    handleMqttMessage(topic: string, payload: Buffer): void {
        const message = payload.toString();

        if (topic === this.config.topics.getOnline) {
            this.handleAvailability(message);
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
     * Setup Matter event handlers for momentary switch
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint.events as any;

        if (events.switch?.initialPress$Changed) {
            events.switch.initialPress$Changed.on((value: { newPosition: number }) => {
                this.handleMatterButtonPress(value.newPosition);
            });
        }
    }

    /**
     * Handle Matter button press - publish to MQTT command topic
     */
    protected handleMatterButtonPress(position: number): void {
        console.log(`[${this.config.name}] Button pressed (position: ${position})`);

        const payload = this.config.options.commandValue;
        this.mqttClient
            .publish(this.config.topics.setCommand, payload)
            .catch((error) => console.error(`[${this.config.name}] Failed to publish command:`, error));
    }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "MomentarySwitchDevice",

        capabilities: new Set(["availability", "switch"]),

        topicSchema: {
            required: ["getOnline", "setCommand"],
            optional: [],
        },

        optionSchema: {
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
            commandValue: {
                type: "string",
                default: "",
                description: "Value to publish when button is pressed",
            },
        },

        validateConfig(config: any): ValidationResult {
            const errors: string[] = [];

            if (!config.name) {
                errors.push("Missing device name");
            }

            if (config.type !== "GenericSwitchDevice") {
                errors.push(`Invalid type for MomentarySwitchDevice: ${config.type}`);
            }

            // Validate topics
            errors.push(...validateTopics(config, this.topicSchema, config.name || "unknown"));

            // Apply option defaults
            config.options = applyOptionDefaults(config, this.optionSchema);

            return createValidationResult(errors);
        },

        createEndpointConfig(config: MomentarySwitchDeviceConfig): EndpointConfiguration {
            return {
                state: {
                    bridgedDeviceBasicInformation: {
                        nodeLabel: config.name,
                        productName: config.name,
                        productLabel: config.name,
                        serialNumber: `ih8-${config.name.toLowerCase().replace(/\s+/g, "-")}`,
                        reachable: true,
                    },
                    switch: {
                        numberOfPositions: 2,
                        currentPosition: 0,
                    },
                },
                topics: [config.topics.getOnline],
            };
        },

        getMatterDeviceType() {
            return () =>
                GenericSwitchDevice.with(
                    BridgedDeviceBasicInformationServer,
                    SwitchServer.with(Switch.Feature.MomentarySwitch)
                );
        },

        getMatterBehaviors() {
            return [
                BridgedDeviceBasicInformationServer,
                SwitchServer.with(Switch.Feature.MomentarySwitch),
            ];
        },
    };
}
