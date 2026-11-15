/**
 * A frozen house for benches: the real House and its MCP server on the fake house, in the
 * state given on the command line
 *
 * Nothing here can reach a real device: the broker is the fake house's, on localhost, and
 * Matter is never started. /mcp/dry-run answers exactly as the real dry run does, from that
 * state; a dry run publishes nothing, so the state never changes. /mcp is served as well and
 * switches only the fake devices.
 *
 *   node dist/tests/support/frozenHouse.js --devices devices.toml [--port 18540]
 *       [--on den_light,tv] [--offline living_room_light] [--silent v0] [--tv-input HDMI3]
 *       [--now 2026-11-08T20:00:00-06:00]
 *
 * --devices is a TOML file of [[devices]] blocks, as in config.toml, and nothing else. A
 * device named by --on starts on and the rest start off; an --offline one says so in its
 * LWT; a --silent one never reports or answers, like a plug that isn't there. With --now the
 * process's clock starts at that time, so a report's reported_at agrees with the time a bench
 * tells its model. Prints "ready" and the address once every device that reports has been
 * heard from, and exits non-zero if one hasn't within five seconds.
 */

import { readFileSync } from "node:fs";
import { ConfigParser } from "../../config/ConfigParser.js";
import { MqttClient } from "../../mqtt/MqttClient.js";
import { DeviceFactory } from "../../mqtt/devices/DeviceFactory.js";
import { House } from "../../house/House.js";
import type { HouseDevice } from "../../house/House.js";
import { HouseMcp } from "../../mcp/tools.js";
import { startMcpHttpServer } from "../../mcp/http.js";
import { FakeHouse } from "./fakeHouse.js";
import { waitFor } from "./harness.js";

/** The broker's port is replaced by the fake house's once that is listening */
const BROKER = `[broker]\nhost = "127.0.0.1"\nport = 1\n\n`;

/**
 * Make this process's clock read `start` now and run on from there. Timers are untouched.
 */
function startClockAt(start: string): void {
    const Real = Date;
    const ahead = Real.now() - new Real(start).getTime();
    if (Number.isNaN(ahead)) {
        throw new Error(`--now: "${start}" isn't a time`);
    }
    class Shifted extends Real {
        constructor(...given: unknown[]) {
            super(...((given.length ? given : [Real.now() - ahead]) as [number]));
        }
        static override now(): number {
            return Real.now() - ahead;
        }
    }
    globalThis.Date = Shifted as DateConstructor;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const option = (name: string): string | undefined => {
        const index = args.indexOf(`--${name}`);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const list = (name: string): string[] => option(name)?.split(",").filter(Boolean) ?? [];
    const now = option("now");
    if (now) {
        startClockAt(now);
    }

    const file = option("devices");
    if (!file) {
        throw new Error("--devices FILE is required");
    }
    const config = ConfigParser.parse(BROKER + readFileSync(file, "utf8"));

    // The fake house knows a Tasmota device by its topic, the TV and Nudge by name
    const tasmota = new Map<string, string>();
    for (const device of config.devices) {
        const topic = /^cmnd\/([^/]+)\/POWER$/.exec(String(device.topics.setOn ?? ""))?.[1];
        if (topic) {
            tasmota.set(device.id, topic);
        }
    }
    const [on, offline, silent] = [list("on"), list("offline"), list("silent")];
    for (const id of on) {
        if (!tasmota.has(id) && id !== "tv" && id !== "nudge") {
            throw new Error(`--on: "${id}" isn't a device the fake house can switch on`);
        }
    }
    for (const id of [...offline, ...silent]) {
        if (!tasmota.has(id)) {
            throw new Error(`--offline and --silent take Tasmota devices, and "${id}" isn't one`);
        }
    }
    const topics = (ids: string[]): string[] => ids.flatMap(id => tasmota.get(id) ?? []);

    const fake = await FakeHouse.start({
        tasmota: [...tasmota.values()],
        on: topics(on),
        offline: topics(offline),
        silent: topics(silent),
    });
    fake.tv.POWER = on.includes("tv") ? "ON" : "OFF";
    fake.tv.INPUT = option("tv-input") ?? fake.tv.INPUT;
    fake.nudge.power = on.includes("nudge") ? "ON" : "OFF";

    const mqttClient = new MqttClient({ ...config.broker, port: fake.port });
    const devices: HouseDevice[] = config.devices.map(device => ({
        config: device,
        bridge: DeviceFactory.createDevice(device, null, mqttClient),
    }));
    mqttClient.onMessage((topic, payload) => {
        for (const { bridge } of devices) {
            bridge.handleMqttMessage(topic, payload);
        }
    });
    await mqttClient.connect();
    for (const { bridge } of devices) {
        await bridge.initialize();
    }

    // A silent device never reports, and one with no state topic has no on or off to report
    await fake.reportAll();
    await waitFor(() => devices.every(({ config: device, bridge }) =>
        silent.includes(device.id)
        || !("getOn" in device.topics || "getState" in device.topics)
        || (bridge.state.online !== null && bridge.state.on !== null)
    ), 5000);

    const house = new House(devices, mqttClient, config.mcp.confirmTimeoutMs);
    const server = await startMcpHttpServer(new HouseMcp(house), {
        host: "127.0.0.1",
        port: Number(option("port") ?? 0),
    });
    console.log(`ready http://127.0.0.1:${server.port}/mcp/dry-run`);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            void (async () => {
                await server.close();
                for (const { bridge } of devices) {
                    await bridge.close();
                }
                await mqttClient.disconnect();
                await fake.close();
                process.exit(0);
            })();
        });
    }
}

if (process.argv[1]?.endsWith("frozenHouse.js")) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
