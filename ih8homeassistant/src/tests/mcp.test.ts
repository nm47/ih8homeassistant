/**
 * Tests for the MCP tools over real Streamable HTTP, with the SDK's own client.
 *
 * Printer confirmation is the point: it must come from a person through the client's
 * elicitation, for 2026-07-28 clients (input_required) and 2025-era clients (a pushed
 * elicitation/create) alike, and nothing else may stand in for it.
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
}

describe("MCP tools", () => {
    let harness: Harness;
    let server: McpHttpServer;
    let url: URL;
    const clients: Client[] = [];

    beforeEach(async () => {
        harness = await startHarness();
        server = await startMcpHttpServer(new HouseMcp(harness.house), { host: "127.0.0.1", port: 0, token: TOKEN });
        url = new URL(`http://127.0.0.1:${server.port}/mcp`);
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

        await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => TOKEN } }));
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

        it("serves only /mcp", async () => {
            const response = await fetch(new URL("/other", url), { headers: { authorization: `Bearer ${TOKEN}` } });
            assert.equal(response.status, 404);
        });
    });
});
