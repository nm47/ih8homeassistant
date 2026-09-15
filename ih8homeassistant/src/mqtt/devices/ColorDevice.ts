/**
 * Color devices: RGB lights with full color control
 * Supports: ExtendedColorLightDevice
 */

import type { Endpoint } from "@matter/main";
import { ExtendedColorLightDevice } from "@matter/main/devices/extended-color-light";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ColorControlServer } from "@matter/main/behaviors/color-control";
import { ColorControl } from "@matter/main/clusters/color-control";
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
import { hexToHsv, hsvToHex, xyToHex, miredsToHex } from "../../utils/ColorConverter.js";

/** Collapse a burst of colour attribute changes into a single MQTT publish. */
const PUBLISH_DEBOUNCE_MS = 50;

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
     * Release the pending publish timer
     */
    close(): void {
        if (this.publishRgbTimeout) {
            clearTimeout(this.publishRgbTimeout);
            this.publishRgbTimeout = null;
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
     *
     * Only hue and saturation are applied. The value component of the incoming hex is
     * deliberately discarded because getBrightness is the authoritative brightness source and
     * applying both would make the two topics fight. Note the resulting asymmetry: outgoing
     * RGB bakes the current level into V, incoming V is ignored.
     *
     * This is an offline write, so the change handlers below do not republish it.
     */
    protected handleRGBState(message: string): void {
        console.log(`[${this.config.name}] MQTT RGB: ${message}`);

        const prefix = this.config.options.hex ? this.config.options.hexPrefix : undefined;
        const hsv = hexToHsv(message, prefix);

        if (!hsv) {
            console.error(`[${this.config.name}] Invalid RGB value: ${message}`);
            return;
        }

        this.endpoint
            .set({
                colorControl: {
                    colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
                    enhancedColorMode: ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation,
                    currentHue: hsv.hue,
                    currentSaturation: hsv.saturation,
                },
            } as any)
            .catch((error) => {
                console.error(`[${this.config.name}] Failed to update color:`, error);
            });
    }

    /**
     * Setup Matter event handlers
     *
     * Every colour attribute funnels into one debounced publisher that reads the cluster
     * state at publish time, so whichever mode the controller picked is handled by the same
     * path. All handlers are controller-originated only.
     */
    protected setupMatterEventHandlers(): void {
        const events = this.endpoint.events as any;

        onControllerChange<boolean>(events.onOff?.onOff$Changed, value =>
            this.handleMatterOnOffChange(value)
        );

        onControllerChange<number>(events.levelControl?.currentLevel$Changed, value =>
            this.handleMatterBrightnessChange(value)
        );

        const colorAttributes = [
            "currentHue$Changed",
            "currentSaturation$Changed",
            "currentX$Changed",
            "currentY$Changed",
            "colorTemperatureMireds$Changed",
            "colorMode$Changed",
        ];

        for (const attribute of colorAttributes) {
            onControllerChange<number>(events.colorControl?.[attribute], () =>
                this.debouncedPublishRGB()
            );
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

        // Brightness is baked into the published RGB value, so republish that too
        this.debouncedPublishRGB();
    }

    /**
     * Debounced RGB publish to avoid multiple publishes when several attributes change together
     */
    private debouncedPublishRGB(): void {
        if (this.publishRgbTimeout) {
            clearTimeout(this.publishRgbTimeout);
        }

        this.publishRgbTimeout = setTimeout(() => {
            this.publishRgbTimeout = null;
            this.publishRGB();
        }, PUBLISH_DEBOUNCE_MS);
    }

    /**
     * Publish the current colour to MQTT, converting from whichever mode the controller set
     *
     * ExtendedColorLightDevice mandates the Xy and ColorTemperature features, so all three
     * modes have to be handled; a controller using XY or colour temperature would otherwise
     * change Matter state without producing any MQTT command.
     */
    private publishRGB(): void {
        let colorControl: any;
        let level = 254;

        try {
            const state = this.endpoint.state as any;
            colorControl = state?.colorControl;
            if (typeof state?.levelControl?.currentLevel === "number") {
                level = state.levelControl.currentLevel;
            }
        } catch (error) {
            console.warn(`[${this.config.name}] Could not read color state:`, error);
            return;
        }

        if (!colorControl) {
            console.warn(`[${this.config.name}] No color state available, skipping publish`);
            return;
        }

        const prefix = this.config.options.hex ? this.config.options.hexPrefix : undefined;
        const mode = colorControl.colorMode;
        let rgbHex: string | null = null;
        let description = "";

        if (mode === ColorControl.ColorMode.CurrentXAndCurrentY) {
            const { currentX, currentY } = colorControl;
            if (typeof currentX === "number" && typeof currentY === "number") {
                rgbHex = xyToHex(currentX, currentY, level, prefix);
                description = `X:${currentX} Y:${currentY} L:${level}`;
            }
        } else if (mode === ColorControl.ColorMode.ColorTemperatureMireds) {
            const mireds = colorControl.colorTemperatureMireds;
            if (typeof mireds === "number") {
                rgbHex = miredsToHex(mireds, level, prefix);
                description = `mireds:${mireds} L:${level}`;
            }
        } else {
            const { currentHue, currentSaturation } = colorControl;
            if (typeof currentHue === "number" && typeof currentSaturation === "number") {
                rgbHex = hsvToHex(
                    { hue: currentHue, saturation: currentSaturation, value: level },
                    prefix
                );
                description = `H:${currentHue} S:${currentSaturation} V:${level}`;
            }
        }

        // A mode can be selected before its attributes are written; publishing NaN would be
        // worse than publishing nothing.
        if (rgbHex === null) {
            console.warn(`[${this.config.name}] Color mode ${mode} has no usable values yet, skipping publish`);
            return;
        }

        console.log(`[${this.config.name}] Publishing RGB: ${rgbHex} (mode ${mode}, ${description})`);
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

            if (config.type !== "ExtendedColorLightDevice") {
                errors.push(`Invalid type for ColorDevice: ${config.type}`);
            }

            errors.push(
                ...validateDeviceConfig(config, this.topicSchema, this.optionSchema, [
                    ["onValue", "offValue"],
                    ["onlineValue", "offlineValue"],
                ]).errors
            );

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
                        reachable: false,
                    },
                    onOff: {
                        onOff: true,
                    },
                    levelControl: {
                        currentLevel: 254,
                    },
                    colorControl: {
                        colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
                        enhancedColorMode: ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation,
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
