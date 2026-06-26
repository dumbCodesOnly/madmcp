// ---------------------------------------------------------------------------
// connectors/mem/tools.js
// ---------------------------------------------------------------------------

import { z } from "zod";
import { memRequest } from "./client.js";

export function register(server) {

  server.tool(
    "mem_list",
    "List recent mems from your Mem workspace.",
    {
      limit: z.number().optional().describe("Number of mems to return (default: 20)"),
    },
    async ({ limit = 20 }) => {
      const data = await memRequest(`/mems?limit=${limit}`);
      const mems = data.mems || data.items || data || [];
      if (!mems.length) return { content: [{ type: "text", text: "No mems found." }] };
      const lines = mems.map((m) => {
        const preview = (m.content || m.markdown || "").slice(0, 80).replace(/\n/g, " ");
        return `ID: ${m.id}\n  ${preview}${preview.length >= 80 ? "…" : ""}\n  Created: ${m.created_at?.slice(0, 10) || "unknown"}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "mem_get",
    "Get the full content of a specific mem by ID.",
    {
      mem_id: z.string().describe("The mem ID (from mem_list or mem_search)"),
    },
    async ({ mem_id }) => {
      const m    = await memRequest(`/mems/${mem_id}`);
      const text =
        `ID: ${m.id}\n` +
        `Created: ${m.created_at?.slice(0, 10) || "unknown"} | Updated: ${m.updated_at?.slice(0, 10) || "unknown"}\n\n` +
        (m.content || m.markdown || "(no content)");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "mem_create",
    "Create a new mem in your Mem workspace.",
    {
      content: z.string().describe("The content of the mem (markdown supported)"),
    },
    async ({ content }) => {
      const data = await memRequest("/mems", { method: "POST", body: { content } });
      return { content: [{ type: "text", text: `Created mem (ID: ${data.id}).\nCreated: ${data.created_at?.slice(0, 10) || "unknown"}` }] };
    }
  );

  server.tool(
    "mem_search",
    "Search mems in your Mem workspace.",
    {
      query: z.string().describe("Search query string"),
      limit: z.number().optional().describe("Number of results to return (default: 10)"),
    },
    async ({ query, limit = 10 }) => {
      const data = await memRequest("/mems/search", { method: "POST", body: { query, limit } });
      const mems = data.mems || data.items || data || [];
      if (!mems.length) return { content: [{ type: "text", text: "No mems found matching your query." }] };
      const lines = mems.map((m) => {
        const preview = (m.content || m.markdown || "").slice(0, 100).replace(/\n/g, " ");
        return `ID: ${m.id}\n  ${preview}${preview.length >= 100 ? "…" : ""}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "mem_update",
    "Update (overwrite) the content of an existing mem.",
    {
      mem_id:  z.string().describe("The mem ID to update"),
      content: z.string().describe("New content for the mem (replaces existing content)"),
    },
    async ({ mem_id, content }) => {
      const data = await memRequest(`/mems/${mem_id}`, { method: "PATCH", body: { content } });
      return { content: [{ type: "text", text: `Updated mem (ID: ${data.id || mem_id}).\nUpdated: ${data.updated_at?.slice(0, 10) || "unknown"}` }] };
    }
  );
}
