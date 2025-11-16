/**
 * Device registry for dynamic device type management
 * Replaces hardcoded switch statements with metadata-driven lookup
 */

import type { Endpoint } from "@matter/main";
import type { MqttClient } from "../MqttClient.js";
import type {
    DeviceConstructor,
    DeviceMetadata,
    BaseDeviceInterface,
} from "./metadata.js";

/**
 * Registry entry for a device type
 */
interface DeviceRegistryEntry {
    /** Device metadata */
    metadata: DeviceMetadata;
    /** Device class constructor */
    deviceClass: DeviceConstructor;
}

/**
 * Global device registry
 * Maps device type names to their metadata and constructors
 */
class DeviceRegistry {
    private static registry = new Map<string, DeviceRegistryEntry>();

    /**
     * Register a device type
     */
    static register(
        typeName: string,
        metadata: DeviceMetadata,
        deviceClass: DeviceConstructor
    ): void {
        if (this.registry.has(typeName)) {
            throw new Error(`Device type already registered: ${typeName}`);
        }

        this.registry.set(typeName, { metadata, deviceClass });
        console.log(`[Registry] Registered device type: ${typeName}`);
    }

    /**
     * Get metadata for a device type
     */
    static getMetadata(typeName: string): DeviceMetadata | undefined {
        return this.registry.get(typeName)?.metadata;
    }

    /**
     * Get all registered device type names
     */
    static getRegisteredTypes(): string[] {
        return Array.from(this.registry.keys());
    }

    /**
     * Check if a device type is registered
     */
    static isRegistered(typeName: string): boolean {
        return this.registry.has(typeName);
    }

    /**
     * Create a device instance from configuration
     */
    static createDevice(
        config: any,
        endpoint: Endpoint,
        mqttClient: MqttClient
    ): BaseDeviceInterface {
        const typeName = config.type;
        const entry = this.registry.get(typeName);

        if (!entry) {
            throw new Error(
                `Unknown device type: ${typeName}. Available types: ${this.getRegisteredTypes().join(", ")}`
            );
        }

        return new entry.deviceClass(config, endpoint, mqttClient);
    }

    /**
     * Validate a device configuration using its metadata
     */
    static validateConfig(config: any): { valid: boolean; errors: string[] } {
        const typeName = config.type;
        const metadata = this.getMetadata(typeName);

        if (!metadata) {
            return {
                valid: false,
                errors: [`Unknown device type: ${typeName}`],
            };
        }

        return metadata.validateConfig(config);
    }

    /**
     * Clear all registrations (useful for testing)
     */
    static clear(): void {
        this.registry.clear();
    }
}

export { DeviceRegistry };
