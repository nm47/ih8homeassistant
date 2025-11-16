/**
 * Color devices: RGB lights with full color control
 * Supports: ExtendedColorLightDevice
 */

import { DimmableDevice } from "./DimmableDevice.js";
import type { ExtendedColorDeviceConfig } from "../../types/config.js";
import { hexToHsv, hsvToHex } from "../../utils/ColorConverter.js";

export class ColorDevice extends DimmableDevice {
    private currentHue = 0;
    private currentSaturation = 0;
    private publishRgbTimeout: NodeJS.Timeout | null = null;

    protected get colorConfig(): ExtendedColorDeviceConfig {
        return this.config as ExtendedColorDeviceConfig;
    }

    protected override getAdditionalTopics(): string[] {
        return [
            ...super.getAdditionalTopics(),
            this.colorConfig.topics.getRGB,
        ];
    }

    protected override handleAdditionalMqttMessage(topic: string, message: string): void {
        if (topic === this.colorConfig.topics.getRGB) {
            this.handleRGBState(message);
        } else {
            super.handleAdditionalMqttMessage(topic, message);
        }
    }

    protected override handleBrightnessState(message: string): void {
        super.handleBrightnessState(message);
        // No need to track currentValue - we'll read it from state when needed
    }

    protected handleRGBState(message: string): void {
        console.log(`[${this.config.name}] MQTT RGB: ${message}`);

        // Parse RGB hex value
        const prefix = this.colorConfig.options.hex ? this.colorConfig.options.hexPrefix : undefined;
        const hsv = hexToHsv(message, prefix);

        if (!hsv) {
            console.error(`[${this.config.name}] Invalid RGB value: ${message}`);
            return;
        }

        // NOTE: currentHue and currentSaturation are read-only attributes in Matter.
        // They can only be changed via commands (MoveToHue, MoveToSaturation, etc.)
        // For bridged devices, color control is one-way: Matter -> MQTT only.
        // MQTT color updates are ignored to avoid conformance violations.

        console.log(`[${this.config.name}] MQTT color update ignored (Matter controls color for this device)`);

        // Track values for reference only
        this.currentHue = hsv.hue;
        this.currentSaturation = hsv.saturation;
    }

    protected override setupAdditionalMatterEventHandlers(): void {
        super.setupAdditionalMatterEventHandlers();

        const colorEndpoint = this.endpoint as any;

        console.log(`[${this.config.name}] Setting up color event handlers...`);

        // Log all available events on colorControl
        if (colorEndpoint.events?.colorControl) {
            const eventNames = Object.keys(colorEndpoint.events.colorControl);
            console.log(`[${this.config.name}] Available colorControl events:`, eventNames);
        }

        // Log general endpoint interaction events
        if (colorEndpoint.events?.interactionBegin) {
            colorEndpoint.events.interactionBegin.on((data: any) => {
                console.log(`[${this.config.name}] Interaction begin:`, data);
            });
        }

        if (colorEndpoint.events?.interactionEnd) {
            colorEndpoint.events.interactionEnd.on((data: any) => {
                console.log(`[${this.config.name}] Interaction end:`, data);
            });
        }

        // Try to listen to specific attribute changes
        if (colorEndpoint.events?.colorControl?.currentHue$Changed) {
            colorEndpoint.events.colorControl.currentHue$Changed.on((value: number) => {
                console.log(`[${this.config.name}] currentHue$Changed event: ${value}`);
                if (value !== this.currentHue) {
                    this.currentHue = value;
                    this.debouncedPublishRGB();
                }
            });
            console.log(`[${this.config.name}] currentHue$Changed handler registered`);
        }

        if (colorEndpoint.events?.colorControl?.currentSaturation$Changed) {
            colorEndpoint.events.colorControl.currentSaturation$Changed.on((value: number) => {
                console.log(`[${this.config.name}] currentSaturation$Changed event: ${value}`);
                if (value !== this.currentSaturation) {
                    this.currentSaturation = value;
                    this.debouncedPublishRGB();
                }
            });
            console.log(`[${this.config.name}] currentSaturation$Changed handler registered`);
        }

        // Use stateChanged event as fallback
        if (colorEndpoint.events?.colorControl?.stateChanged) {
            colorEndpoint.events.colorControl.stateChanged.on((state: any) => {
                console.log(`[${this.config.name}] ColorControl stateChanged:`, {
                    hue: state.currentHue,
                    saturation: state.currentSaturation,
                    colorMode: state.colorMode
                });

                // Only process if hue/saturation actually changed
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

    protected override handleMatterBrightnessChange(value: number): void {
        super.handleMatterBrightnessChange(value);
        // Brightness changed - also update RGB since it affects the final color
        this.debouncedPublishRGB();
    }

    /**
     * Debounced RGB publish to avoid multiple publishes when hue+saturation change together
     */
    private debouncedPublishRGB(): void {
        // Clear any pending publish
        if (this.publishRgbTimeout) {
            clearTimeout(this.publishRgbTimeout);
        }

        // Schedule new publish after a short delay
        this.publishRgbTimeout = setTimeout(() => {
            this.publishRGB();
            this.publishRgbTimeout = null;
        }, 50); // 50ms debounce
    }

    /**
     * Publish RGB color to MQTT, reading current brightness from Matter state
     */
    private publishRGB(): void {
        // Read current brightness/value from Matter state
        let currentValue = 254; // Default to max brightness
        try {
            const state = this.endpoint.state as any;
            if (state?.levelControl?.currentLevel !== undefined) {
                currentValue = state.levelControl.currentLevel;
            }
        } catch (error) {
            console.warn(`[${this.config.name}] Could not read current brightness, using default`);
        }

        const prefix = this.colorConfig.options.hex ? this.colorConfig.options.hexPrefix : undefined;
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
            .publish(this.colorConfig.topics.setRGB, rgbHex)
            .catch(error => console.error(`[${this.config.name}] Failed to publish RGB:`, error));
    }
}
