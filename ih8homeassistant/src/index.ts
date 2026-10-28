#!/usr/bin/env node
/**
 * ih8homeassistant - MQTT to Matter Bridge
 */

/**
 * Platform setup must be imported first
 * This initializes the Matter.js platform and environment
 */
import "@matter/main/platform";

import { CommissioningServer, Endpoint, Environment, ServerNode, StorageService, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { ConfigParser } from "./config/ConfigParser.js";
import { assertUniqueDevices, createEndpointId } from "./config/deviceIds.js";
import { MqttClient } from "./mqtt/MqttClient.js";
import { DeviceFactory } from "./mqtt/devices/DeviceFactory.js";
import { DeviceRegistry } from "./mqtt/devices/registry.js";
import type { BaseDeviceInterface } from "./mqtt/devices/metadata.js";
import { House } from "./house/House.js";
import type { HouseDevice } from "./house/House.js";
import { HouseMcp } from "./mcp/tools.js";
import { startMcpHttpServer } from "./mcp/http.js";
import type { McpHttpServer } from "./mcp/http.js";
import { join } from "path";
import { existsSync } from "fs";

/**
 * Re-arm well inside matter.js's 900s DEVICE_ANNOUNCEMENT_DURATION_MS
 */
const COMMISSIONING_KEEPALIVE_MS = 10 * 60 * 1000;

/**
 * Hard deadline for graceful shutdown.
 *
 * Docker's default stop_grace_period is 10s, so this must fire first to be of any use.
 */
const SHUTDOWN_DEADLINE_MS = 8000;

/**
 * Commissioning behavior that can re-open the pairing window quietly
 */
class BridgeCommissioningServer extends CommissioningServer {
    /**
     * Set only for the duration of a keep-alive refresh, so the periodic re-arm does not
     * re-print the QR code and pairing credentials every cycle. Startup and matter.js's own
     * post-factory-reset announcement still get the full block.
     */
    #suppressPairingCodeLog = false;

    /**
     * Re-arm the commissioning window without re-announcing the pairing credentials
     */
    refreshCommissioning(): void {
        this.#suppressPairingCodeLog = true;
        try {
            this.enterCommissionableMode();
        } finally {
            this.#suppressPairingCodeLog = false;
        }
    }

    protected override initiateCommissioning(): void {
        if (this.#suppressPairingCodeLog) {
            return;
        }
        super.initiateCommissioning();
    }
}

/**
 * matter.js stops commissioning announcements 15 minutes after they start and never
 * restarts them. Re-arm on a timer so the printed QR code stays valid until the bridge is
 * actually commissioned.
 */
function keepCommissioningWindowOpen(server: ServerNode): NodeJS.Timeout {
    const timer = setInterval(() => {
        void (async () => {
            // Skipped while commissioned; resumes automatically if the node is later
            // decommissioned, since matter.js factory-resets and comes back uncommissioned
            if (!server.lifecycle.isOnline || server.lifecycle.isCommissioned) {
                return;
            }

            try {
                await server.act(agent => agent.get(BridgeCommissioningServer).refreshCommissioning());
                // Advertising is asynchronous and swallows its own errors, so this only
                // reports that the re-arm was requested - not that it succeeded
                console.log("Commissioning window re-arm requested");
            } catch (error) {
                console.error("Failed to request commissioning window re-arm:", error);
            }
        })();
    }, COMMISSIONING_KEEPALIVE_MS);

    timer.unref();
    return timer;
}

/**
 * Install idempotent SIGINT/SIGTERM handling
 *
 * Docker sends SIGTERM, which the old SIGINT-only handler ignored entirely. A second signal
 * must not re-enter cleanup, and cleanup must not outlast Docker's grace period.
 */
function installShutdownHandlers(cleanup: () => Promise<void>): void {
    let shuttingDown = false;

    const shutdown = (signal: string): void => {
        if (shuttingDown) {
            console.log(`\nAlready shutting down, ignoring ${signal}`);
            return;
        }
        shuttingDown = true;

        console.log(`\n\nReceived ${signal}, shutting down gracefully...`);

        const deadline = setTimeout(() => {
            console.error("Shutdown timed out, forcing exit");
            process.exit(1);
        }, SHUTDOWN_DEADLINE_MS);

        void cleanup()
            .then(() => {
                console.log("Shutdown complete");
                clearTimeout(deadline);
                process.exit(0);
            })
            .catch(error => {
                console.error("Error during shutdown:", error);
                clearTimeout(deadline);
                process.exit(1);
            });
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
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

        assertUniqueDevices(config.devices.filter(device => device.matter));

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
        const server = await ServerNode.create(ServerNode.RootEndpoint.with(BridgeCommissioningServer), {
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
        const readOnly = process.env.IH8_MQTT_READ_ONLY === "1";
        if (readOnly) {
            console.warn("IH8_MQTT_READ_ONLY=1: every MQTT publish will be refused\n");
        }
        const mqttClient = new MqttClient(config.broker, { readOnly });

        // Add all devices from configuration
        console.log(`Adding ${config.devices.length} devices:\n`);

        // Track device bridges for MQTT message routing, keyed by device id
        const deviceBridges = new Map<string, BaseDeviceInterface>();
        const houseDevices: HouseDevice[] = [];

        for (const device of config.devices) {
            console.log(`  [${device.name}]`);
            console.log(`    Type: ${device.type}`);
            console.log(`    Id: ${device.id}, room: ${device.room}, kind: ${device.kind}`);

            if (!device.matter) {
                // Not in Matter: the bridge still keeps its state for the MCP tools
                const deviceBridge = DeviceFactory.createDevice(device, null, mqttClient);
                deviceBridges.set(device.id, deviceBridge);
                houseDevices.push({ config: device, bridge: deviceBridge });
                console.log(`    Matter: not exposed\n`);
                continue;
            }

            const endpointId = createEndpointId(device.name);
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
            deviceBridges.set(device.id, deviceBridge);
            houseDevices.push({ config: device, bridge: deviceBridge });

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

        // Surface broker outages in the controller instead of leaving stale values
        mqttClient.onConnectionChange(connected => {
            if (connected) {
                return;
            }
            console.warn("MQTT broker unavailable - marking all devices unreachable and their state unknown");
            for (const bridge of deviceBridges.values()) {
                bridge.handleBrokerLost();
            }
        });

        // The MCP tools share the device bridges, and so their live state. Started before
        // the broker wait, so a broker outage gets "broker unavailable" answers rather than
        // no server. A failure here must not take Matter down with it.
        const house = new House(houseDevices, mqttClient, config.mcp.confirmTimeoutMs);
        let mcpServer: McpHttpServer | null = null;
        try {
            mcpServer = await startMcpHttpServer(new HouseMcp(house), config.mcp);
        } catch (error) {
            console.error("Failed to start the MCP server; continuing without it:", error);
        }

        // Connect to the MQTT broker. This retries indefinitely and resolves on the first
        // successful connection, so a broker that is down at startup delays device
        // subscriptions rather than killing the process.
        console.log("Connecting to MQTT broker...");
        const mqttReady = mqttClient.connect();

        // Start the Matter server before waiting on the broker, so the bridge stays
        // discoverable and controllable even during a broker outage
        console.log("Starting Matter server...");
        console.log("The server will generate a QR code for commissioning.\n");
        console.log("=".repeat(60));

        await server.start();

        // Keep the pairing window open so the QR code above stays scannable
        const commissioningKeepAlive = keepCommissioningWindowOpen(server);

        // Registered before the broker wait below, so Ctrl-C and docker stop are handled
        // even while the broker is unreachable
        installShutdownHandlers(async () => {
            clearInterval(commissioningKeepAlive);
            await mcpServer?.close();
            for (const bridge of deviceBridges.values()) {
                await bridge.close();
            }
            await mqttClient.disconnect();
            await server.close();
        });

        // Subscriptions need a live connection; mqtt.js reissues them on later reconnects
        await mqttReady;

        console.log("\nInitializing device bridges...");
        for (const bridge of deviceBridges.values()) {
            await bridge.initialize();
        }

        console.log("All device bridges initialized\n");

        console.log("\n" + "=".repeat(60));
        console.log("\nMatter bridge is running!");
        console.log(`\n${config.devices.length} devices are now available:\n`);

        config.devices.forEach((device, idx) => {
            const exposure = device.matter ? (device.kind === "printer" ? "Matter, on-only" : "Matter") : "MCP only";
            console.log(`  ${idx + 1}. ${device.name} (${device.type}; ${exposure})`);
        });

        console.log("\nNext steps:");
        console.log("  1. Scan the QR code with a Matter controller (Apple Home, Google Home, etc.)");
        console.log("  2. Complete the pairing process");
        console.log("  3. All devices should appear in your controller");
        console.log("  4. Control devices through Matter - changes will sync to MQTT");
        console.log("  5. Control devices through MQTT - changes will sync to Matter\n");

        console.log("Press Ctrl+C to stop the bridge\n");

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
