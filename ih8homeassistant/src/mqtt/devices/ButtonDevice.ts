/**
 * Button devices: a control you press in a Matter controller to fire an MQTT command
 *
 * Matter has no "stateless button a controller can press" — the Switch cluster reports
 * physical input events and exposes no commands, so a controller can never trigger it. The
 * button is therefore modelled as an On/Off endpoint treated as a pulse: switching it on
 * publishes the command, then the endpoint reverts to off so it can be pressed again.
 *
 * The registered config type string is still "GenericSwitchDevice" for compatibility with
 * existing config.toml files, even though the endpoint is no longer a Matter Generic Switch.
 */

import type { Endpoint } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
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

/** How long the endpoint stays "on" after a press before reverting. */
const PULSE_REVERT_MS = 1000;

/**
 * Configuration for Button devices
 */
export interface ButtonDeviceConfig {
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
 * Button device implementation
 */
export class ButtonDevice implements BaseDeviceInterface {
    private revertTimeout: NodeJS.Timeout | null = null;

    constructor(
        public readonly config: ButtonDeviceConfig,
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
        console.log(`[${this.config.name}] ButtonDevice initialized`);
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
     * Release the pending revert timer
     */
    close(): void {
        if (this.revertTimeout) {
            clearTimeout(this.revertTimeout);
            this.revertTimeout = null;
        }
    }

    /**
     * Setup Matter event handlers
     *
     * Controller-originated only, which is also what keeps the revert below from being read
     * back as a second press.
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint.events as any;

        onControllerChange<boolean>(events.onOff?.onOff$Changed, value => {
            if (value) {
                this.handleMatterButtonPress();
            }
        });
    }

    /**
     * Handle a press: publish the configured command, then revert so it can be pressed again
     */
    protected handleMatterButtonPress(): void {
        console.log(`[${this.config.name}] Button pressed`);

        const payload = this.config.options.commandValue;
        this.mqttClient
            .publish(this.config.topics.setCommand, payload)
            .catch((error) => console.error(`[${this.config.name}] Failed to publish command:`, error));

        if (this.revertTimeout) {
            clearTimeout(this.revertTimeout);
        }

        this.revertTimeout = setTimeout(() => {
            this.revertTimeout = null;
            // Offline write, so this does not register as another press
            this.endpoint
                .set({
                    onOff: {
                        onOff: false,
                    },
                } as any)
                .catch((error) => {
                    console.error(`[${this.config.name}] Failed to reset button state:`, error);
                });
        }, PULSE_REVERT_MS);
    }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "ButtonDevice",

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
                description: "Value to publish when the button is pressed (may be empty)",
            },
        },

        validateConfig(config: any): ValidationResult {
            const errors: string[] = [];

            if (config.type !== "GenericSwitchDevice") {
                errors.push(`Invalid type for ButtonDevice: ${config.type}`);
            }

            // commandValue is deliberately not validated as a token pair: an empty MQTT
            // payload is a legitimate trigger.
            errors.push(
                ...validateDeviceConfig(config, this.topicSchema, this.optionSchema, [
                    ["onlineValue", "offlineValue"],
                ]).errors
            );

            return createValidationResult(errors);
        },

        createEndpointConfig(config: ButtonDeviceConfig): EndpointConfiguration {
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
                        onOff: false,
                    },
                },
                topics: [config.topics.getOnline],
            };
        },

        getMatterDeviceType() {
            return () => OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer);
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];
        },
    };
}
