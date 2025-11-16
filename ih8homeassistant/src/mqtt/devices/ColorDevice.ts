/**
 * Color devices: RGB lights with full color control
 * Supports: ExtendedColorLightDevice
 */

import type { Endpoint } from "@matter/main";
import { ExtendedColorLightDevice } from "@matter/main/devices/extended-color-light";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ColorControlServer } from "@matter/main/behaviors/color-control";
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
import { hexToHsv, hsvToHex } from "../../utils/ColorConverter.js";

/**
 * Configuration for Color devices
 */
export interface ColorDeviceConfig {
    type: "ExtendedColorLightDevice";
    name: string;
    topics: {
        getOnline: string;
        getOn: string;
        setOn: string;
        getBrightness: string;
        setBrightness: string;
        getRGB: string;
        setRGB: string;
    };
    options: {
        onValue: string;
        offValue: string;
        onlineValue: string;
        offlineValue: string;
        hex: boolean;
        hexPrefix: string;
    };
}

/**
 * Color device implementation
 */
export class ColorDevice implements BaseDeviceInterface {
    private currentHue = 0;
    private currentSaturation = 0;
    private publishRgbTimeout: NodeJS.Timeout | null = null;

    constructor(
        public readonly config: ColorDeviceConfig,
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
            this.config.topics.getRGB,
        ];
        await this.mqttClient.subscribe(topics);
        this.setupMatterEventHandlers();
        console.log(`[${this.config.name}] ColorDevice initialized`);
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
        } else if (topic === this.config.topics.getRGB) {
            this.handleRGBState(message);
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
     * Handle RGB state updates from MQTT
     */
    protected handleRGBState(message: string): void {
        console.log(`[${this.config.name}] MQTT RGB: ${message}`);

        const prefix = this.config.options.hex ? this.config.options.hexPrefix : undefined;
        const hsv = hexToHsv(message, prefix);

        if (!hsv) {
            console.error(`[${this.config.name}] Invalid RGB value: ${message}`);
            return;
        }

        console.log(`[${this.config.name}] MQTT color update ignored (Matter controls color for this device)`);

        // Track values for reference only
        this.currentHue = hsv.hue;
        this.currentSaturation = hsv.saturation;
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

        // Color control events
        console.log(`[${this.config.name}] Setting up color event handlers...`);

        if (events.colorControl?.currentHue$Changed) {
            events.colorControl.currentHue$Changed.on((value: number) => {
                console.log(`[${this.config.name}] currentHue$Changed event: ${value}`);
                if (value !== this.currentHue) {
                    this.currentHue = value;
                    this.debouncedPublishRGB();
                }
            });
            console.log(`[${this.config.name}] currentHue$Changed handler registered`);
        }

        if (events.colorControl?.currentSaturation$Changed) {
            events.colorControl.currentSaturation$Changed.on((value: number) => {
                console.log(`[${this.config.name}] currentSaturation$Changed event: ${value}`);
                if (value !== this.currentSaturation) {
                    this.currentSaturation = value;
                    this.debouncedPublishRGB();
                }
            });
            console.log(`[${this.config.name}] currentSaturation$Changed handler registered`);
        }

        if (events.colorControl?.stateChanged) {
            events.colorControl.stateChanged.on((state: any) => {
                console.log(`[${this.config.name}] ColorControl stateChanged:`, {
                    hue: state.currentHue,
                    saturation: state.currentSaturation,
                    colorMode: state.colorMode,
                });

                if (state.currentHue !== undefined && state.currentHue !== this.currentHue) {
                    this.currentHue = state.currentHue;
                    this.debouncedPublishRGB();
                }

                if (state.currentSaturation !== undefined && state.currentSaturation !== this.currentSaturation) {
                    this.currentSaturation = state.currentSaturation;
                    this.debouncedPublishRGB();
                }
            });
            console.log(`[${this.config.name}] stateChanged handler registered`);
        }

        // Read initial color state
        try {
            const state = this.endpoint.state as any;
            if (state?.colorControl?.currentHue !== undefined) {
                this.currentHue = state.colorControl.currentHue;
                console.log(`[${this.config.name}] Initial hue: ${this.currentHue}`);
            }
            if (state?.colorControl?.currentSaturation !== undefined) {
                this.currentSaturation = state.colorControl.currentSaturation;
                console.log(`[${this.config.name}] Initial saturation: ${this.currentSaturation}`);
            }
        } catch (error) {
            console.warn(`[${this.config.name}] Could not read initial color state:`, error);
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

        // Brightness affects RGB, so update that too
        this.debouncedPublishRGB();
    }

    /**
     * Debounced RGB publish to avoid multiple publishes when hue+saturation change together
     */
    private debouncedPublishRGB(): void {
        if (this.publishRgbTimeout) {
            clearTimeout(this.publishRgbTimeout);
        }

        this.publishRgbTimeout = setTimeout(() => {
            this.publishRGB();
            this.publishRgbTimeout = null;
        }, 50);
    }

    /**
     * Publish RGB color to MQTT, reading current brightness from Matter state
     */
    private publishRGB(): void {
        let currentValue = 254;
        try {
            const state = this.endpoint.state as any;
            if (state?.levelControl?.currentLevel !== undefined) {
                currentValue = state.levelControl.currentLevel;
            }
        } catch (error) {
            console.warn(`[${this.config.name}] Could not read current brightness, using default`);
        }

        const prefix = this.config.options.hex ? this.config.options.hexPrefix : undefined;
        const rgbHex = hsvToHex(
            {
                hue: this.currentHue,
                saturation: this.currentSaturation,
                value: currentValue,
            },
            prefix
        );

        console.log(`[${this.config.name}] Publishing RGB: ${rgbHex} (H:${this.currentHue} S:${this.currentSaturation} V:${currentValue})`);
        this.mqttClient
            .publish(this.config.topics.setRGB, rgbHex)
            .catch((error) => console.error(`[${this.config.name}] Failed to publish RGB:`, error));
    }

    /**
     * Device metadata
     */
    static metadata: DeviceMetadata = {
        typeName: "ColorDevice",

        capabilities: new Set(["availability", "onoff", "dimming", "color"]),

        topicSchema: {
            required: ["getOnline", "getOn", "setOn", "getBrightness", "setBrightness", "getRGB", "setRGB"],
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
            hex: {
                type: "boolean",
                default: false,
                description: "Whether RGB values use hex format",
            },
            hexPrefix: {
                type: "string",
                default: "#",
                description: "Hex prefix if hex is true",
            },
        },

        validateConfig(config: any): ValidationResult {
            const errors: string[] = [];

            if (!config.name) {
                errors.push("Missing device name");
            }

            if (config.type !== "ExtendedColorLightDevice") {
                errors.push(`Invalid type for ColorDevice: ${config.type}`);
            }

            // Validate topics
            errors.push(...validateTopics(config, this.topicSchema, config.name || "unknown"));

            // Apply option defaults
            config.options = applyOptionDefaults(config, this.optionSchema);

            return createValidationResult(errors);
        },

        createEndpointConfig(config: ColorDeviceConfig): EndpointConfiguration {
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
                    colorControl: {
                        colorMode: 0,
                        enhancedColorMode: 0,
                        currentHue: 0,
                        currentSaturation: 254,
                        colorTempPhysicalMinMireds: 147,
                        colorTempPhysicalMaxMireds: 500,
                        coupleColorTempToLevelMinMireds: 147,
                        remainingTime: 0,
                        options: { executeIfOff: true },
                        numberOfPrimaries: 0,
                    },
                },
                topics: [
                    config.topics.getOnline,
                    config.topics.getOn,
                    config.topics.getBrightness,
                    config.topics.getRGB,
                ],
            };
        },

        getMatterDeviceType() {
            return () =>
                ExtendedColorLightDevice.with(
                    BridgedDeviceBasicInformationServer,
                    ColorControlServer.with("HueSaturation", "Xy", "ColorTemperature")
                );
        },

        getMatterBehaviors() {
            return [
                BridgedDeviceBasicInformationServer,
                ColorControlServer.with("HueSaturation", "Xy", "ColorTemperature"),
            ];
        },
    };
}
