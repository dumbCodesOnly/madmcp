// ---------------------------------------------------------------------------
// server.js — HTTP server + MCP bootstrap only.
// To add a new connector: create connectors/<n>/tools.js and register below.
// ---------------------------------------------------------------------------

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { GITHUB_TOKEN, NOTION_TOKEN, MEM0_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, MCP_SHARED_KEY } from "./config.js";
import * as github     from "./connectors/github/tools.js";
import * as resource   from "./connectors/github/resource.js";
import * as notion     from "./connectors/notion/tools.js";
import * as mem0       from "./connectors/mem/tools.js";
import * as fetch      from "./connectors/fetch/tools.js";
import * as cloudflare from "./connectors/cloudflare/tools.js";

// Build the MCP server once at startup and reuse it across all requests.
const mcpServer = new McpServer({
  name: "manufact-mcp-server",
  version: "2.1.0",
});

github.register(mcpServer);
resource.register(mcpServer);
notion.register(mcpServer);
mem0.register(mcpServer);
fetch.register(mcpServer);
cloudflare.register(mcpServer);

// Adding a new connector:
//   import * as myThing from "./connectors/myThing/tools.js";
//   myThing.register(mcpServer);

// Constant-time-ish comparison to avoid trivial timing leaks on the shared key.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Header-only auth. (Previously also accepted the key as a URL path segment
// via /mcp/:key — removed because URLs end up in proxy/CDN/browser logs,
// which is a much bigger leak surface than a header.)
function requireMcpKey(req, res, next) {
  if (!MCP_SHARED_KEY) return next();
  const headerKey = req.get("x-manufact-key");
  if (headerKey && safeEqual(headerKey, MCP_SHARED_KEY)) {
    return next();
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid MCP key" },
    id: null,
  });
}

// Rate limit auth attempts / tool calls on /mcp so a leaked or guessed key
// can't be used to hammer GitHub/Cloudflare/etc, and the key itself can't be
// brute-forced freely. Applied before requireMcpKey so failed-auth attempts
// count against the limit too.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Rate limit exceeded. Try again shortly." },
    id: null,
  },
});

const app = express();
app.use(helmet());
// Raise body size limit from the 100kb default to 10mb so that push_files
// and create_or_update_file can handle large source files without truncation.
app.use(express.json({ limit: "10mb" }));

// Gated behind auth: previously exposed which connectors were configured
// (github/notion/mem0/cloudflare/auth booleans) to anyone with the URL, which
// is free recon for an attacker probing the server. Now requires a valid key,
// same as /mcp. /health stays open and info-free for uptime monitoring.
app.get("/", requireMcpKey, (_req, res) => {
  res.json({
    status: "ok",
    service: "manufact-mcp-server",
    version: "2.1.0",
    configured: {
      github: Boolean(GITHUB_TOKEN),
      notion: Boolean(NOTION_TOKEN),
      mem0:   Boolean(MEM0_API_KEY),
      cloudflare: Boolean(CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID),
      auth:   Boolean(MCP_SHARED_KEY),
    },
  });
});

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

async function handleMcp(req, res) {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

app.post("/mcp", mcpLimiter, requireMcpKey, handleMcp);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`manufact-mcp-server v2.1.0 listening on port ${PORT}`);
  if (!GITHUB_TOKEN)   console.warn("WARNING: GITHUB_TOKEN is not set.");
  if (!NOTION_TOKEN)   console.warn("WARNING: NOTION_TOKEN is not set. Notion tools will fail.");
  if (!MEM0_API_KEY)   console.warn("WARNING: MEM0_API_KEY is not set. Mem0 tools will fail.");
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) console.warn("WARNING: CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set. Cloudflare tools will fail.");
  if (!MCP_SHARED_KEY) console.warn("WARNING: MCP_SHARED_KEY is not set. The /mcp and / endpoints are OPEN to anyone who has the URL.");
});
