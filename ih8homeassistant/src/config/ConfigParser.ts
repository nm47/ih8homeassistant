import { readFileSync } from "fs";
import { parse } from "toml";
import type { BridgeConfig, BrokerConfig } from "../types/config.js";
import { DEFAULT_MQTT_SETTINGS } from "../types/config.js";
import { DeviceRegistry } from "../mqtt/devices/registry.js";

// Import devices to trigger registration
import "../mqtt/devices/index.js";

/**
 * Error thrown when configuration validation fails
 */
export class ConfigValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigValidationError";
    }
}

/**
 * Load and parse TOML configuration file
 */
export class ConfigParser {
    /**
     * Load configuration from a TOML file
     */
    static loadFromFile(filePath: string): BridgeConfig {
        let content: string;
        try {
            content = readFileSync(filePath, "utf-8");
        } catch (error) {
            throw new ConfigValidationError(
                `Failed to read config file: ${(error as Error).message}`
            );
        }

        return this.parse(content);
    }

    /**
     * Parse TOML configuration string
     */
    static parse(content: string): BridgeConfig {
        let raw: unknown;
        try {
            raw = parse(content);
        } catch (error) {
            throw new ConfigValidationError(
                `Failed to parse TOML: ${(error as Error).message}`
            );
        }

        if (!this.isRecord(raw)) {
            throw new ConfigValidationError("Configuration must be an object");
        }

        const broker = this.parseBroker(raw.broker);
        const devices = this.parseDevices(raw.devices);

        return { broker, devices };
    }

    /**
     * Parse and validate broker configuration
     */
    private static parseBroker(raw: unknown): BrokerConfig {
        if (!this.isRecord(raw)) {
            throw new ConfigValidationError("broker configuration must be an object");
        }

        const host = raw.host;
        if (typeof host !== "string" || host.length === 0) {
            throw new ConfigValidationError("broker.host must be a non-empty string");
        }

        const port = raw.port;
        if (typeof port !== "number" || port < 1 || port > 65535) {
            throw new ConfigValidationError("broker.port must be a number between 1 and 65535");
        }

        const user = raw.user;
        if (user !== undefined && typeof user !== "string") {
            throw new ConfigValidationError("broker.user must be a string");
        }

        const pass = raw.pass;
        if (pass !== undefined && typeof pass !== "string") {
            throw new ConfigValidationError("broker.pass must be a string");
        }

        // Parse optional MQTT client settings with defaults
        const maxReconnectAttempts = raw.maxReconnectAttempts !== undefined
            ? this.parsePositiveInteger(raw.maxReconnectAttempts, "broker.maxReconnectAttempts")
            : DEFAULT_MQTT_SETTINGS.maxReconnectAttempts;

        const baseReconnectDelay = raw.baseReconnectDelay !== undefined
            ? this.parsePositiveInteger(raw.baseReconnectDelay, "broker.baseReconnectDelay")
            : DEFAULT_MQTT_SETTINGS.baseReconnectDelay;

        const maxReconnectDelay = raw.maxReconnectDelay !== undefined
            ? this.parsePositiveInteger(raw.maxReconnectDelay, "broker.maxReconnectDelay")
            : DEFAULT_MQTT_SETTINGS.maxReconnectDelay;

        const connectTimeout = raw.connectTimeout !== undefined
            ? this.parsePositiveInteger(raw.connectTimeout, "broker.connectTimeout")
            : DEFAULT_MQTT_SETTINGS.connectTimeout;

        // Parse QoS level
        let qos: 0 | 1 | 2 = DEFAULT_MQTT_SETTINGS.qos;
        if (raw.qos !== undefined) {
            if (typeof raw.qos !== "number" || ![0, 1, 2].includes(raw.qos)) {
                throw new ConfigValidationError("broker.qos must be 0, 1, or 2");
            }
            qos = raw.qos as 0 | 1 | 2;
        }

        return {
            host,
            port,
            user,
            pass,
            maxReconnectAttempts,
            baseReconnectDelay,
            maxReconnectDelay,
            connectTimeout,
            qos,
        };
    }

    /**
     * Parse and validate devices array
     */
    private static parseDevices(raw: unknown): any[] {
        if (!Array.isArray(raw)) {
            throw new ConfigValidationError("devices must be an array");
        }

        if (raw.length === 0) {
            throw new ConfigValidationError("devices array cannot be empty");
        }

        return raw.map((device, index) => this.parseDevice(device, index));
    }

    /**
     * Parse and validate a single device configuration using metadata
     */
    private static parseDevice(raw: unknown, index: number): any {
        if (!this.isRecord(raw)) {
            throw new ConfigValidationError(`devices[${index}] must be an object`);
        }

        const type = raw.type;
        if (typeof type !== "string") {
            throw new ConfigValidationError(
                `devices[${index}].type must be a string`
            );
        }

        // Check if device type is registered
        if (!DeviceRegistry.isRegistered(type)) {
            const availableTypes = DeviceRegistry.getRegisteredTypes();
            throw new ConfigValidationError(
                `devices[${index}].type "${type}" is not a valid device type. Available types: ${availableTypes.join(", ")}`
            );
        }

        const name = raw.name;
        if (typeof name !== "string" || name.length === 0) {
            throw new ConfigValidationError(
                `devices[${index}].name must be a non-empty string`
            );
        }

        // Build device config object
        const deviceConfig: any = {
            type,
            name,
            topics: raw.topics || {},
            options: raw.options || {},
        };

        // Use device metadata for validation
        const validationResult = DeviceRegistry.validateConfig(deviceConfig);

        if (!validationResult.valid) {
            throw new ConfigValidationError(
                `devices[${index}] validation failed:\n  ${validationResult.errors.join("\n  ")}`
            );
        }

        return deviceConfig;
    }

    /**
     * Type guard for Record<string, unknown>
     */
    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    /**
     * Parse and validate a positive integer value
     */
    private static parsePositiveInteger(value: unknown, fieldName: string): number {
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
            throw new ConfigValidationError(
                `${fieldName} must be a positive integer`
            );
        }
        return value;
    }
}
