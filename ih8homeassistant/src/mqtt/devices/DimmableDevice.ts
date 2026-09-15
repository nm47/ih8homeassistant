/**
 * Dimmable devices: lights with brightness control
 * Supports: DimmableLightDevice
 */

import type { Endpoint } from "@matter/main";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
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
    validateDeviceConfig,
    matchToken,
} from "./metadata.js";
import { onControllerChange } from "./matterEvents.js";
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
     * Set the endpoint's reachable flag
     */
    setReachable(reachable: boolean): void {
        console.log(`[${this.config.name}] Availability: ${reachable ? "online" : "offline"}`);

        this.endpoint
            .set({
                bridgedDeviceBasicInformation: {
                    reachable,
                },
            } as any)
            .catch((error) => {
                console.error(`[${this.config.name}] Failed to update reachable status:`, error);
            });
    }

    /**
     * Release any timers held by this device
     */
    close(): void {
        // No timers to release
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

        // Controller-originated only, so state applied from MQTT above is not echoed back as
        // an MQTT command.
        onControllerChange<boolean>(events.onOff?.onOff$Changed, value =>
            this.handleMatterOnOffChange(value)
        );

        onControllerChange<number>(events.levelControl?.currentLevel$Changed, value =>
            this.handleMatterBrightnessChange(value)
        );
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

            if (config.type !== "DimmableLightDevice") {
                errors.push(`Invalid type for DimmableDevice: ${config.type}`);
            }

            errors.push(
                ...validateDeviceConfig(config, this.topicSchema, this.optionSchema, [
                    ["onValue", "offValue"],
                    ["onlineValue", "offlineValue"],
                ]).errors
            );

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
                        reachable: false,
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
            // DimmableLightDevice, not OnOffLightDevice: Level Control is optional on the
            // latter and would not be installed, while this device supplies and reads
            // levelControl state.
            return () => DimmableLightDevice.with(BridgedDeviceBasicInformationServer);
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];
        },
    };
}
