import { readFileSync } from "fs";
import { parse } from "toml";
import type { BridgeConfig, BrokerConfig, DeviceConfig, McpConfig } from "../types/config.js";
import { DEFAULT_MCP_SETTINGS, DEFAULT_MQTT_SETTINGS } from "../types/config.js";
import { DeviceRegistry } from "../mqtt/devices/registry.js";
import { normalizeName } from "../house/names.js";

// Import devices to trigger registration
import "../mqtt/devices/index.js";

/** Device ids are what the MCP tools and logs show, so keep them plain */
const DEVICE_ID_PATTERN = /^[a-z0-9_]+$/;

/** Device types whose on/off a printer flag can restrict */
const PRINTER_TYPES = new Set(["OnOffPlugInUnitDevice", "OnOffLightDevice"]);

/** Default "kind" per device type, for entries that don't set one */
const DEFAULT_KINDS: Record<string, string> = {
    OnOffPlugInUnitDevice: "plug",
    OnOffLightDevice: "light",
    DimmableLightDevice: "dimmable light",
    ExtendedColorLightDevice: "color light",
    TVDevice: "TV",
    GenericSwitchDevice: "button",
};

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
        const mcp = this.parseMcp(raw.mcp);
        const devices = this.parseDevices(raw.devices);

        return { broker, mcp, devices };
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
     * Parse and validate the optional MCP server table
     */
    private static parseMcp(raw: unknown): McpConfig {
        if (raw === undefined) {
            return { ...DEFAULT_MCP_SETTINGS };
        }
        if (!this.isRecord(raw)) {
            throw new ConfigValidationError("mcp configuration must be a table");
        }

        const host = raw.host ?? DEFAULT_MCP_SETTINGS.host;
        if (typeof host !== "string" || host.length === 0) {
            throw new ConfigValidationError("mcp.host must be a non-empty string");
        }

        const port = raw.port ?? DEFAULT_MCP_SETTINGS.port;
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new ConfigValidationError("mcp.port must be an integer between 1 and 65535");
        }

        // An empty token means "no token", which is how the example config leaves it
        const token = raw.token;
        if (token !== undefined && typeof token !== "string") {
            throw new ConfigValidationError("mcp.token must be a string");
        }

        const confirmTimeoutMs = raw.confirmTimeoutMs !== undefined
            ? this.parsePositiveInteger(raw.confirmTimeoutMs, "mcp.confirmTimeoutMs")
            : DEFAULT_MCP_SETTINGS.confirmTimeoutMs;

        return {
            host,
            port,
            token: token ? token : undefined,
            confirmTimeoutMs,
        };
    }

    /**
     * Parse and validate devices array
     */
    private static parseDevices(raw: unknown): DeviceConfig[] {
        if (!Array.isArray(raw)) {
            throw new ConfigValidationError("devices must be an array");
        }

        if (raw.length === 0) {
            throw new ConfigValidationError("devices array cannot be empty");
        }

        const devices = raw.map((device, index) => this.parseDevice(device, index));
        this.assertDistinctNames(devices);
        return devices;
    }

    /**
     * Reject names that could point at two devices
     *
     * A device's id and name must not match another device's id, name or alias. Two devices
     * may share an alias: that name is then ambiguous, and the MCP tools reject it with
     * both candidates rather than picking one.
     */
    private static assertDistinctNames(devices: DeviceConfig[]): void {
        const owners = new Map<string, string>();

        for (const device of devices) {
            if (owners.has(`id:${device.id}`)) {
                throw new ConfigValidationError(`Duplicate device id: "${device.id}"`);
            }
            owners.set(`id:${device.id}`, device.id);

            for (const name of new Set([normalizeName(device.id), normalizeName(device.name)])) {
                const owner = owners.get(name);
                if (owner !== undefined) {
                    throw new ConfigValidationError(
                        `Devices "${owner}" and "${device.id}" both answer to the name "${name}"`
                    );
                }
                owners.set(name, device.id);
            }
        }

        for (const device of devices) {
            for (const alias of device.aliases) {
                const owner = owners.get(normalizeName(alias));
                if (owner !== undefined && owner !== device.id) {
                    throw new ConfigValidationError(
                        `Alias "${alias}" of "${device.id}" is the id or name of "${owner}"`
                    );
                }
            }
        }
    }

    /**
     * Parse and validate a single device configuration using metadata
     */
    private static parseDevice(raw: unknown, index: number): DeviceConfig {
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

        const id = raw.id;
        if (typeof id !== "string" || !DEVICE_ID_PATTERN.test(id)) {
            throw new ConfigValidationError(
                `devices[${index}] (${name}).id must be lowercase letters, digits and underscores`
            );
        }

        const room = raw.room;
        if (typeof room !== "string" || normalizeName(room).length === 0) {
            throw new ConfigValidationError(`devices[${index}] (${id}).room must be a non-empty string`);
        }

        // Required rather than defaulted: a config written before this field existed must
        // fail loudly instead of silently dropping devices from every Matter controller
        const matter = raw.matter;
        if (typeof matter !== "boolean") {
            throw new ConfigValidationError(`devices[${index}] (${id}).matter must be true or false`);
        }

        const printer = raw.printer ?? false;
        if (typeof printer !== "boolean") {
            throw new ConfigValidationError(`devices[${index}] (${id}).printer must be true or false`);
        }
        if (printer && !PRINTER_TYPES.has(type)) {
            throw new ConfigValidationError(
                `devices[${index}] (${id}).printer is only supported for ${[...PRINTER_TYPES].join(", ")}`
            );
        }

        const aliases = raw.aliases ?? [];
        if (!Array.isArray(aliases) || !aliases.every(alias => typeof alias === "string" && normalizeName(alias).length > 0)) {
            throw new ConfigValidationError(`devices[${index}] (${id}).aliases must be a list of non-empty strings`);
        }

        const kind = raw.kind ?? DEFAULT_KINDS[type] ?? type;
        if (typeof kind !== "string" || kind.length === 0) {
            throw new ConfigValidationError(`devices[${index}] (${id}).kind must be a non-empty string`);
        }

        // Build device config object.
        // Nullish coalescing, not ||: falsy-but-invalid values such as false, 0 or "" must
        // reach the device's shape validation rather than being rewritten to {} here.
        const deviceConfig: any = {
            type,
            name,
            id,
            room,
            aliases,
            printer,
            matter,
            kind,
            topics: raw.topics ?? {},
            options: raw.options ?? {},
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
