# Example: Adding a New Device Type

This document demonstrates how easy it is to add a new device type to the bridge after the metadata refactoring.

## After the Refactoring

Adding a new device type requires modifying **2 files**:

1. Create new device class file with metadata
2. Register in `src/mqtt/devices/index.ts` (1 line)

## Example: Motion Sensor Device

Here's how you would add a motion sensor device:

### Step 1: Create the device file

**File**: `src/mqtt/devices/MotionSensorDevice.ts`

```typescript
import type { Endpoint } from "@matter/main";
import { OccupancySensorDevice } from "@matter/main/devices/occupancy-sensor";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import type { MqttClient } from "../MqttClient.js";
import type {
    BaseDeviceInterface,
    DeviceMetadata,
    EndpointConfiguration,
    ValidationResult,
} from "./metadata.js";
import {
    createValidationResult,
    validateTopics,
    applyOptionDefaults,
} from "./metadata.js";

export interface MotionSensorDeviceConfig {
    type: "OccupancySensorDevice";
    name: string;
    topics: {
        getOnline: string;
        getMotion: string;
    };
    options: {
        onlineValue: string;
        offlineValue: string;
        motionDetectedValue: string;
        noMotionValue: string;
    };
}

export class MotionSensorDevice implements BaseDeviceInterface {
    constructor(
        public readonly config: MotionSensorDeviceConfig,
        public readonly endpoint: Endpoint,
        public readonly mqttClient: MqttClient
    ) {}

    async initialize(): Promise<void> {
        const topics = [this.config.topics.getOnline, this.config.topics.getMotion];
        await this.mqttClient.subscribe(topics);
        this.setupMatterEventHandlers();
        console.log(`[${this.config.name}] MotionSensorDevice initialized`);
    }

    handleMqttMessage(topic: string, payload: Buffer): void {
        const message = payload.toString();

        if (topic === this.config.topics.getOnline) {
            this.handleAvailability(message);
        } else if (topic === this.config.topics.getMotion) {
            this.handleMotionState(message);
        }
    }

    protected handleAvailability(message: string): void {
        const isOnline = message === this.config.options.onlineValue;
        this.endpoint.set({
            bridgedDeviceBasicInformation: { reachable: isOnline },
        } as any);
    }

    protected handleMotionState(message: string): void {
        const motionDetected = message === this.config.options.motionDetectedValue;
        this.endpoint.set({
            occupancySensing: { occupancy: motionDetected ? 1 : 0 },
        } as any);
    }

    protected setupMatterEventHandlers(): void {
        // Motion sensors are typically read-only, so no Matter->MQTT events needed
    }

    static metadata: DeviceMetadata = {
        typeName: "MotionSensorDevice",
        capabilities: new Set(["availability"]),

        topicSchema: {
            required: ["getOnline", "getMotion"],
            optional: [],
        },

        optionSchema: {
            onlineValue: { type: "string", default: "Online" },
            offlineValue: { type: "string", default: "Offline" },
            motionDetectedValue: { type: "string", default: "ON" },
            noMotionValue: { type: "string", default: "OFF" },
        },

        validateConfig(config: any): ValidationResult {
            const errors: string[] = [];
            if (!config.name) errors.push("Missing device name");
            if (config.type !== "OccupancySensorDevice") {
                errors.push(`Invalid type: ${config.type}`);
            }
            errors.push(...validateTopics(config, this.topicSchema, config.name || "unknown"));
            config.options = applyOptionDefaults(config, this.optionSchema);
            return createValidationResult(errors);
        },

        createEndpointConfig(config: MotionSensorDeviceConfig): EndpointConfiguration {
            return {
                state: {
                    bridgedDeviceBasicInformation: {
                        nodeLabel: config.name,
                        productName: config.name,
                        productLabel: config.name,
                        serialNumber: `ih8-${config.name.toLowerCase().replace(/\s+/g, "-")}`,
                        reachable: true,
                    },
                    occupancySensing: {
                        occupancy: 0,
                    },
                },
                topics: [config.topics.getOnline, config.topics.getMotion],
            };
        },

        getMatterDeviceType() {
            return () => OccupancySensorDevice.with(BridgedDeviceBasicInformationServer);
        },

        getMatterBehaviors() {
            return [BridgedDeviceBasicInformationServer];
        },
    };
}
```

### Step 2: Register the device

**File**: `src/mqtt/devices/index.ts` (add 2 lines)

```typescript
import { MotionSensorDevice } from "./MotionSensorDevice.js";

// ... existing registrations ...

DeviceRegistry.register("OccupancySensorDevice", MotionSensorDevice.metadata, MotionSensorDevice as any);

// ... existing exports ...

export { MotionSensorDevice } from "./MotionSensorDevice.js";
```

```toml
[[devices]]
type = "OccupancySensorDevice"
name = "Living Room Motion"
topics = { getOnline = "motion/livingroom/LWT", getMotion = "motion/livingroom/state" }
options = { motionDetectedValue = "motion", noMotionValue = "clear" }
```
