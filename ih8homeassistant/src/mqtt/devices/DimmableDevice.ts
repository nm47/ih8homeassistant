/**
 * Dimmable devices: lights with brightness control
 * Supports: DimmableLightDevice
 */

import type { Endpoint } from "@matter/main";
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
import {
    mqttToMatterBrightness,
    matterToMqttBrightness,
    parseBrightness,
} from "../../utils/BrightnessConverter.js";

/**
 * Configuration for Dimmable devices
 */
export interface DimmableDeviceConfig {
    type: "DimmableLightDevice";
    name: string;
    topics: {
        getOnline: string;
        getOn: string;
        setOn: string;
        getBrightness: string;
        setBrightness: string;
    };
    options: {
        onValue: string;
        offValue: string;
        onlineValue: string;
        offlineValue: string;
    };
}

/**
 * Dimmable device implementation
 */
export class DimmableDevice implements BaseDeviceInterface {
    constructor(
        public readonly config: DimmableDeviceConfig,
        public readonly endpoint: Endpoint,
        public readonly mqttClient: MqttClient
    ) {}

    /**
     * Initialize device: subscribe to topics and setup handlers
     */
    async initialize(): Promise<void> {
        const topics = [
            this.config.topics.getOnline,
            this.config.topics.getOn,
            this.config.topics.getBrightness,
        ];
        await this.mqttClient.subscribe(topics);
        this.setupMatterEventHandlers();
        console.log(`[${this.config.name}] DimmableDevice initialized`);
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
        } else if (topic === this.config.topics.getBrightness) {
            this.handleBrightnessState(message);
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
     * Handle brightness state updates from MQTT
     */
    protected handleBrightnessState(message: string): void {
        const brightness = parseBrightness(message);
        if (brightness === null) {
            console.error(`[${this.config.name}] Invalid brightness value: ${message}`);
            return;
        }

        console.log(`[${this.config.name}] MQTT brightness: ${brightness}`);

        const matterLevel = mqttToMatterBrightness(brightness);
        this.endpoint
            .set({
                levelControl: {
                    currentLevel: matterLevel,
                },
            } as any)
            .catch((error) => {
                console.error(`[${this.config.name}] Failed to update brightness:`, error);
            });
    }

    /**
     * Setup Matter event handlers
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint.events as any;

        // On/Off events
        if (events.onOff?.onOff$Changed) {
            events.onOff.onOff$Changed.on((value: boolean) => {
                this.handleMatterOnOffChange(value);
            });
        }

        // Brightness events
        if (events.levelControl?.currentLevel$Changed) {
            events.levelControl.currentLevel$Changed.on((value: number) => {
                this.handleMatterBrightnessChange(value);
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
     * Handle Matter brightness change
     */
    protected handleMatterBrightnessChange(value: number): void {
        console.log(`[${this.config.name}] Matter brightness changed to: ${value}`);
        const mqttBrightness = matterToMqttBrightness(value);
        this.mqttClient
            .publish(this.config.topics.setBrightness, mqttBrightness.toString())
            .catch((error) => console.error(`[${this.config.name}] Failed to publish brightness:`, error));
    }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "DimmableDevice",

        capabilities: new Set(["availability", "onoff", "dimming"]),

        topicSchema: {
            required: ["getOnline", "getOn", "setOn", "getBrightness", "setBrightness"],
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

            if (config.type !== "DimmableLightDevice") {
                errors.push(`Invalid type for DimmableDevice: ${config.type}`);
            }

            // Validate topics
            errors.push(...validateTopics(config, this.topicSchema, config.name || "unknown"));

            // Apply option defaults
            config.options = applyOptionDefaults(config, this.optionSchema);

            return createValidationResult(errors);
        },

        createEndpointConfig(config: DimmableDeviceConfig): EndpointConfiguration {
            return {
                state: {
                    bridgedDeviceBasicInformation: {
                        nodeLabel: config.name,
                        productName: config.name,
                        productLabel: config.name,
                        serialNumber: `ih8-${config.name.toLowerCase().replace(/\s+/g, "-")}`,
                        reachable: true,
                    },
                    onOff: {
                        onOff: true,
                    },
                    levelControl: {
                        currentLevel: 254,
                    },
                },
                topics: [config.topics.getOnline, config.topics.getOn, config.topics.getBrightness],
            };
        },

        getMatterDeviceType() {
            return () => OnOffLightDevice.with(BridgedDeviceBasicInformationServer);
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];
        },
    };
}
