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
    /**
     * Display name. Matter derives the endpoint ID from it, so renaming a Matter device
     * gives it a new identity in every controller.
     */
    name: string;
    /** Stable identifier the MCP tools use; lowercase letters, digits and underscores */
    id: string;
    room: string;
    /** Other names the MCP tools accept for this device */
    aliases: string[];
    /** Printers are on-only in Matter and need a person's confirmation to switch off */
    printer: boolean;
    /** Whether Matter controllers see this device */
    matter: boolean;
    /** Free-text description, e.g. "light switch"; defaults from the type */
    kind: string;
    topics: Record<string, string>;
    options: Record<string, any>;
}

/**
 * MCP server configuration
 */
export interface McpConfig {
    /** Bind address (default: all interfaces) */
    host: string;
    /** Port for the Streamable HTTP endpoint at /mcp */
    port: number;
    /** When set, clients must send "Authorization: Bearer <token>" */
    token?: string;
    /** How long to wait for a device to confirm a command, in milliseconds */
    confirmTimeoutMs: number;
}

/**
 * Complete bridge configuration
 */
export interface BridgeConfig {
    /** MQTT broker connection settings */
    broker: BrokerConfig;
    /** MCP server settings */
    mcp: McpConfig;
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

/**
 * Default values for the MCP server
 */
export const DEFAULT_MCP_SETTINGS = {
    host: "0.0.0.0",
    port: 8540,
    confirmTimeoutMs: 3000,
};
