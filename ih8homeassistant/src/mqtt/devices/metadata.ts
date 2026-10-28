/**
 * Device metadata system for plugin-like device architecture
 * Each device exports static metadata describing its requirements and capabilities
 */

import type { Endpoint } from "@matter/main";
import type { MqttClient } from "../MqttClient.js";

/**
 * Describes the schema for MQTT topics
 */
export interface TopicSchema {
    /** Always required topics for this device */
    required: string[];
    /** Optional topics that may be used */
    optional: string[];
}

/**
 * Describes a single configuration option
 */
export interface OptionDefinition {
    /** TypeScript type of the option */
    type: "string" | "number" | "boolean" | "string[]";
    /** Default value if not provided */
    default: string | number | boolean | string[];
    /** Description of what this option does */
    description?: string;
}

/**
 * Schema for device configuration options
 */
export interface OptionSchema {
    [key: string]: OptionDefinition;
}

/**
 * Configuration for creating a Matter endpoint
 */
export interface EndpointConfiguration {
    /** Initial state to set on the endpoint */
    state: Record<string, any>;
    /** MQTT topics to subscribe to */
    topics: string[];
}

/**
 * Where a device's state came from
 *
 * - `reported`: the device's own report, e.g. Tasmota's stat/tele topics
 * - `last sent`: an echo of the last command, for devices that cannot be queried (the TV
 *   over HDMI-CEC)
 */
export type StateSource = "reported" | "last sent";

/**
 * Live state of a device, kept whether or not Matter sees it
 *
 * `null` means "not known yet": nothing has been heard since startup or since the broker
 * connection was last lost. Nothing is ever assumed.
 */
export interface DeviceState {
    online: boolean | null;
    on: boolean | null;
    /** Brightness in percent (0-100); dimmable and color devices only */
    brightness?: number | null;
    /** Color as "#rrggbb"; color devices only */
    color?: string | null;
    /** Selected input; TVs only */
    input?: string | null;
    source: StateSource;
    /** When the last state report arrived */
    reportedAt: Date | null;
}

/**
 * Called after every state report (not availability changes) a device receives
 */
export type ReportListener = (state: Readonly<DeviceState>) => void;

/**
 * Light settings a caller can request; omitted fields are left alone
 */
export interface LightSettings {
    /** Percent, 0-100 */
    brightness?: number;
    /** "#rrggbb" */
    color?: string;
}

/**
 * Base interface all devices must implement
 *
 * The command methods are optional and present only on devices that support them. Matter
 * and the MCP tools both switch devices through them, so there is one publish path.
 */
export interface BaseDeviceInterface {
    /** Device configuration */
    readonly config: any;
    /** Matter endpoint, or null for devices Matter does not see */
    readonly endpoint: Endpoint | null;
    /** MQTT client */
    readonly mqttClient: MqttClient;
    /** Live state, updated from MQTT */
    readonly state: Readonly<DeviceState>;
    /** What this particular device can do, which may depend on its configuration */
    readonly capabilities: ReadonlySet<DeviceCapability>;
    /** Inputs a TV accepts; TVs with an input topic only */
    readonly inputs?: readonly string[];

    /** Initialize the device: subscribe to topics and setup handlers */
    initialize(): Promise<void>;

    /** Handle incoming MQTT message */
    handleMqttMessage(topic: string, payload: Buffer): void;

    /** Set the reachable flag from the device's own availability topic */
    setReachable(reachable: boolean): void;

    /**
     * Forget everything heard over MQTT, because the broker connection dropped.
     *
     * Marks the endpoint unreachable so stale values do not linger in the controller, and
     * resets the state to unknown: changes made while disconnected were never seen.
     */
    handleBrokerLost(): void;

    /** Subscribe to state reports. Returns the unsubscribe function. */
    onReport(listener: ReportListener): () => void;

    /** Publish an on/off command */
    setOn?(on: boolean): Promise<void>;

    /** Publish brightness and/or color */
    setLight?(settings: LightSettings): Promise<void>;

