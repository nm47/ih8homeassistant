/**
 * TV devices with on/off control
 * Currently uses OnOffPlugInUnitDevice pending BasicVideoPlayerDevice support in matter.js
 * Future: Will migrate to BasicVideoPlayerDevice when available
 *
 * Parses JSON STATE messages for the POWER and INPUT fields. Over HDMI-CEC the TV cannot be
 * queried, so STATE is an echo of the last command sent, and the state source says so.
 */

import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
// Future import when BasicVideoPlayerDevice is available in matter.js:
// import { BasicVideoPlayerDevice } from "@matter/main/devices/basic-video-player";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
// Future import for MediaInput support:
// import { MediaInputServer } from "@matter/main/behaviors/media-input";
import type {
    DeviceCapability,
    DeviceMetadata,
    DeviceState,
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
import { onControllerChange } from "./matterEvents.js";

/**
 * Configuration for TV devices
 */
export interface TVDeviceConfig {
    type: "TVDevice";
    name: string;
    topics: {
        getOnline: string;      // e.g., "tele/tv/LWT"
        getState: string;        // e.g., "tele/tv/STATE" (JSON with POWER and INPUT fields)
        setPower: string;        // e.g., "cmnd/tv/POWER"
        setInput?: string;       // e.g., "cmnd/tv/INPUT"
    };
    options: {
        onValue: string;         // "ON"
        offValue: string;        // "OFF"
        onlineValue: string;     // "Online"
        offlineValue: string;    // "Offline"
        inputs: string[];        // ["HDMI1", "HDMI2", "HDMI3", "HDMI4"]
    };
}

/**
 * TV device implementation
 */
export class TVDevice extends BridgedDevice<TVDeviceConfig> {
    protected metadata(): DeviceMetadata {
        return TVDevice.metadata;
    }

    protected override unknownState(): DeviceState {
        return { online: null, on: null, input: null, source: "last sent", reportedAt: null };
    }

    /**
     * Input selection only counts once there is a topic to send it on
     */
    override get capabilities(): ReadonlySet<DeviceCapability> {
        const capabilities = new Set(TVDevice.metadata.capabilities);
        if (this.config.topics.setInput) {
            capabilities.add("input");
        }
        return capabilities;
    }

    /**
     * Inputs the TV accepts, when input selection is configured
     */
    get inputs(): readonly string[] | undefined {
        return this.config.topics.setInput ? this.config.options.inputs : undefined;
    }

    /**
     * Initialize device: subscribe to topics and setup handlers
     */
    async initialize(): Promise<void> {
        const topics = [this.config.topics.getOnline, this.config.topics.getState];
        await this.mqttClient.subscribe(topics);
        if (this.endpoint) {
            this.setupMatterEventHandlers();
        }
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
     * Parse JSON STATE message and extract the POWER and INPUT fields
     * Example: {"Time":"2025-12-24T17:42:22","Uptime":"0T00:00:00","POWER":"ON","INPUT":"HDMI3"}
     */
    protected handleStateUpdate(message: string): void {
        const state = parseJsonObject(message);
        if (state === null) {
            console.error(`[${this.config.name}] Failed to parse STATE JSON: ${message}`);
            return;
        }

        const changes: Partial<DeviceState> = {};

        if (state.POWER !== undefined) {
            const isOn = matchToken(
                String(state.POWER),
                this.config.options.onValue,
                this.config.options.offValue
            );

            if (isOn === null) {
                console.warn(`[${this.config.name}] Ignoring unrecognized POWER value: ${state.POWER}`);
            } else {
                console.log(`[${this.config.name}] MQTT power state from JSON: ${isOn ? "ON" : "OFF"}`);
                changes.on = isOn;
                this.updateEndpoint({ onOff: { onOff: isOn } }, "on/off state");
            }
        }

        if (typeof state.INPUT === "string") {
            changes.input = state.INPUT;
        }

        if (Object.keys(changes).length > 0) {
            this.report(changes);
        }
    }

    /**
     * Publish a power command
     */
    async setOn(on: boolean): Promise<void> {
        const payload = on ? this.config.options.onValue : this.config.options.offValue;
        await this.mqttClient.publish(this.config.topics.setPower, payload);
    }

    /**
     * Publish an input selection
     *
     * Matching is case-insensitive, but the configured spelling is what gets sent.
     */
    async setInput(input: string): Promise<void> {
        const topic = this.config.topics.setInput;
        if (!topic) {
            throw new Error(`${this.config.name} has no input topic configured`);
        }

        const match = this.config.options.inputs.find(
            candidate => candidate.toLowerCase() === input.trim().toLowerCase()
        );
        if (match === undefined) {
            throw new Error(
                `Unknown input "${input}" for ${this.config.name}. Valid inputs: ${this.config.options.inputs.join(", ")}`
            );
        }

        await this.mqttClient.publish(topic, match);
    }

    /**
     * Setup Matter event handlers
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint!.events as any;

        // On/Off events (TV power control). Controller-originated only, so the state we just
        // applied from the STATE topic is not echoed back as a power command.
        onControllerChange<boolean>(events.onOff?.onOff$Changed, value =>
            this.handleMatterPowerChange(value)
        );

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
        console.log(`[${this.config.name}] Matter power state changed to: ${value ? "ON" : "OFF"}`);
        this.setOn(value).catch((error) =>
            console.error(`[${this.config.name}] Failed to publish power:`, error)
        );
    }

    // Future method for input selection when MediaInput cluster is available
    // protected handleMatterInputChange(inputIndex: number): void {
    //     const inputName = this.config.options.inputs[inputIndex];
    //     if (inputName) {
    //         this.setInput(inputName).catch(...);
    //     }
    // }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "TVDevice",

        // "input" is added per device when a setInput topic is configured
        capabilities: new Set(["availability", "onoff"]),

        topicSchema: {
            required: ["getOnline", "getState", "setPower"],
            optional: ["setInput"],
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
            inputs: {
                type: "string[]",
                default: [],
                description: "Input names the TV accepts on setInput (e.g., ['HDMI1', 'HDMI2'])",
            },
        },

        validateConfig(config: any): ValidationResult {
            const errors: string[] = [];

            if (config.type !== "TVDevice") {
                errors.push(`Invalid type for TVDevice: ${config.type}`);
            }

            const result = validateDeviceConfig(config, this.topicSchema, this.optionSchema, [
                ["onValue", "offValue"],
                ["onlineValue", "offlineValue"],
            ]);
            errors.push(...result.errors);

            if (result.valid && config.topics.setInput !== undefined && config.options.inputs.length === 0) {
                errors.push(`[${config.name}] Option inputs must list the inputs setInput accepts`);
            }

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
                },
                topics: [config.topics.getOnline, config.topics.getState],
            };
        },

        getMatterDeviceType() {
            // Currently using OnOffPlugInUnitDevice as a temporary solution
            // Future: Replace with BasicVideoPlayerDevice when available in matter.js
            return () => OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer);
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];
        },
    };
}
