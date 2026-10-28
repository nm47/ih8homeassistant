/**
 * Tests for printers being on-only in Matter.
 *
 * Matter cannot ask a person "are you sure?", so a phone or hub must not be able to cut a
 * print with "turn off everything". The printer's OnOff server ignores every off command
 * while the bridge can still mirror the real state from MQTT.
 *
 * Runs a real matter.js node in memory; it is never started, so nothing goes on the network.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { Crypto, Endpoint, Environment, ServerNode, StorageBackendMemory, StorageService } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { NodeJsCrypto } from "@matter/nodejs";
import { OnOffDevice } from "../mqtt/devices/OnOffDevice.js";
import type { OnOffDeviceConfig } from "../mqtt/devices/OnOffDevice.js";

console.warn = () => {};

function plugConfig(name: string, printer: boolean): OnOffDeviceConfig {
    const topic = name.toLowerCase();
    return {
        type: "OnOffPlugInUnitDevice",
        name,
        kind: printer ? "printer" : "light",
        topics: { getOnline: `tele/${topic}/LWT`, getOn: `stat/${topic}/POWER`, setOn: `cmnd/${topic}/POWER` },
        options: { onValue: "ON", offValue: "OFF", onlineValue: "Online", offlineValue: "Offline" },
    };
}

describe("printers in Matter", () => {
    let server: ServerNode;
    let printer: Endpoint;
    let plug: Endpoint;

    before(async () => {
        // A bare environment with only what a node needs: no network, memory storage
        const environment = new Environment("on-only-test");
        environment.set(Crypto, new NodeJsCrypto());
        new StorageService(environment, () => new StorageBackendMemory());

        server = await ServerNode.create({ id: "on-only-test", environment });
        const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
        await server.add(aggregator);

        const add = async (config: OnOffDeviceConfig) => {
            const endpoint = new Endpoint(OnOffDevice.metadata.getMatterDeviceType()(config), {
                id: config.name.toLowerCase(),
                ...OnOffDevice.metadata.createEndpointConfig(config).state,
            } as any);
            await aggregator.add(endpoint);
            return endpoint;
        };

        printer = await add(plugConfig("Trident", true));
        plug = await add(plugConfig("Lamp", false));
    });

    after(async () => {
        await server.close();
    });

    const isOn = (endpoint: Endpoint) => (endpoint.state as any).onOff.onOff as boolean;
    const command = (endpoint: Endpoint, name: string, ...args: unknown[]) =>
        endpoint.act(agent => (agent as any).onOff[name](...args));

    it("ignores off, toggle-while-on and off-with-effect", async () => {
        assert.equal(isOn(printer), true);

        await command(printer, "off");
        assert.equal(isOn(printer), true);

        await command(printer, "toggle");
        assert.equal(isOn(printer), true);

        await command(printer, "offWithEffect", { effectIdentifier: 0, effectVariant: 0 });
        assert.equal(isOn(printer), true);
    });

    it("still mirrors a real off reported over MQTT, and still turns on", async () => {
        await printer.set({ onOff: { onOff: false } } as any);
        assert.equal(isOn(printer), false);

        await command(printer, "on");
        assert.equal(isOn(printer), true);
    });

    it("leaves other plugs switchable", async () => {
        await command(plug, "off");
        assert.equal(isOn(plug), false);
    });
});
