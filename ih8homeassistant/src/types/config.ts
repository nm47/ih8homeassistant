/**
 * Configuration type definitions for TOML parsing
 */

/**
 * MQTT broker configuration
 */
export interface BrokerConfig {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    /** Maximum number of reconnection attempts (default: 10) */
    maxReconnectAttempts?: number;
    /** Base reconnection delay in milliseconds (default: 1000) */
    baseReconnectDelay?: number;
    /** Maximum reconnection delay in milliseconds (default: 60000) */
    maxReconnectDelay?: number;
    /** Connection timeout in milliseconds (default: 10000) */
    connectTimeout?: number;
    /** MQTT QoS level for publishing (0, 1, or 2; default: 0 for low latency) */
    qos?: 0 | 1 | 2;
}

/**
 * Generic device configuration
 * Specific device types define their own config interfaces with full type safety
 */
export interface DeviceConfig {
    type: string;
    name: string;
    topics: Record<string, string>;
    options: Record<string, any>;
}

/**
 * Complete bridge configuration
 */
export interface BridgeConfig {
    /** MQTT broker connection settings */
    broker: BrokerConfig;
    /** List of devices to bridge */
    devices: DeviceConfig[];
}

/**
 * Default values for MQTT broker reconnection settings
 */
export const DEFAULT_MQTT_SETTINGS = {
    maxReconnectAttempts: 10,
    baseReconnectDelay: 1000, // 1 second
    maxReconnectDelay: 60000, // 60 seconds
    connectTimeout: 10000, // 10 seconds
    qos: 0 as 0 | 1 | 2, // QoS 0 for lowest latency
};
