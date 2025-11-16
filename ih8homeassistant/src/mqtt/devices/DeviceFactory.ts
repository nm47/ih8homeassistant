/**
 * Factory for creating device-specific MQTT bridge instances
 * Now delegates to DeviceRegistry for all device creation
 */

import type { Endpoint } from "@matter/main";
import type { MqttClient } from "../MqttClient.js";
import { DeviceRegistry } from "./registry.js";
import type { BaseDeviceInterface } from "./metadata.js";

// Import device index to trigger registration
import "./index.js";

export class DeviceFactory {
    /**
     * Create the appropriate device bridge instance based on device type
     * Uses the DeviceRegistry for dynamic device lookup
     */
    static createDevice(
        config: any,
        endpoint: Endpoint,
        mqttClient: MqttClient
    ): BaseDeviceInterface {
        return DeviceRegistry.createDevice(config, endpoint, mqttClient);
    }
}
