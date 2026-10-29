/**
 * Tests for the MCP tools over real Streamable HTTP, with the SDK's own client.
 *
 * Printer confirmation is the point: it must come from a person through the client's
 * elicitation, for 2026-07-28 clients (input_required) and 2025-era clients (a pushed
 * elicitation/create) alike, and nothing else may stand in for it.
 *
 * The dry run must publish nothing at all, while answering exactly as /mcp would.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { HouseMcp } from "../mcp/tools.js";
import { startMcpHttpServer } from "../mcp/http.js";
import type { McpHttpServer } from "../mcp/http.js";
import { quietLogs, startHarness } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

quietLogs();

const TOKEN = "test-token";

type Era = "modern" | "legacy";
type ElicitAnswer = "accept" | "decline" | "cancel";

interface ClientOptions {
    era: Era;
    /** How the "person" answers; omitted means the client can't elicit at all */
    answer?: ElicitAnswer;
    /** Manual multi-round-trip mode, to inspect and replay input_required results */
    manual?: boolean;
    /** Connect to /mcp/dry-run instead of /mcp */
    dryRun?: boolean;
}

describe("MCP tools", () => {
    let harness: Harness;
    let server: McpHttpServer;
    let url: URL;
    let dryRunUrl: URL;
    const clients: Client[] = [];

    beforeEach(async () => {
        harness = await startHarness();
        server = await startMcpHttpServer(new HouseMcp(harness.house), { host: "127.0.0.1", port: 0, token: TOKEN });
        url = new URL(`http://127.0.0.1:${server.port}/mcp`);
        dryRunUrl = new URL(`http://127.0.0.1:${server.port}/mcp/dry-run`);
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) {
            await client.close().catch(() => {});
        }
        await server.close();
        await harness.close();
    });

    /**
     * Connect a client; the person's prompts are recorded in `prompts`
     */
    async function connect(options: ClientOptions): Promise<{ client: Client; prompts: string[] }> {
        const prompts: string[] = [];
        const client = new Client(
            { name: "test", version: "0" },
            {
                capabilities: options.answer ? { elicitation: { form: {} } } : {},
                ...(options.era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
                ...(options.manual ? { inputRequired: { autoFulfill: false } } : {}),
            }
        );

        if (options.answer) {
            const answer = options.answer;
            client.setRequestHandler("elicitation/create", async request => {
                prompts.push(String(request.params.message));
                return answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: answer };
            });
        }

        await client.connect(new StreamableHTTPClientTransport(options.dryRun ? dryRunUrl : url, {
            authProvider: { token: async () => TOKEN },
        }));
        clients.push(client);
        return { client, prompts };
    }

    /** The text of a tool result's first content block */
    function textOf(result: unknown): string {
        return ((result as { content: Array<{ text: string }> }).content)[0].text;
    }

    async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        return { isError: result.isError === true, text, json: result.isError ? undefined : JSON.parse(text) };
    }

    for (const era of ["modern", "legacy"] as const) {
        describe(`printer turn_off, ${era} client`, () => {
            it("switches the printer off once the person confirms", async () => {
                const { client, prompts } = await connect({ era, answer: "accept" });
                const { json } = await call(client, "turn_off", { devices: ["trident"] });

                assert.equal(prompts.length, 1);
                assert.match(prompts[0], /Switch off Trident\? It powers a 3D printer/);
                assert.deepEqual(json.switched, [{ id: "trident", state: "off", source: "reported" }]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), ["OFF"]);
            });

            it("refuses when the person declines, and still switches the rest", async () => {
                const { client, prompts } = await connect({ era, answer: "decline" });
                const { json } = await call(client, "turn_off", { devices: ["trident", "den light"] });

                assert.equal(prompts.length, 1);
                assert.deepEqual(json.refused, [{ id: "trident", reason: "the person declined" }]);
                assert.deepEqual(json.switched.map((item: { id: string }) => item.id), ["den_light"]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);
            });

            it("refuses when the person cancels", async () => {
                const { client } = await connect({ era, answer: "cancel" });
                const { json } = await call(client, "turn_off", { devices: ["printer"] });

                assert.deepEqual(json.refused, [{ id: "trident", reason: "the person cancelled" }]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);
            });

            it("refuses for a client without elicitation, ignoring a confirmation passed as an argument", async () => {
                const { client } = await connect({ era });
                const { json } = await call(client, "turn_off", { devices: ["trident"], confirm: true, confirmed: true });

                assert.equal(json.refused.length, 1);
                assert.match(json.refused[0].reason, /cannot ask a person to confirm/);
                assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);
            });

            it("asks nothing for room-wide actions, which leave printers alone", async () => {
                const { client, prompts } = await connect({ era, answer: "accept" });
                const { json } = await call(client, "turn_off", { room: "den" });

                assert.equal(prompts.length, 0);
                assert.deepEqual(json.printers_skipped.map((item: { id: string }) => item.id), ["trident", "v0"]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);
            });
        });
    }

    describe("confirmation integrity", () => {
        it("accepts a confirmation once, and only for the printers it was asked about", async () => {
            const { client } = await connect({ era: "modern", answer: "accept", manual: true });
            const accept = { confirm: { action: "accept", content: { confirm: true } } };

            const first = await client.callTool(
                { name: "turn_off", arguments: { devices: ["trident"] } },
                { allowInputRequired: true }
            ) as unknown as { resultType: string; requestState: string };
            assert.equal(first.resultType, "input_required");
            assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);

            // The same answer, but for a request naming another printer as well
            const widened = await client.callTool({
                name: "turn_off",
                arguments: { devices: ["trident", "v0"] },
                inputResponses: accept,
                requestState: first.requestState,
            } as any);
            assert.match(textOf(widened), /does not belong to this request/);
            assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);

            const confirmed = await client.callTool({
                name: "turn_off",
                arguments: { devices: ["trident"] },
                inputResponses: accept,
                requestState: first.requestState,
            } as any);
            assert.deepEqual(JSON.parse(textOf(confirmed)).switched, [{ id: "trident", state: "off", source: "reported" }]);
            assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), ["OFF"]);

            // Replaying the same confirmation must not switch it off again
            harness.fake.power.set("trident", "ON");
            await harness.fake.reportAll();
            await new Promise(resolve => setTimeout(resolve, 50));
            const replayed = await client.callTool({
                name: "turn_off",
                arguments: { devices: ["trident"] },
                inputResponses: accept,
                requestState: first.requestState,
            } as any);
            assert.match(textOf(replayed), /does not belong to this request/);
            assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), ["OFF"]);
        });

        it("rejects a forged request state before the tool runs", async () => {
            const { client } = await connect({ era: "modern", answer: "accept", manual: true });

            await assert.rejects(client.callTool({
                name: "turn_off",
                arguments: { devices: ["trident"] },
                inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
                requestState: "v1.eyJwIjp7fX0.AAAA",
            } as any), /Invalid or expired requestState/);
            assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);
        });
    });

    describe("other tools", () => {
        it("lists devices and reads states", async () => {
            const { client } = await connect({ era: "modern" });

            const tools = await client.listTools();
            assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
                "all_off", "bubble", "get_state", "list_devices", "set_light", "set_tv_input", "turn_off", "turn_on",
            ]);

            const { json: devices } = await call(client, "list_devices");
            assert.equal(devices.length, 10);
            assert.equal(devices.find((device: { id: string }) => device.id === "trident").state.on, true);

            const { json: den } = await call(client, "get_state", { room: "den" });
            assert.deepEqual(den.map((device: { id: string }) => device.id), ["den_light", "reading_lamp", "tv", "trident", "v0", "blup"]);
            assert.deepEqual(harness.fake.published, []);
        });

        it("returns name errors as tool errors with the candidates", async () => {
            const { client } = await connect({ era: "legacy" });
            const { isError, text } = await call(client, "turn_on", { devices: ["lamp"] });

            assert.equal(isError, true);
            assert.match(text, /"lamp" is ambiguous: it could be reading_lamp or lanterns/);
        });

        it("runs all_off, leaving the printers on", async () => {
            const { client } = await connect({ era: "legacy" });
            const { json } = await call(client, "all_off");

            assert.deepEqual(json.printers_skipped.map((item: { id: string }) => item.id), ["trident", "v0"]);
            assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), []);
            assert.equal(harness.fake.power.get("den_light"), "OFF");
        });
    });

    for (const era of ["modern", "legacy"] as const) {
        describe(`dry run, ${era} client`, () => {
            it("publishes nothing, asks no one, and says what it would have done", async () => {
                const { client, prompts } = await connect({ era, answer: "accept", dryRun: true });

                const { json: lights } = await call(client, "turn_off", { room: "den", kind: "light" });
                assert.equal(lights.dry_run, true);
                assert.deepEqual(lights.switched, [
                    { id: "den_light", state: "off", source: "reported" },
                    { id: "reading_lamp", state: "off", source: "reported" },
                ]);
                assert.equal(lights.summary, "In the den: would switch off: den_light, reading_lamp.");

                const { json: all } = await call(client, "all_off", { except: ["lanterns"] });
                assert.equal(all.dry_run, true);
                assert.deepEqual(all.switched.map((item: { id: string }) => item.id), ["den_light", "reading_lamp", "tv"]);
                assert.deepEqual(all.excepted, [{ id: "lanterns", state: "off", online: true }]);
                assert.deepEqual(all.printers_skipped.map((item: { id: string }) => item.id), ["trident", "v0"]);

                const { json: printers } = await call(client, "turn_off", { kind: "printer" });
                assert.equal(prompts.length, 0);
                assert.deepEqual(printers.refused, [
                    { id: "trident", reason: "a person would be asked to confirm; a dry run asks no one" },
                    { id: "v0", reason: "a person would be asked to confirm; a dry run asks no one" },
                ]);
                assert.deepEqual(printers.switched, []);

                const { json: light } = await call(client, "set_light", { device: "nudge", brightness: 40, color: "red" });
                assert.equal(light.dry_run, true);
                assert.equal(light.confirmed, false);
                assert.equal(light.summary, "Would send brightness 40% and color #ff0000 to nudge");

                const { json: input } = await call(client, "set_tv_input", { input: "hdmi2" });
                assert.equal(input.summary, "Would send HDMI2 to tv");
                const { json: bubbles } = await call(client, "bubble");
                assert.equal(bubbles.dry_run, true);

                // Nothing at all, not even late
                await new Promise(resolve => setTimeout(resolve, 100));
                assert.deepEqual(harness.fake.published, []);
                assert.equal(harness.fake.power.get("den_light"), "ON");
                assert.equal(harness.fake.bubbles, 0);
            });
        });
    }

    describe("dry run", () => {
        for (const era of ["modern", "legacy"] as const) {
            it(`names itself as the dry run, to a ${era} client`, async () => {
                const { client: live } = await connect({ era });
                const { client: dry } = await connect({ era, dryRun: true });

                assert.equal(live.getServerVersion()?.name, "ih8homeassistant-house");
                assert.equal(dry.getServerVersion()?.name, "ih8homeassistant-house (dry run)");
            });
        }

        it("serves the same tools and reads as /mcp", async () => {
            const { client: live } = await connect({ era: "modern" });
            const { client: dry } = await connect({ era: "modern", dryRun: true });

            assert.deepEqual((await dry.listTools()).tools, (await live.listTools()).tools);
            assert.deepEqual((await call(dry, "list_devices")).json, (await call(live, "list_devices")).json);
            assert.deepEqual(
                (await call(dry, "get_state", { room: "den" })).json,
                (await call(live, "get_state", { room: "den" })).json
            );
        });

        it("refuses with the same errors as /mcp, word for word", async () => {
            const { client: live } = await connect({ era: "modern" });
            const { client: dry } = await connect({ era: "modern", dryRun: true });

            const badCalls: Array<[string, Record<string, unknown>]> = [
                ["turn_on", { devices: ["lamp"] }],
                ["turn_off", { devices: ["kitchen light"] }],
                ["turn_off", { room: "den", except: ["kitchen light"] }],
                ["all_off", { except: ["kitchen light"] }],
                ["turn_on", { devices: ["tv"], kind: "light" }],
                ["turn_on", {}],
                ["turn_on", { devices: ["blup"] }],
                ["turn_off", { room: "bedroom", kind: "tv" }],
                ["turn_off", { room: "den", except: ["den light", "reading lamp", "tv"] }],
                ["all_off", { except: ["den light", "reading lamp", "tv", "living room light", "lanterns", "nudge", "cooler"] }],
                ["turn_on", { except: ["lanterns"] }],
                ["turn_off", { except: ["lanterns"] }],
                ["turn_off", { kind: "lights" }],
                ["set_light", { device: "den light", brightness: 50 }],
                ["set_tv_input", { input: "HDMI9" }],
            ];
            for (const [name, args] of badCalls) {
                const expected = await call(live, name, args);
                const actual = await call(dry, name, args);
                assert.equal(expected.isError, true, `${name} ${JSON.stringify(args)} should be refused`);
                assert.equal(actual.isError, true);
                assert.equal(actual.text, expected.text);
            }

            await harness.mqttClient.disconnect();
            const expected = await call(live, "turn_on", { room: "den" });
            const actual = await call(dry, "turn_on", { room: "den" });
            assert.match(expected.text, /broker is unavailable/);
            assert.equal(actual.text, expected.text);

            assert.deepEqual(harness.fake.published, []);
        });

        it("returns what /mcp then does, in the same shape", async () => {
            const { client: live } = await connect({ era: "modern" });
            const { client: dry } = await connect({ era: "modern", dryRun: true });

            // Each dry run first, then the same call live from the same state
            for (const [name, args] of [
                ["turn_off", { room: "den", kind: "light", except: ["reading lamp"] }],
                ["all_off", { except: ["lanterns"] }],
                ["turn_on", { devices: ["nudge"] }],
            ] as Array<[string, Record<string, unknown>]>) {
                const { dry_run, summary: drySummary, ...wouldDo } = (await call(dry, name, args)).json;
                const { summary, ...did } = (await call(live, name, args)).json;

                assert.equal(dry_run, true);
                assert.ok(!("dry_run" in did));
                assert.deepEqual(wouldDo, did, `${name} ${JSON.stringify(args)}`);
                assert.equal(drySummary, summary.replace(/\bswitched (on|off)\b/g, "would switch $1"));
            }

            const dryLight = (await call(dry, "set_light", { device: "nudge", brightness: 40 })).json;
            const liveLight = (await call(live, "set_light", { device: "nudge", brightness: 40 })).json;
            assert.deepEqual(Object.keys(dryLight).filter(key => key !== "dry_run"), Object.keys(liveLight));
        });

        it("refuses printers as /mcp does for a client that cannot ask", async () => {
            const { client } = await connect({ era: "modern", dryRun: true });
            const { json } = await call(client, "turn_off", { devices: ["trident"] });

            assert.equal(json.dry_run, true);
            assert.match(json.refused[0].reason, /cannot ask a person to confirm/);
            assert.deepEqual(harness.fake.published, []);
        });
    });

    describe("HTTP", () => {
        it("requires the bearer token", async () => {
            const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
            const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

            const missing = await fetch(url, { method: "POST", headers, body });
            assert.equal(missing.status, 401);

            const wrong = await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body });
            assert.equal(wrong.status, 401);
        });

        it("rejects browser requests", async () => {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${TOKEN}`,
                    origin: "http://evil.example",
                },
                body: "{}",
            });
            assert.equal(response.status, 403);
        });

        it("serves only /mcp and its dry run", async () => {
            const response = await fetch(new URL("/other", url), { headers: { authorization: `Bearer ${TOKEN}` } });
            assert.equal(response.status, 404);
        });

        it("puts the dry run behind the same checks, with sessions of its own", async () => {
            const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
            const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
            assert.equal((await fetch(dryRunUrl, { method: "POST", headers, body: ping })).status, 401);
            assert.equal((await fetch(dryRunUrl, {
                method: "POST",
                headers: { ...headers, authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" },
                body: ping,
            })).status, 403);

            // A 2025-era session opened on the dry run must not be usable on /mcp
            const authorized = { ...headers, authorization: `Bearer ${TOKEN}` };
            const initialized = await fetch(dryRunUrl, {
                method: "POST",
                headers: authorized,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
                }),
            });
            const sessionId = initialized.headers.get("mcp-session-id");
            await initialized.text();
            assert.ok(sessionId);

            const crossed = await fetch(url, {
                method: "POST",
                headers: { ...authorized, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "all_off", arguments: {} } }),
            });
            assert.equal(crossed.status, 404);
            assert.deepEqual(harness.fake.published, []);
        });
    });
});
