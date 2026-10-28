# Example: Adding a New Device Type

This document demonstrates how easy it is to add a new device type to the bridge.

Adding a new device type requires modifying **2 files**:

1. Create new device class file with metadata, extending `BridgedDevice`
2. Register in `src/mqtt/devices/index.ts` (1 line)

## Example: Motion Sensor Device

Here's how you would add a motion sensor device:

### Step 1: Create the device file

**File**: `src/mqtt/devices/MotionSensorDevice.ts`

```typescript
import { OccupancySensorDevice } from "@matter/main/devices/occupancy-sensor";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import type {
    DeviceMetadata,
    EndpointConfiguration,
    ValidationResult,
} from "./metadata.js";
import {
    createValidationResult,
    validateDeviceConfig,
    matchToken,
} from "./metadata.js";
import { BridgedDevice } from "./BridgedDevice.js";

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

/**
 * BridgedDevice handles availability, the live state the MCP tools read, and mirroring
 * into Matter. The endpoint is null when the device's config says matter = false, so only
 * touch it through updateEndpoint(), and only wire Matter handlers when it exists.
 */
export class MotionSensorDevice extends BridgedDevice<MotionSensorDeviceConfig> {
    protected metadata(): DeviceMetadata {
        return MotionSensorDevice.metadata;
    }

    async initialize(): Promise<void> {
        const topics = [this.config.topics.getOnline, this.config.topics.getMotion];
        await this.mqttClient.subscribe(topics);
        // Motion sensors are read-only, so there are no Matter -> MQTT handlers to set up
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

    protected handleMotionState(message: string): void {
        const motionDetected = matchToken(
            message,
            this.config.options.motionDetectedValue,
            this.config.options.noMotionValue
        );
        if (motionDetected === null) {
            console.warn(`[${this.config.name}] Ignoring unrecognized motion value: ${message}`);
            return;
        }

        // DeviceState has no motion field yet; add one to metadata.ts if the MCP tools
        // should report it
        this.updateEndpoint({ occupancySensing: { occupancy: motionDetected ? 1 : 0 } }, "occupancy");
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
            if (config.type !== "OccupancySensorDevice") {
                errors.push(`Invalid type: ${config.type}`);
            }
            errors.push(
                ...validateDeviceConfig(config, this.topicSchema, this.optionSchema, [
                    ["onlineValue", "offlineValue"],
                    ["motionDetectedValue", "noMotionValue"],
                ]).errors
            );
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
                        reachable: false,
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

### Step 3: Add it to the config

`id`, `room`, `kind` and `matter` are required on every device; see the README for all the fields. `kind` is what
the device is to a person, from `DEVICE_KINDS` in `src/types/config.ts`. If none fits, add one there.

```toml
[[devices]]
type = "OccupancySensorDevice"
name = "Living Room Motion"
id = "living_room_motion"
room = "living room"
kind = "sensor"
matter = true
topics = { getOnline = "motion/livingroom/LWT", getMotion = "motion/livingroom/state" }
options = { motionDetectedValue = "motion", noMotionValue = "clear" }
```

### MCP

The device shows up in `list_devices` with its online state straight away. The MCP tools act through the optional
command methods on `BaseDeviceInterface` (`setOn`, `setLight`, `setInput`, `press`) and the device's
`capabilities`. A device that switches implements `setOn` and declares `"onoff"`, and `turn_on`/`turn_off` then
work on it. A new kind of command needs a method there, a capability, and a tool in `src/mcp/tools.ts` backed by
`src/house/House.ts`.
