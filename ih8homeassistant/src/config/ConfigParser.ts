import { readFileSync } from "fs";
import { parse } from "toml";
import {
    BridgeConfig,
    BrokerConfig,
    DeviceConfig,
    DEFAULT_BASE_OPTIONS,
    DEFAULT_COLOR_OPTIONS,
} from "../types/config.js";
import { isValidDeviceType } from "../types/devices.js";

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
     * @param filePath Path to the TOML configuration file
     * @returns Parsed and validated bridge configuration
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
     * @param content TOML configuration content
     * @returns Parsed and validated bridge configuration
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

        return { host, port, user, pass };
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

        return raw.map((device, index) => this.parseDevice(device, index));
    }

    /**
     * Parse and validate a single device configuration
     */
    private static parseDevice(raw: unknown, index: number): DeviceConfig {
        if (!this.isRecord(raw)) {
            throw new ConfigValidationError(
                `devices[${index}] must be an object`
            );
        }

        const type = raw.type;
        if (typeof type !== "string" || !isValidDeviceType(type)) {
            throw new ConfigValidationError(
                `devices[${index}].type must be a valid device type (OnOffPlugInUnitDevice, OnOffLightDevice, DimmableLightDevice, or ExtendedColorLightDevice)`
            );
        }

        const name = raw.name;
        if (typeof name !== "string" || name.length === 0) {
            throw new ConfigValidationError(
                `devices[${index}].name must be a non-empty string`
            );
        }

        const topics = this.parseTopics(raw.topics, type, index);
        const options = this.parseOptions(raw.options, type, index);

        // TypeScript discriminated union handling
        if (type === "OnOffPlugInUnitDevice" || type === "OnOffLightDevice") {
            return { type, name, topics, options };
        } else if (type === "DimmableLightDevice") {
            return { type, name, topics, options };
        } else {
            // ExtendedColorLightDevice
            return { type, name, topics, options };
        }
    }

    /**
     * Parse and validate device topics based on device type
     */
    private static parseTopics(
        raw: unknown,
        type: string,
        deviceIndex: number
    ): DeviceConfig["topics"] {
        if (!this.isRecord(raw)) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics must be an object`
            );
        }

        // Validate base topics (required for all devices)
        const getOnline = raw.getOnline;
        if (typeof getOnline !== "string" || getOnline.length === 0) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics.getOnline must be a non-empty string`
            );
        }

        const getOn = raw.getOn;
        if (typeof getOn !== "string" || getOn.length === 0) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics.getOn must be a non-empty string`
            );
        }

        const setOn = raw.setOn;
        if (typeof setOn !== "string" || setOn.length === 0) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics.setOn must be a non-empty string`
            );
        }

        // For on/off only devices, return base topics
        if (type === "OnOffPlugInUnitDevice" || type === "OnOffLightDevice") {
            return { getOnline, getOn, setOn };
        }

        // Validate level topics (required for dimmable and color devices)
        const getBrightness = raw.getBrightness;
        if (typeof getBrightness !== "string" || getBrightness.length === 0) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics.getBrightness must be a non-empty string for ${type}`
            );
        }

        const setBrightness = raw.setBrightness;
        if (typeof setBrightness !== "string" || setBrightness.length === 0) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics.setBrightness must be a non-empty string for ${type}`
            );
        }

        // For dimmable devices, return level topics
        if (type === "DimmableLightDevice") {
            return { getOnline, getOn, setOn, getBrightness, setBrightness };
        }

        // Validate color topics (required for color devices)
        const getRGB = raw.getRGB;
        if (typeof getRGB !== "string" || getRGB.length === 0) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics.getRGB must be a non-empty string for ExtendedColorLightDevice`
            );
        }

        const setRGB = raw.setRGB;
        if (typeof setRGB !== "string" || setRGB.length === 0) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].topics.setRGB must be a non-empty string for ExtendedColorLightDevice`
            );
        }

        return { getOnline, getOn, setOn, getBrightness, setBrightness, getRGB, setRGB };
    }

    /**
     * Parse and validate device options, applying defaults
     */
    private static parseOptions(
        raw: unknown,
        type: string,
        deviceIndex: number
    ): DeviceConfig["options"] {
        if (raw === undefined) {
            // Return defaults based on device type
            return type === "ExtendedColorLightDevice"
                ? { ...DEFAULT_COLOR_OPTIONS }
                : { ...DEFAULT_BASE_OPTIONS };
        }

        if (!this.isRecord(raw)) {
            throw new ConfigValidationError(
                `devices[${deviceIndex}].options must be an object`
            );
        }

        // Start with defaults
        const defaults =
            type === "ExtendedColorLightDevice"
                ? DEFAULT_COLOR_OPTIONS
                : DEFAULT_BASE_OPTIONS;

        const options: Record<string, unknown> = { ...defaults };

        // Override with provided values
        if (raw.onValue !== undefined) {
            if (typeof raw.onValue !== "string") {
                throw new ConfigValidationError(
                    `devices[${deviceIndex}].options.onValue must be a string`
                );
            }
            options.onValue = raw.onValue;
        }

        if (raw.offValue !== undefined) {
            if (typeof raw.offValue !== "string") {
                throw new ConfigValidationError(
                    `devices[${deviceIndex}].options.offValue must be a string`
                );
            }
            options.offValue = raw.offValue;
        }

        if (raw.onlineValue !== undefined) {
            if (typeof raw.onlineValue !== "string") {
                throw new ConfigValidationError(
                    `devices[${deviceIndex}].options.onlineValue must be a string`
                );
            }
            options.onlineValue = raw.onlineValue;
        }

        if (raw.offlineValue !== undefined) {
            if (typeof raw.offlineValue !== "string") {
                throw new ConfigValidationError(
                    `devices[${deviceIndex}].options.offlineValue must be a string`
                );
            }
            options.offlineValue = raw.offlineValue;
        }

        // Color-specific options
        if (type === "ExtendedColorLightDevice") {
            if (raw.hex !== undefined) {
                if (typeof raw.hex !== "boolean") {
                    throw new ConfigValidationError(
                        `devices[${deviceIndex}].options.hex must be a boolean`
                    );
                }
                options.hex = raw.hex;
            }

            if (raw.hexPrefix !== undefined) {
                if (typeof raw.hexPrefix !== "string") {
                    throw new ConfigValidationError(
                        `devices[${deviceIndex}].options.hexPrefix must be a string`
                    );
                }
                options.hexPrefix = raw.hexPrefix;
            }
        }

        return options;
    }

    /**
     * Type guard for Record<string, unknown>
     */
    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }
}
