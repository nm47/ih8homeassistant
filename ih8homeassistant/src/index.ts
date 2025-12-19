#!/usr/bin/env node
/**
 * ih8homeassistant - MQTT to Matter Bridge
 */

/**
 * Platform setup must be imported first
 * This initializes the Matter.js platform and environment
 */
import "@matter/main/platform";

import { Endpoint, Environment, ServerNode, StorageService, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { ConfigParser } from "./config/ConfigParser.js";
import { MqttClient } from "./mqtt/MqttClient.js";
import { DeviceFactory } from "./mqtt/devices/DeviceFactory.js";
import { DeviceRegistry } from "./mqtt/devices/registry.js";
import type { BaseDeviceInterface } from "./mqtt/devices/metadata.js";
import { join } from "path";
import { existsSync } from "fs";

/**
 * Create a sanitized endpoint ID from device name
 */
function createEndpointId(deviceName: string): string {
    return deviceName.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Main bootstrap function that sets up the Matter bridge
 */
async function bootstrap(): Promise<void> {
    console.log("=== ih8homeassistant - MQTT to Matter Bridge ===\n");

    try {
        // Load configuration - prefer mounted config from /app/config/, fall back to local
        const preferredConfigPath = join(process.cwd(), "config", "config.toml");
        const fallbackConfigPath = join(process.cwd(), "config.toml");

        let configPath: string;
        if (existsSync(preferredConfigPath)) {
            configPath = preferredConfigPath;
            console.log(`Using centralized config from: ${configPath}`);
        } else {
            configPath = fallbackConfigPath;
            console.log(`Using local config from: ${configPath}`);
        }

        const config = ConfigParser.loadFromFile(configPath);
        console.log(`Loaded ${config.devices.length} device(s) from configuration\n`);

        // Set up Matter environment and storage
        const environment = Environment.default;
        const storageService = environment.get(StorageService);
        console.log(`Storage location: ${storageService.location}`);
        console.log('Use --storage-path=NAME to specify different storage location');
        console.log('Use --storage-clear to start with empty storage\n');

        // Create storage context for our bridge configuration
        const deviceStorage = (await storageService.open("ih8homeassistant")).createContext("bridge");

        // Get or create stable configuration values
        const passcode = environment.vars.number("passcode") ?? (await deviceStorage.get("passcode", 20202021));
        const discriminator = environment.vars.number("discriminator") ?? (await deviceStorage.get("discriminator", 3840));
        const vendorId = environment.vars.number("vendorid") ?? (await deviceStorage.get("vendorid", 0xfff1));
        const productId = environment.vars.number("productid") ?? (await deviceStorage.get("productid", 0x8000));
        const port = environment.vars.number("port") ?? 5540;
        const uniqueId = environment.vars.string("uniqueid") ?? (await deviceStorage.get("uniqueid", `ih8ha-${Date.now()}`));

        // Persist configuration
        await deviceStorage.set({
            passcode,
            discriminator,
            vendorid: vendorId,
            productid: productId,
            uniqueid: uniqueId,
        });

        console.log("Bridge Configuration:");
        console.log(`  Passcode: ${passcode}`);
        console.log(`  Discriminator: ${discriminator}`);
        console.log(`  Port: ${port}`);
        console.log(`  Unique ID: ${uniqueId}\n`);

        // Create Matter ServerNode
        console.log("Creating Matter ServerNode...");
        const server = await ServerNode.create({
            id: uniqueId,
            network: {
                port,
            },
            commissioning: {
                passcode,
                discriminator,
            },
            productDescription: {
                name: "iH8HomeAssistant Bridge",
                deviceType: AggregatorEndpoint.deviceType,
            },
            basicInformation: {
                vendorName: "matter-node.js",
                vendorId: VendorId(vendorId),
                nodeLabel: "iH8HomeAssistant Bridge",
                productName: "MQTT to Matter Bridge",
                productLabel: "iH8HomeAssistant",
                productId,
                serialNumber: `ih8ha-${uniqueId}`,
                uniqueId,
            },
        });
        console.log("ServerNode created successfully\n");

        // Create AggregatorEndpoint (bridge container)
        console.log("Creating AggregatorEndpoint...");
        const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
        await server.add(aggregator);
        console.log("AggregatorEndpoint added to server\n");

        // Initialize MQTT client
        console.log("Initializing MQTT client...");
        const mqttClient = new MqttClient(config.broker);

        // Add all devices from configuration
        console.log(`Adding ${config.devices.length} bridged devices:\n`);

        // Track device bridges for MQTT message routing
        const deviceBridges = new Map<string, BaseDeviceInterface>();

        for (const device of config.devices) {
            const endpointId = createEndpointId(device.name);
            console.log(`  [${device.name}]`);
            console.log(`    Type: ${device.type}`);
            console.log(`    Endpoint ID: ${endpointId}`);

            // Get device metadata
            const metadata = DeviceRegistry.getMetadata(device.type);
            if (!metadata) {
                throw new Error(`No metadata found for device type: ${device.type}`);
            }

            // Get Matter device type from metadata
            const DeviceType = metadata.getMatterDeviceType()(device);

            // Get endpoint configuration from metadata
            const metadataConfig = metadata.createEndpointConfig(device);

            // Create the bridged endpoint with ID and state from metadata
            const endpoint = new Endpoint(DeviceType, {
                id: endpointId,
                ...metadataConfig.state,
            } as any);

            // Add the device to the aggregator
            await aggregator.add(endpoint);

            // Create device bridge for MQTT/Matter integration
            const deviceBridge = DeviceFactory.createDevice(device, endpoint, mqttClient);
            deviceBridges.set(device.name, deviceBridge);

            // Set up identify event handlers
            endpoint.events.identify.startIdentifying.on(() => {
                console.log(`[${device.name}] Identify requested - should blink/identify device`);
            });

            endpoint.events.identify.stopIdentifying.on(() => {
                console.log(`[${device.name}] Stop identifying`);
            });

            console.log(`    Status: Added successfully\n`);
        }

        console.log("All devices configured\n");

        // Set up MQTT message routing BEFORE connecting/subscribing
        mqttClient.onMessage((topic, payload) => {
            // Route messages to the appropriate device bridge
            for (const bridge of deviceBridges.values()) {
                bridge.handleMqttMessage(topic, payload);
            }
        });

        // Connect to MQTT broker
        console.log("Connecting to MQTT broker...");
        try {
            await mqttClient.connect();
        } catch (error) {
            console.error("Failed to connect to MQTT broker:");
            console.error(error);
            console.error("\nCannot proceed without MQTT connection.");
            process.exit(1);
        }

        // Initialize all device bridges
        console.log("\nInitializing device bridges...");
        for (const bridge of deviceBridges.values()) {
            await bridge.initialize();
        }

        console.log("All device bridges initialized\n");

        // Start the Matter server
        console.log("Starting Matter server...");
        console.log("The server will generate a QR code for commissioning.\n");
        console.log("=".repeat(60));

        await server.start();

        console.log("\n" + "=".repeat(60));
        console.log("\nMatter bridge is running!");
        console.log(`\n${config.devices.length} devices are now available:\n`);

        config.devices.forEach((device, idx) => {
            console.log(`  ${idx + 1}. ${device.name} (${device.type})`);
        });

        console.log("\nNext steps:");
        console.log("  1. Scan the QR code with a Matter controller (Apple Home, Google Home, etc.)");
        console.log("  2. Complete the pairing process");
        console.log("  3. All devices should appear in your controller");
        console.log("  4. Control devices through Matter - changes will sync to MQTT");
        console.log("  5. Control devices through MQTT - changes will sync to Matter\n");

        console.log("Press Ctrl+C to stop the bridge\n");

        // Handle graceful shutdown
        process.on("SIGINT", async () => {
            console.log("\n\nShutting down gracefully...");
            await mqttClient.disconnect();
            process.exit(0);
        });

    } catch (error) {
        console.error("\nFailed to start Matter bridge:");
        console.error(error);
        process.exit(1);
    }
}

// Run the bootstrap function
bootstrap().catch(error => {
    console.error("Unexpected error:", error);
    process.exit(1);
});
