/**
 * Streamable HTTP endpoints for the house MCP tools: /mcp, and its dry run at /mcp/dry-run
 *
 * 2026-07-28 clients are served statelessly, one McpServer per request. 2025-era clients
 * get a session each, because their printer confirmations are real server-to-client
 * elicitation requests, and the answer has to come back to the same server instance.
 *
 * The dry run is chosen by URL, not by a tool argument, so a model can never turn it off.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
    WebStandardStreamableHTTPServerTransport,
    createMcpHandler,
    isLegacyRequest,
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { HouseMcp } from "./tools.js";

/** Path the endpoint is served on */
export const MCP_PATH = "/mcp";

/** Path of the dry run: the same tools and checks, publishing nothing */
export const DRY_RUN_PATH = "/mcp/dry-run";

/**
 * Most 2025-era sessions kept at once, per endpoint. Clients that vanish without closing their session
 * would otherwise accumulate; past this the oldest is dropped, and its client reconnects.
 */
const MAX_LEGACY_SESSIONS = 32;

export interface McpHttpOptions {
    host: string;
    port: number;
    /** When set, every request must carry "Authorization: Bearer <token>" */
    token?: string;
}

export interface McpHttpServer {
    /** The port actually bound, which differs from the configured one when that is 0 */
    readonly port: number;
    close(): Promise<void>;
}

/**
 * Start serving the house tools
 */
export async function startMcpHttpServer(houseMcp: HouseMcp, options: McpHttpOptions): Promise<McpHttpServer> {
    // Each path has its own handler and sessions, so a session opened on one is unknown to the other
    const endpoints = new Map([
        [MCP_PATH, serveMcp(() => houseMcp.createServer())],
        [DRY_RUN_PATH, serveMcp(() => houseMcp.createServer({ dryRun: true }))],
    ]);

    const expectedAuthorization = options.token ? digest(`Bearer ${options.token}`) : null;

    const server = createServer((req, res) => {
        void handle(req, res).catch(error => {
            console.error("[MCP] Unhandled request error:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        });
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const endpoint = endpoints.get(path);
        if (endpoint === undefined) {
            res.writeHead(404, { "content-type": "text/plain" })
                .end(`Not found; the MCP endpoints are ${MCP_PATH} and ${DRY_RUN_PATH}\n`);
            return;
        }

        // Browsers always send Origin on these requests and MCP clients don't, so this
        // keeps web pages, including DNS-rebinding ones, from driving the house
        if (req.headers.origin !== undefined) {
            res.writeHead(403, { "content-type": "text/plain" }).end("Browser requests are not allowed\n");
            return;
        }

        if (expectedAuthorization !== null) {
            const given = req.headers.authorization;
            if (given === undefined || !timingSafeEqual(digest(given), expectedAuthorization)) {
                res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" }).end("Unauthorized\n");
                return;
            }
        }

        await endpoint.route(req, res);
    }

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const port = (server.address() as AddressInfo).port;
    console.log(
        `MCP server listening on http://${options.host}:${port}${MCP_PATH}, dry run at ${DRY_RUN_PATH}` +
        (options.token ? " (bearer token required)" : "")
    );

    return {
        port,
        async close() {
            for (const endpoint of endpoints.values()) {
                await endpoint.close();
            }
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

/**
 * One MCP endpoint: stateless for 2026-07-28 clients, a session each for 2025-era ones
 */
function serveMcp(createMcpServer: () => McpServer): {
    route: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    close(): Promise<void>;
} {
    const modern = createMcpHandler(createMcpServer, {
        legacy: "reject",
        onerror: error => console.error("[MCP] Request error:", error.message),
    });

    const legacySessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

    const serveLegacy = async (request: Request): Promise<Response> => {
        const sessionId = request.headers.get("mcp-session-id");
        if (sessionId !== null) {
            const transport = legacySessions.get(sessionId);
            if (transport === undefined) {
                // 404 tells the client to start a new session
                return new Response("Unknown or expired MCP session", { status: 404 });
            }
            return transport.handleRequest(request);
        }

        const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
                legacySessions.set(id, transport);
                if (legacySessions.size > MAX_LEGACY_SESSIONS) {
                    const [oldestId, oldest] = legacySessions.entries().next().value!;
                    legacySessions.delete(oldestId);
                    void oldest.close();
                }
            },
            onsessionclosed: id => {
                legacySessions.delete(id);
            },
        });
        await createMcpServer().connect(transport);
        return transport.handleRequest(request);
    };

    const route = toNodeHandler(
        {
            fetch: async (request, requestOptions) =>
                (await isLegacyRequest(request)) ? serveLegacy(request) : modern.fetch(request, requestOptions),
        },
        { onerror: error => console.error("[MCP] HTTP error:", error.message) }
    );

    return {
        route,
        async close() {
            for (const transport of legacySessions.values()) {
                await transport.close();
            }
            legacySessions.clear();
            await modern.close();
        },
    };
}

/**
 * Hash before comparing, so timingSafeEqual sees equal lengths whatever the client sent
 */
function digest(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}
