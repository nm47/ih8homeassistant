/**
 * MQTT Client wrapper for connecting to broker and managing subscriptions
 */

import mqtt, { type MqttClient as MqttClientType, type IClientOptions } from "mqtt";
import type { BrokerConfig } from "../types/config.js";
import { DEFAULT_MQTT_SETTINGS } from "../types/config.js";

export interface MqttMessageHandler {
    (topic: string, payload: Buffer): void;
}

export interface MqttConnectionHandler {
    (connected: boolean): void;
}

export class MqttClient {
    private client: MqttClientType | null = null;
    private messageHandlers: Set<MqttMessageHandler> = new Set();
    private connectionHandlers: Set<MqttConnectionHandler> = new Set();
    /**
     * Every topic ever subscribed, replayed on each reconnect.
     *
     * mqtt.js can do this itself, but only populates its own _resubscribeTopics when
     * reconnectPeriod > 0 (mqtt.js:18422). This client uses reconnectPeriod: 0 so it can
     * apply exponential backoff, which silently disables the library's resubscription: after
     * a reconnect the session is clean, the broker has dropped the subscriptions, and the
     * bridge would go permanently deaf while still reporting itself connected.
     */
    private subscribedTopics: Set<string> = new Set();
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private closing = false;
    private resolveFirstConnect: (() => void) | null = null;
    /**
     * Attempt count after which reconnect logging escalates to a warning.
     *
     * NOT a give-up threshold: retries continue indefinitely, because a home broker comes
     * back and exiting into a Docker restart loop against a down broker only churns.
     */
    private readonly warnAfterAttempts: number;
    private readonly baseReconnectDelay: number;
    private readonly maxReconnectDelay: number;
    private readonly connectTimeout: number;
    private readonly qos: 0 | 1 | 2;

    constructor(private readonly config: BrokerConfig) {
        // Use config values or fall back to defaults
        this.warnAfterAttempts = config.maxReconnectAttempts ?? DEFAULT_MQTT_SETTINGS.maxReconnectAttempts;
        this.baseReconnectDelay = config.baseReconnectDelay ?? DEFAULT_MQTT_SETTINGS.baseReconnectDelay;
        this.maxReconnectDelay = config.maxReconnectDelay ?? DEFAULT_MQTT_SETTINGS.maxReconnectDelay;
        this.connectTimeout = config.connectTimeout ?? DEFAULT_MQTT_SETTINGS.connectTimeout;
        this.qos = config.qos ?? DEFAULT_MQTT_SETTINGS.qos;
    }

    /**
     * Connect to the MQTT broker with automatic reconnection
     *
     * The returned promise resolves on the FIRST successful connection and is not rejected
     * for ordinary connection failures. Rejecting would make the bridge exit at startup when
     * the broker happens to be down, which is precisely the restart loop the retry logic
     * exists to avoid.
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
                // Explicitly off: with reconnectPeriod 0 the library would not resubscribe
                // anyway, and this makes sure the two layers never both issue subscriptions
                // if that ever changes. See subscribedTopics above.
                resubscribe: false,
            };

            // Add authentication if provided
            if (this.config.user) {
                options.username = this.config.user;
            }
            if (this.config.pass) {
                options.password = this.config.pass;
            }

            this.resolveFirstConnect = resolve;

            try {
                this.client = mqtt.connect(brokerUrl, options);
            } catch (error) {
                // Malformed URL and similar: retrying cannot help
                reject(error);
                return;
            }

            // Connection successful
            this.client.on("connect", () => {
                console.log("MQTT broker connected successfully");
                this.reconnectAttempts = 0; // Reset on successful connection
                this.clearReconnectTimer();
                this.restoreSubscriptions();
                this.notifyConnectionChange(true);

                if (this.resolveFirstConnect) {
                    this.resolveFirstConnect();
                    this.resolveFirstConnect = null;
                }
            });

            // Connection error. Logged only: the close handler drives retries.
            this.client.on("error", (error) => {
                console.error("MQTT connection error:", error.message);
            });

            // Disconnected - attempt reconnection with exponential backoff
            this.client.on("close", () => {
                if (this.closing) {
                    return;
                }
                console.log("MQTT connection closed");
                this.notifyConnectionChange(false);
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
     * Schedule reconnection with capped exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.closing || this.reconnectTimer) {
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            this.maxReconnectDelay
        );

        const message = `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`;
        if (this.reconnectAttempts >= this.warnAfterAttempts) {
            console.warn(`${message} - broker has been unreachable for ${this.reconnectAttempts} attempts`);
        } else {
            console.log(message);
        }

        this.reconnectTimer = setTimeout(() => {
            // Cleared first: if this attempt fails, the resulting close handler must be able
            // to schedule the next one.
            this.reconnectTimer = null;

            if (this.closing || !this.client) {
                return;
            }
            this.client.reconnect();
        }, delay);
    }

    /**
     * Cancel a pending reconnect attempt
     */
    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /**
     * Subscribe to a topic or array of topics
     *
     * Topics are remembered so they can be replayed after a reconnect.
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
                    for (const topic of topicArray) {
                        this.subscribedTopics.add(topic);
                    }
                    console.log(`Successfully subscribed to ${topicArray.length} topic(s)`);
                    resolve();
                }
            });
        });
    }

    /**
     * Re-issue every known subscription after a reconnect
     *
     * A no-op on the first connect, when nothing has subscribed yet.
     */
    private restoreSubscriptions(): void {
        if (this.subscribedTopics.size === 0 || !this.client) {
            return;
        }

        const topics = Array.from(this.subscribedTopics);
        console.log(`Restoring ${topics.length} subscription(s) after reconnect`);

        this.client.subscribe(topics, (error) => {
            if (error) {
                console.error("Failed to restore subscriptions:", error.message);
            } else {
                console.log(`Successfully restored ${topics.length} subscription(s)`);
            }
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
     * Register a connection state handler
     *
     * Lets the bridge mark endpoints unreachable as soon as the broker drops, rather than
     * leaving stale values in the controller.
     */
    onConnectionChange(handler: MqttConnectionHandler): void {
        this.connectionHandlers.add(handler);
    }

    /**
     * Notify handlers of a connection state change
     */
    private notifyConnectionChange(connected: boolean): void {
        for (const handler of this.connectionHandlers) {
            try {
                handler(connected);
            } catch (error) {
                console.error("Error in connection handler:", error);
            }
        }
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
        // Set before end(): end() emits "close", which would otherwise schedule a reconnect
        // against a client we are deliberately shutting down.
        this.closing = true;
        this.clearReconnectTimer();

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
