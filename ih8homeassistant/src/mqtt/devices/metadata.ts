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
    type: "string" | "number" | "boolean";
    /** Default value if not provided */
    default: string | number | boolean;
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
 * Base interface all devices must implement
 */
export interface BaseDeviceInterface {
    /** Device configuration */
    readonly config: any;
    /** Matter endpoint */
    readonly endpoint: Endpoint;
    /** MQTT client */
    readonly mqttClient: MqttClient;

    /** Initialize the device: subscribe to topics and setup handlers */
    initialize(): Promise<void>;

    /** Handle incoming MQTT message */
    handleMqttMessage(topic: string, payload: Buffer): void;
}

/**
 * Constructor type for device classes
 */
export interface DeviceConstructor {
    new (config: any, endpoint: Endpoint, mqttClient: MqttClient): BaseDeviceInterface;
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
 * Helper to validate that all required topics are present
 */
export function validateTopics(
    config: any,
    schema: TopicSchema,
    deviceName: string
): string[] {
    const errors: string[] = [];
    const topics = config.topics || {};

    for (const topicKey of schema.required) {
        if (!topics[topicKey]) {
            errors.push(`[${deviceName}] Missing required topic: ${topicKey}`);
        }
    }

    return errors;
}

/**
 * Helper to validate and apply option defaults
 */
export function applyOptionDefaults(
    config: any,
    schema: OptionSchema
): any {
    const options = { ...config.options };

    for (const [key, definition] of Object.entries(schema)) {
        if (options[key] === undefined) {
            options[key] = definition.default;
        }
    }

    return options;
}