    /** Publish an input selection */
    setInput?(input: string): Promise<void>;

    /** Publish a button press */
    press?(): Promise<void>;

    /** Release any timers the device holds. Called during shutdown. */
    close(): void | Promise<void>;
}

/**
 * Constructor type for device classes
 */
export interface DeviceConstructor {
    new (config: any, endpoint: Endpoint | null, mqttClient: MqttClient): BaseDeviceInterface;
    metadata: DeviceMetadata;
}

/**
 * Device capabilities that can be composed
 */
export type DeviceCapability =
    | "availability"  // Device online/offline tracking
    | "onoff"         // On/off state
    | "dimming"       // Brightness/level control
    | "color"         // RGB/HSV color control
    | "input"         // Input selection (TV)
    | "switch";       // Momentary switch/button

/**
 * Factory function that creates endpoint configuration for a device
 */
export type EndpointConfigFactory = (config: any) => EndpointConfiguration;

/**
 * Validation result from metadata
 */
export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Complete metadata describing a device type
 */
export interface DeviceMetadata {
    /** Human-readable device type name */
    typeName: string;

    /** Device capabilities (used for composition) */
    capabilities: Set<DeviceCapability>;

    /** MQTT topic schema */
    topicSchema: TopicSchema;

    /** Configuration option schema with defaults */
    optionSchema: OptionSchema;

    /**
     * Validate a device configuration
     * Returns validation errors if invalid
     */
    validateConfig(config: any): ValidationResult;

    /**
     * Create Matter endpoint configuration from device config
     * Returns initial state and topics to subscribe
     */
    createEndpointConfig(config: any): EndpointConfiguration;

    /**
     * Get the Matter.js device type class for this device
     * This is used during endpoint creation in bootstrap
     */
    getMatterDeviceType(): any;

    /**
     * Get Matter.js behaviors/servers to add to the device
     * Returns array of behavior classes to mix in
     */
    getMatterBehaviors(): any[];
}

/**
 * Helper to create a validation result
 */
