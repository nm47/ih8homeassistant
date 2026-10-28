/**
 * A fake house on an in-process MQTT broker, for tests and manual runs
 *
 * Nothing here can reach a real device: the broker is aedes, listening on localhost.
 *
 * - Tasmota plugs and switches answer cmnd/<t>/POWER (ON, OFF, TOGGLE, or empty to query)
 *   on stat/<t>/POWER, keep a retained tele/<t>/LWT, and report tele/<t>/STATE on demand.
 * - The TV echoes cmnd/tv/POWER and cmnd/tv/INPUT on tele/tv/STATE, like mqtt_cec.
 * - Nudge answers nudge/command/{power,brightness,color} on nudge/status/...
 * - blüp records its bubbles and answers nothing.
 *
 * Every publish a client makes is recorded, so tests can assert what was never sent.
 *
 * Standalone, for pointing a local bridge and Claude Code at:
 *   node dist/tests/support/fakeHouse.js --port 18830 [--silent v0] [--offline living_room_light]
 *   [--on trident,den_light]
 */

import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { Aedes } from "aedes";

export interface FakeHouseOptions {
    /** Port to listen on; 0 picks a free one */
    port?: number;
    /** Tasmota topics, e.g. "den_light" */
    tasmota: string[];
    /** Tasmota topics that never answer commands (and publish no LWT) */
    silent?: string[];
    /** Tasmota topics whose retained LWT says Offline */
    offline?: string[];
    /** Tasmota topics that start switched on; the rest start off */
    on?: string[];
}

export interface PublishRecord {
    topic: string;
    payload: string;
}

export class FakeHouse {
    /** Every message published by a client, in order */
    readonly published: PublishRecord[] = [];
    /** Tasmota power state by topic */
    readonly power = new Map<string, "ON" | "OFF">();
    /** The TV's last echoed state */
    readonly tv = { POWER: "OFF", INPUT: "HDMI1" };
    /** Nudge's state, as it reports it */
    readonly nudge = { power: "OFF", brightness: "255", color: "#FFFFFF" };
    /** How many times blüp was asked to blow bubbles */
    bubbles = 0;
    /** Tasmota topics that don't answer */
    private readonly silent: Set<string>;

    private constructor(
        private readonly broker: Aedes,
        private readonly server: Server,
        readonly port: number,
        private readonly options: FakeHouseOptions
    ) {
        this.silent = new Set(options.silent ?? []);
    }

    static async start(options: FakeHouseOptions): Promise<FakeHouse> {
        const broker = await Aedes.createBroker();
        const server = createServer(broker.handle);
        await new Promise<void>(resolve => server.listen(options.port ?? 0, "127.0.0.1", resolve));

        const house = new FakeHouse(broker, server, (server.address() as AddressInfo).port, options);
        await house.setUp();
        return house;
    }

    private async setUp(): Promise<void> {
        const offline = new Set(this.options.offline ?? []);
        const on = new Set(this.options.on ?? []);

        for (const topic of this.options.tasmota) {
            this.power.set(topic, on.has(topic) ? "ON" : "OFF");
            if (!this.silent.has(topic)) {
                await this.send(`tele/${topic}/LWT`, offline.has(topic) ? "Offline" : "Online", true);
            }
        }
        await this.send("tele/tv/LWT", "Online", true);
        await this.send("nudge/status/online", "online", true);
        await this.send("blup/status/online", "online", true);

        this.broker.on("publish", (packet, client) => {
            if (client === null) {
                return; // the broker's own or this fake's publishes
            }
            const record = { topic: packet.topic, payload: packet.payload.toString() };
            this.published.push(record);
            void this.answer(record).catch(error => console.error("[fake house]", error));
        });
    }

    /**
     * Stop a Tasmota device answering, as if it hung while its LWT still says Online
     */
    silence(topic: string): void {
        this.silent.add(topic);
    }

    /**
     * Payloads published to a topic, in order
     */
    commandsTo(topic: string): string[] {
        return this.published.filter(record => record.topic === topic).map(record => record.payload);
    }

