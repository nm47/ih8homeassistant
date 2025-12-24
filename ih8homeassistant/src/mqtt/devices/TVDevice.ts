/**
 * TV devices with on/off control
 * Currently uses OnOffPlugInUnitDevice pending BasicVideoPlayerDevice support in matter.js
 * Future: Will migrate to BasicVideoPlayerDevice when available
 *
 * Parses JSON STATE messages to extract POWER field for on/off state
 */

import type { Endpoint } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
// Future import when BasicVideoPlayerDevice is available in matter.js:
// import { BasicVideoPlayerDevice } from "@matter/main/devices/basic-video-player";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
// Future import for MediaInput support:
// import { MediaInputServer } from "@matter/main/behaviors/media-input";
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
 * Configuration for TV devices
 */
export interface TVDeviceConfig {
    type: "TVDevice";
    name: string;
    topics: {
        getOnline: string;      // e.g., "tele/tv/LWT"
        getState: string;        // e.g., "tele/tv/STATE" (JSON with POWER field)
        setPower: string;        // e.g., "cmnd/tv/POWER"
        // Future expansion:
        // getInput?: string;    // e.g., "tele/tv/STATE" (JSON with INPUT field)
        // setInput?: string;    // e.g., "cmnd/tv/INPUT"
    };
    options: {
        onValue: string;         // "ON"
        offValue: string;        // "OFF"
        onlineValue: string;     // "Online"
        offlineValue: string;    // "Offline"
        // Future expansion:
        // supportedInputs?: string[];  // ["HDMI1", "HDMI2", "HDMI3"]
    };
}

/**
 * TV device implementation
 */
export class TVDevice implements BaseDeviceInterface {
    constructor(
        public readonly config: TVDeviceConfig,
        public readonly endpoint: Endpoint,
        public readonly mqttClient: MqttClient
    ) {}

    /**
     * Initialize device: subscribe to topics and setup handlers
     */
    async initialize(): Promise<void> {
        const topics = [this.config.topics.getOnline, this.config.topics.getState];
        await this.mqttClient.subscribe(topics);
        this.setupMatterEventHandlers();
        console.log(`[${this.config.name}] TVDevice initialized`);
    }