export function createValidationResult(errors: string[] = []): ValidationResult {
    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Normalize an MQTT token for comparison.
 *
 * Used by BOTH validation and runtime matching. Validating raw values while matching
 * normalized ones would let onValue="ON" and offValue="on" pass validation and then be
 * indistinguishable at runtime.
 */
export function normalizeToken(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Match an MQTT payload against a configured on/off token pair.
 *
 * Returns null when the payload matches neither, so callers can log and ignore rather than
 * silently treating every unrecognized value as "off".
 */
export function matchToken(message: string, onValue: string, offValue: string): boolean | null {
    const normalized = normalizeToken(message);

    if (normalized === normalizeToken(onValue)) {
        return true;
    }
    if (normalized === normalizeToken(offValue)) {
        return false;
    }
    return null;
}

/**
 * Helper to check that topics/options are objects before anything tries to spread them.
 *
 * Must run before applyOptionDefaults: a scalar would otherwise spread into an empty object
 * and be silently accepted.
 */
export function validateConfigShape(config: any, deviceName: string): string[] {
    const errors: string[] = [];

    for (const field of ["topics", "options"] as const) {
        const value = config[field];
        if (value === undefined) {
            continue;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            errors.push(`[${deviceName}] ${field} must be a table`);
        }
    }

    return errors;
}

/**
 * Helper to validate that all required topics are present and usable
 */
export function validateTopics(
    config: any,
    schema: TopicSchema,
    deviceName: string
): string[] {
    const errors: string[] = [];
    const topics = config.topics || {};

    for (const topicKey of schema.required) {
        const topic = topics[topicKey];
        if (typeof topic !== "string" || topic.trim().length === 0) {
            errors.push(`[${deviceName}] Missing or empty required topic: ${topicKey}`);
        }
    }

    for (const topicKey of schema.optional) {
        const topic = topics[topicKey];
        if (topic !== undefined && (typeof topic !== "string" || topic.trim().length === 0)) {
            errors.push(`[${deviceName}] Optional topic ${topicKey} must be a non-empty string when set`);
        }
    }

    return errors;
}

/**
 * Helper to validate option values against the types their schema declares
 */
export function validateOptions(
    config: any,
    schema: OptionSchema,
    deviceName: string
): string[] {
    const errors: string[] = [];
    const options = config.options || {};

    for (const [key, definition] of Object.entries(schema)) {
        const value = options[key];
        if (value === undefined) {
            continue;
        }
        if (definition.type === "string[]") {
            if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
                errors.push(`[${deviceName}] Option ${key} must be an array of strings`);
            }
            continue;
        }
        if (typeof value !== definition.type) {
            errors.push(
                `[${deviceName}] Option ${key} must be a ${definition.type}, got ${typeof value}`
            );
        }
    }

    return errors;
}

/**
 * Helper to validate that a pair of tokens stays distinguishable after normalization
 */
export function validateTokenPair(
    config: any,
    onKey: string,
    offKey: string,
    deviceName: string
): string[] {
    const errors: string[] = [];
    const options = config.options || {};
    const onValue = options[onKey];
    const offValue = options[offKey];

    if (typeof onValue !== "string" || typeof offValue !== "string") {
        return errors; // type errors are reported by validateOptions
    }

    if (onValue.trim().length === 0) {
        errors.push(`[${deviceName}] Option ${onKey} must not be empty`);
    }
    if (offValue.trim().length === 0) {
        errors.push(`[${deviceName}] Option ${offKey} must not be empty`);
    }

    if (errors.length === 0 && normalizeToken(onValue) === normalizeToken(offValue)) {
        errors.push(
            `[${deviceName}] Options ${onKey} and ${offKey} are indistinguishable: both normalize to "${normalizeToken(onValue)}"`
        );
    }

    return errors;
}

/**
 * Helper to validate and apply option defaults
 *
 * Only safe once validateConfigShape has confirmed options is a table.
 */
export function applyOptionDefaults(
    config: any,
    schema: OptionSchema
): any {
    const options = { ...config.options };

    for (const [key, definition] of Object.entries(schema)) {
        if (options[key] === undefined) {
            // Copied, so one device mutating its list could never change another's default
            options[key] = Array.isArray(definition.default) ? [...definition.default] : definition.default;
        }
    }

    return options;
}

/**
 * Parse a JSON object payload, such as Tasmota's tele/<topic>/STATE
 *
 * Returns null for anything that is not a JSON object, so callers can log and ignore it.
 */
export function parseJsonObject(message: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(message);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Not JSON
    }
    return null;
}

/**
 * Run the validation every device shares, in the one order that is safe.
 *
 * Shape first, because applying defaults to a scalar would silently turn it into a valid
 * empty table. Defaults next, so topic/option/token checks see the effective configuration
 * rather than only what the user wrote.
 *
 * @param tokenPairs Option key pairs that must stay distinguishable after normalization
 */
export function validateDeviceConfig(
    config: any,
    topicSchema: TopicSchema,
    optionSchema: OptionSchema,
    tokenPairs: Array<[string, string]> = []
): ValidationResult {
    const deviceName = typeof config.name === "string" && config.name.length > 0
        ? config.name
        : "unknown";
    const errors: string[] = [];

    if (typeof config.name !== "string" || config.name.trim().length === 0) {
        errors.push("Missing device name");
    }

    const shapeErrors = validateConfigShape(config, deviceName);
    if (shapeErrors.length > 0) {
        return createValidationResult([...errors, ...shapeErrors]);
    }

    config.options = applyOptionDefaults(config, optionSchema);

    errors.push(...validateTopics(config, topicSchema, deviceName));
    errors.push(...validateOptions(config, optionSchema, deviceName));

    for (const [onKey, offKey] of tokenPairs) {
        errors.push(...validateTokenPair(config, onKey, offKey, deviceName));
    }

    return createValidationResult(errors);
}
