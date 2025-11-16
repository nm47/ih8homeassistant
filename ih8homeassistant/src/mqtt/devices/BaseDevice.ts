/**
 * Base class for all MQTT-Matter bridged devices
 * Handles common functionality: availability, on/off state
 */

import type { Endpoint } from "@matter/main";
import type { DeviceConfig } from "../../types/config.js";
import type { MqttClient } from "../MqttClient.js";

export abstract class BaseDevice {
    constructor(
        protected readonly config: DeviceConfig,
        protected readonly endpoint: Endpoint,
        protected readonly mqttClient: MqttClient
    ) {}

    /**
     * Initialize the device: subscribe to MQTT topics and set up Matter event handlers
     */
    async initialize(): Promise<void> {
        await this.subscribeToTopics();
        this.setupMatterEventHandlers();
        console.log(`[${this.config.name}] ${this.constructor.name} initialized`);
    }

    /**
     * Subscribe to MQTT topics - override in subclasses to add more topics
     */
    protected async subscribeToTopics(): Promise<void> {
        const topics: string[] = [
            this.config.topics.getOnline,
            this.config.topics.getOn,
        ];

        const additionalTopics = this.getAdditionalTopics();
        if (additionalTopics.length > 0) {
            topics.push(...additionalTopics);
        }

        await this.mqttClient.subscribe(topics);
    }

    /**
     * Get additional topics to subscribe to (override in subclasses)
     */
    protected getAdditionalTopics(): string[] {
        return [];
    }

    /**
     * Handle incoming MQTT message for this device
     */
    handleMqttMessage(topic: string, payload: Buffer): void {
        const message = payload.toString();

        // Handle availability updates
        if (topic === this.config.topics.getOnline) {
            this.handleAvailability(message);
            return;
        }

        // Handle on/off state updates
        if (topic === this.config.topics.getOn) {
            this.handleOnOffState(message);
            return;
        }

        // Delegate to subclass for additional topics
        this.handleAdditionalMqttMessage(topic, message);
    }

    /**
     * Handle additional MQTT messages (override in subclasses)
     */
    protected handleAdditionalMqttMessage(_topic: string, _message: string): void {
        // Default: do nothing
    }

    /**
     * Handle device availability updates
     */
    protected handleAvailability(message: string): void {
        const isOnline = message === this.config.options.onlineValue;
        console.log(`[${this.config.name}] Availability: ${isOnline ? "online" : "offline"}`);

        // Update reachable status in Matter
        this.endpoint.set({
            bridgedDeviceBasicInformation: {
                reachable: isOnline,
            },
        } as any).catch(error => {
            console.error(`[${this.config.name}] Failed to update reachable status:`, error);
        });
    }

    /**
     * Handle on/off state updates from MQTT
     */
    protected handleOnOffState(message: string): void {
        const isOn = message === this.config.options.onValue;
        console.log(`[${this.config.name}] MQTT state: ${isOn ? "ON" : "OFF"}`);

        // Update Matter attribute
        this.endpoint.set({
            onOff: {
                onOff: isOn,
            },
        } as any).catch(error => {
            console.error(`[${this.config.name}] Failed to update on/off state:`, error);
        });
    }

    /**
     * Set up Matter event handlers - override in subclasses to add more handlers
     */
    protected setupMatterEventHandlers(): void {
        // On/Off events (all devices support this)
        const events = this.endpoint.events as any;
        if (events.onOff?.onOff$Changed) {
            events.onOff.onOff$Changed.on((value: boolean) => {
                this.handleMatterOnOffChange(value);
            });
        }

        // Setup additional handlers in subclasses
        this.setupAdditionalMatterEventHandlers();
    }

    /**
     * Setup additional Matter event handlers (override in subclasses)
     */
    protected setupAdditionalMatterEventHandlers(): void {
        // Default: do nothing
    }

    /**
     * Handle Matter on/off state change
     */
    protected handleMatterOnOffChange(value: boolean): void {
        const mqttPayload = value ? this.config.options.onValue : this.config.options.offValue;
        console.log(`[${this.config.name}] Matter state changed to: ${value ? "ON" : "OFF"}`);
        this.mqttClient
            .publish(this.config.topics.setOn, mqttPayload)
            .catch(error => console.error(`[${this.config.name}] Failed to publish on/off:`, error));
    }
}