    /**
     * Publish every Tasmota device's periodic tele STATE, plus the TV's and Nudge's state,
     * as the real devices do every few minutes
     */
    async reportAll(): Promise<void> {
        for (const [topic, state] of this.power) {
            if (!this.silent.has(topic)) {
                await this.send(`tele/${topic}/STATE`, JSON.stringify({ Time: new Date().toISOString(), POWER: state }));
            }
        }
        await this.send("tele/tv/STATE", JSON.stringify(this.tv));
        await this.send("nudge/status/power", this.nudge.power);
        await this.send("nudge/status/brightness", this.nudge.brightness);
        await this.send("nudge/status/color", this.nudge.color);
    }

    private async answer({ topic, payload }: PublishRecord): Promise<void> {
        const tasmota = topic.match(/^cmnd\/([^/]+)\/POWER$/);
        if (tasmota && tasmota[1] !== "tv") {
            const device = tasmota[1];
            if (!this.power.has(device) || this.silent.has(device)) {
                return;
            }
            const command = payload.trim().toUpperCase();
            const current = this.power.get(device)!;
            const next = command === "TOGGLE" ? (current === "ON" ? "OFF" : "ON")
                : command === "ON" || command === "OFF" ? command
                : command === "" ? current
                : null;
            if (next === null) {
                return; // Tasmota ignores what it doesn't understand
            }
            this.power.set(device, next);
            await this.send(`stat/${device}/RESULT`, JSON.stringify({ POWER: next }));
            await this.send(`stat/${device}/POWER`, next);
            return;
        }

        if (topic === "cmnd/tv/POWER" || topic === "cmnd/tv/INPUT") {
            if (topic === "cmnd/tv/POWER") {
                this.tv.POWER = payload;
            } else {
                this.tv.INPUT = payload;
            }
            await this.send("tele/tv/STATE", JSON.stringify(this.tv));
            return;
        }

        const nudge = topic.match(/^nudge\/command\/(power|brightness|color)$/);
        if (nudge) {
            const field = nudge[1] as keyof FakeHouse["nudge"];
            this.nudge[field] = field === "color" ? payload.toUpperCase() : payload;
            await this.send(`nudge/status/${field}`, this.nudge[field]);
            return;
        }

        if (topic === "blup/command/bubble") {
            this.bubbles++;
        }
    }

    private send(topic: string, payload: string, retain = false): Promise<void> {
        return new Promise((resolve, reject) => {
            this.broker.publish(
                { cmd: "publish", topic, payload: Buffer.from(payload), qos: 0, retain, dup: false },
                error => (error ? reject(error) : resolve())
            );
        });
    }

    async close(): Promise<void> {
        await new Promise<void>(resolve => this.broker.close(() => resolve()));
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}

/**
 * Standalone mode
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const option = (name: string): string | undefined => {
        const index = args.indexOf(`--${name}`);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const list = (name: string): string[] => option(name)?.split(",").filter(Boolean) ?? [];

    const house = await FakeHouse.start({
        port: Number(option("port") ?? 18830),
        tasmota: [
            "den_light", "dining_room_light", "closet_light", "living_room_light", "lanterns",
            "reading_lamp", "trident", "v0", "bedroom_overhead", "cooler",
        ],
        silent: list("silent"),
        offline: list("offline"),
        on: list("on"),
    });

    // Report like Tasmota's TelePeriod, but every 20 seconds so a bridge learns states quickly
    const reporter = setInterval(() => void house.reportAll(), 20_000);
    setTimeout(() => void house.reportAll(), 1_000);

    console.log(`Fake house broker on mqtt://127.0.0.1:${house.port}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            clearInterval(reporter);
            console.log("\nCommands received:");
            for (const record of house.published) {
                console.log(`  ${record.topic} ${JSON.stringify(record.payload)}`);
            }
            void house.close().then(() => process.exit(0));
        });
    }
}

if (process.argv[1]?.endsWith("fakeHouse.js")) {
    void main();
}
