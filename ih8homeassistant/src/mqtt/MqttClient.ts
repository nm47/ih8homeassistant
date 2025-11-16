/**
 * MQTT Client wrapper for connecting to broker and managing subscriptions
 */

import mqtt, { type MqttClient as MqttClientType, type IClientOptions } from "mqtt";
import type { BrokerConfig } from "../types/config.js";
import { DEFAULT_MQTT_SETTINGS } from "../types/config.js";

export interface MqttMessageHandler {
    (topic: string, payload: Buffer): void;
}

export class MqttClient {
    private client: MqttClientType | null = null;
    private messageHandlers: Set<MqttMessageHandler> = new Set();
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts: number;
    private readonly baseReconnectDelay: number;
    private readonly maxReconnectDelay: number;
    private readonly connectTimeout: number;
    private readonly qos: 0 | 1 | 2;

    constructor(private readonly config: BrokerConfig) {
        // Use config values or fall back to defaults
        this.maxReconnectAttempts = config.maxReconnectAttempts ?? DEFAULT_MQTT_SETTINGS.maxReconnectAttempts;
        this.baseReconnectDelay = config.baseReconnectDelay ?? DEFAULT_MQTT_SETTINGS.baseReconnectDelay;
        this.maxReconnectDelay = config.maxReconnectDelay ?? DEFAULT_MQTT_SETTINGS.maxReconnectDelay;
        this.connectTimeout = config.connectTimeout ?? DEFAULT_MQTT_SETTINGS.connectTimeout;
        this.qos = config.qos ?? DEFAULT_MQTT_SETTINGS.qos;
    }

    /**
     * Connect to the MQTT broker with automatic reconnection
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const brokerUrl = `mqtt://${this.config.host}:${this.config.port}`;
            console.log(`Connecting to MQTT broker: ${brokerUrl}`);

            const options: IClientOptions = {
                clientId: `ih8homeassistant-${Math.random().toString(16).slice(2, 8)}`,
                clean: true,
                connectTimeout: this.connectTimeout,
                reconnectPeriod: 0, // We handle reconnection manually for better control
            };

            // Add authentication if provided
            if (this.config.user) {
                options.username = this.config.user;
            }
            if (this.config.pass) {
                options.password = this.config.pass;
            }

            this.client = mqtt.connect(brokerUrl, options);

            // Connection successful
            this.client.on("connect", () => {
                console.log("MQTT broker connected successfully");
                this.reconnectAttempts = 0; // Reset on successful connection
                resolve();
            });

            // Connection error
            this.client.on("error", (error) => {
                console.error("MQTT connection error:", error.message);
                if (!this.client || this.client.connected === false) {
                    reject(error);
                }
            });

            // Disconnected - attempt reconnection with exponential backoff
            this.client.on("close", () => {
                console.log("MQTT connection closed");
                this.scheduleReconnect();
            });

            // Offline event
            this.client.on("offline", () => {
                console.log("MQTT client offline");
            });

            // Message received
            this.client.on("message", (topic, payload) => {
                this.handleMessage(topic, payload);
            });

            // Reconnect event
            this.client.on("reconnect", () => {
                console.log("Attempting to reconnect to MQTT broker...");
            });
        });
    }

    /**
     * Schedule reconnection with exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            this.maxReconnectDelay
        );

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            if (this.client) {
                this.client.reconnect();
            }
        }, delay);
    }

    /**
     * Subscribe to a topic or array of topics
     */
    async subscribe(topics: string | string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.client.connected) {
                reject(new Error("MQTT client not connected"));
                return;
            }

            const topicArray = Array.isArray(topics) ? topics : [topics];
            console.log(`Subscribing to ${topicArray.length} topic(s): ${topicArray.join(", ")}`);

            this.client.subscribe(topicArray, (error) => {
                if (error) {
                    console.error("Failed to subscribe to topics:", error.message);
                    reject(error);
                } else {
                    console.log(`Successfully subscribed to ${topicArray.length} topic(s)`);
                    resolve();
                }
            });
        });
    }

    /**
     * Publish a message to a topic
     */
    async publish(topic: string, payload: string | Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.client.connected) {
                reject(new Error("MQTT client not connected"));
                return;
            }

            this.client.publish(topic, payload, { qos: this.qos, retain: false }, (error) => {
                if (error) {
                    console.error(`Failed to publish to ${topic}:`, error.message);
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Register a message handler
     */
    onMessage(handler: MqttMessageHandler): void {
        this.messageHandlers.add(handler);
    }

    /**
     * Remove a message handler
     */
    offMessage(handler: MqttMessageHandler): void {
        this.messageHandlers.delete(handler);
    }

    /**
     * Handle incoming messages and dispatch to registered handlers
     */
    private handleMessage(topic: string, payload: Buffer): void {
        for (const handler of this.messageHandlers) {
            try {
                handler(topic, payload);
            } catch (error) {
                console.error(`Error in message handler for topic ${topic}:`, error);
            }
        }
    }

    /**
     * Disconnect from the broker
     */
    async disconnect(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.client) {
                resolve();
                return;
            }

            this.client.end(false, {}, () => {
                console.log("MQTT client disconnected");
                this.client = null;
                resolve();
            });
        });
    }

    /**
     * Check if the client is connected
     */
    isConnected(): boolean {
        return this.client !== null && this.client.connected;
    }
}
