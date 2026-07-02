// ---------------------------------------------------------------------------
// connectors/cloudflare/r2.js — R2 bucket tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function register(server) {
  server.tool(
    "cf_r2_buckets_list",
    "List r2 buckets in your Cloudflare account",
    {
      cursor: z.string().optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      name_contains: z.string().optional(),
      per_page: z.number().optional(),
      start_after: z.string().optional(),
    },
    async ({ cursor, direction, name_contains, per_page, start_after }) => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (direction) params.set("direction", direction);
      if (name_contains) params.set("name_contains", name_contains);
      if (per_page) params.set("per_page", String(per_page));
      if (start_after) params.set("start_after", start_after);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return textResult(await cfAccountRequest(`/r2/buckets${qs}`));
    }
  );

  server.tool(
    "cf_r2_bucket_get",
    "Get details about a specific R2 bucket",
    { name: z.string() },
    async ({ name }) => textResult(await cfAccountRequest(`/r2/buckets/${name}`))
  );

  server.tool(
    "cf_r2_bucket_create",
    "Create a new r2 bucket in your Cloudflare account",
    { name: z.string() },
    async ({ name }) => textResult(await cfAccountRequest("/r2/buckets", { method: "POST", body: { name } }))
  );

  server.tool(
    "cf_r2_bucket_delete",
    "Delete an R2 bucket",
    { name: z.string() },
    async ({ name }) => textResult(await cfAccountRequest(`/r2/buckets/${name}`, { method: "DELETE" }))
  );
}
