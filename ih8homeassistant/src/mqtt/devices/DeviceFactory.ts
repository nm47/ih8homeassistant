/**
 * Factory for creating device-specific MQTT bridge instances
 */

import type { Endpoint } from "@matter/main";
import type { DeviceConfig } from "../../types/config.js";
import type { MqttClient } from "../MqttClient.js";
import { BaseDevice } from "./BaseDevice.js";
import { OnOffDevice } from "./OnOffDevice.js";
import { DimmableDevice } from "./DimmableDevice.js";
import { ColorDevice } from "./ColorDevice.js";

export class DeviceFactory {
    /**
     * Create the appropriate device bridge instance based on device type
     */
    static createDevice(
        config: DeviceConfig,
        endpoint: Endpoint,
        mqttClient: MqttClient
    ): BaseDevice {
        switch (config.type) {
            case "OnOffPlugInUnitDevice":
            case "OnOffLightDevice":
                return new OnOffDevice(config, endpoint, mqttClient);

            case "DimmableLightDevice":
                return new DimmableDevice(config, endpoint, mqttClient);

            case "ExtendedColorLightDevice":
                return new ColorDevice(config, endpoint, mqttClient);

            default:
                // TypeScript exhaustiveness check
                const _exhaustive: never = config;
                throw new Error(`Unsupported device type: ${(_exhaustive as DeviceConfig).type}`);
        }
    }
}
