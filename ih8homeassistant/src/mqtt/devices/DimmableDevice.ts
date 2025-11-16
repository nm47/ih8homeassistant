/**
 * Dimmable devices: lights with brightness control
 * Supports: DimmableLightDevice
 */

import { BaseDevice } from "./BaseDevice.js";
import type { DimmableDeviceConfig } from "../../types/config.js";
import { mqttToMatterBrightness, matterToMqttBrightness, parseBrightness } from "../../utils/BrightnessConverter.js";

export class DimmableDevice extends BaseDevice {
    protected get dimmableConfig(): DimmableDeviceConfig {
        return this.config as DimmableDeviceConfig;
    }

    protected override getAdditionalTopics(): string[] {
        return [
            this.dimmableConfig.topics.getBrightness,
        ];
    }

    protected override handleAdditionalMqttMessage(topic: string, message: string): void {
        if (topic === this.dimmableConfig.topics.getBrightness) {
            this.handleBrightnessState(message);
        }
    }

    protected handleBrightnessState(message: string): void {
        const brightness = parseBrightness(message);
        if (brightness === null) {
            console.error(`[${this.config.name}] Invalid brightness value: ${message}`);
            return;
        }

        console.log(`[${this.config.name}] MQTT brightness: ${brightness}`);

        // Convert and update Matter attribute
        const matterLevel = mqttToMatterBrightness(brightness);
        this.endpoint.set({
            levelControl: {
                currentLevel: matterLevel,
            },
        } as any).catch(error => {
            console.error(`[${this.config.name}] Failed to update brightness:`, error);
        });
    }

    protected override setupAdditionalMatterEventHandlers(): void {
        const levelEndpoint = this.endpoint as any;
        if (levelEndpoint.events.levelControl?.currentLevel$Changed) {
            levelEndpoint.events.levelControl.currentLevel$Changed.on((value: number) => {
                this.handleMatterBrightnessChange(value);
            });
        }
    }

    protected handleMatterBrightnessChange(value: number): void {
        console.log(`[${this.config.name}] Matter brightness changed to: ${value}`);
        const mqttBrightness = matterToMqttBrightness(value);
        this.mqttClient
            .publish(this.dimmableConfig.topics.setBrightness, mqttBrightness.toString())
            .catch(error => console.error(`[${this.config.name}] Failed to publish brightness:`, error));
    }
}