    /**
     * Handle incoming MQTT messages
     */
    handleMqttMessage(topic: string, payload: Buffer): void {
        const message = payload.toString();

        if (topic === this.config.topics.getOnline) {
            this.handleAvailability(message);
        } else if (topic === this.config.topics.getState) {
            this.handleStateUpdate(message);
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
     * Parse JSON STATE message and extract POWER field
     * Example: {"Time":"2025-12-24T17:42:22","Uptime":"0T00:00:00","POWER":"ON","INPUT":"HDMI3"}
     */
    protected handleStateUpdate(message: string): void {
        try {
            const state = JSON.parse(message);

            // Extract POWER field
            if (state.POWER !== undefined) {
                const isOn = state.POWER === this.config.options.onValue;
                console.log(`[${this.config.name}] MQTT power state from JSON: ${isOn ? "ON" : "OFF"}`);

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

            // Future: Extract INPUT field for media input cluster
            // if (state.INPUT !== undefined) {
            //     this.handleInputUpdate(state.INPUT);
            // }

        } catch (error) {
            console.error(`[${this.config.name}] Failed to parse STATE JSON: ${message}`, error);
        }
    }

    /**
     * Setup Matter event handlers
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint.events as any;

        // On/Off events (TV power control)
        if (events.onOff?.onOff$Changed) {
            events.onOff.onOff$Changed.on((value: boolean) => {
                this.handleMatterPowerChange(value);
            });
        }

        // Future: MediaInput events for input selection
        // if (events.mediaInput?.currentInput$Changed) {
        //     events.mediaInput.currentInput$Changed.on((value: number) => {
        //         this.handleMatterInputChange(value);
        //     });
        // }
    }

    /**
     * Handle Matter power state change (from Google Home, etc.)
     */
    protected handleMatterPowerChange(value: boolean): void {
        const mqttPayload = value ? this.config.options.onValue : this.config.options.offValue;
        console.log(`[${this.config.name}] Matter power state changed to: ${value ? "ON" : "OFF"}`);

        this.mqttClient
            .publish(this.config.topics.setPower, mqttPayload)
            .catch((error) => console.error(`[${this.config.name}] Failed to publish power:`, error));
    }

    // Future method for input selection when MediaInput cluster is available
    // protected handleMatterInputChange(inputIndex: number): void {
    //     const inputName = this.config.options.supportedInputs?.[inputIndex];
    //     if (inputName && this.config.topics.setInput) {
    //         console.log(`[${this.config.name}] Matter input changed to index ${inputIndex}: ${inputName}`);
    //         this.mqttClient
    //             .publish(this.config.topics.setInput, inputName)
    //             .catch((error) => console.error(`[${this.config.name}] Failed to publish input:`, error));
    //     }
    // }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "TVDevice",

        capabilities: new Set(["availability", "onoff"]),
        // Future: new Set(["availability", "onoff", "mediainput"])

        topicSchema: {
            required: ["getOnline", "getState", "setPower"],
            optional: [], // Future: ["getInput", "setInput"]
        },

        optionSchema: {
            onValue: {
                type: "string",
                default: "ON",
                description: "Value representing 'on' power state",
            },
            offValue: {
                type: "string",
                default: "OFF",
                description: "Value representing 'off' power state",
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
            // Future option when MediaInput support is added:
            // supportedInputs: {
            //     type: "array",
            //     default: [],
            //     description: "List of supported input names (e.g., ['HDMI1', 'HDMI2', 'HDMI3'])",
            // },
        },

        validateConfig(config: any): ValidationResult {
            const errors: string[] = [];

            if (!config.name) {
                errors.push("Missing device name");
            }

            if (config.type !== "TVDevice") {
                errors.push(`Invalid type for TVDevice: ${config.type}`);
            }

            // Validate topics
            errors.push(...validateTopics(config, this.topicSchema, config.name || "unknown"));

            // Apply option defaults
            config.options = applyOptionDefaults(config, this.optionSchema);

            return createValidationResult(errors);
        },

        createEndpointConfig(config: TVDeviceConfig): EndpointConfiguration {
            return {
                state: {
                    bridgedDeviceBasicInformation: {
                        nodeLabel: config.name,
                        productName: `${config.name} (TV)`,  // Hint it's a TV in the product name
                        productLabel: config.name,
                        serialNumber: `ih8-tv-${config.name.toLowerCase().replace(/\s+/g, "-")}`,
                        reachable: false,
                    },
                    onOff: {
                        onOff: false,  // Start with TV off
                    },
                    // Future: mediaInput cluster initialization when BasicVideoPlayerDevice is available
                    // mediaInput: {
                    //     inputList: config.options.supportedInputs?.map((name, index) => ({
                    //         index,
                    //         inputType: 3, // HDMI
                    //         name,
                    //         description: name,
                    //     })) || [],
                    //     currentInput: 0,
                    // },
                },
                topics: [config.topics.getOnline, config.topics.getState],
            };
        },

        getMatterDeviceType() {
            // Currently using OnOffPlugInUnitDevice as a temporary solution
            // Future: Replace with BasicVideoPlayerDevice when available in matter.js
            return () => OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer);

            // Future implementation when BasicVideoPlayerDevice is exported:
            // return () => BasicVideoPlayerDevice.with(
            //     BridgedDeviceBasicInformationServer,
            //     MediaInputServer,
            //     // Additional TV-specific servers as needed
            // );
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];

            // Future: Add MediaInputServer and other TV-specific behaviors
            // return [
            //     BridgedDeviceBasicInformationServer,
            //     MediaInputServer,
            // ];
        },
    };
}
