// ---------------------------------------------------------------------------
// connectors/cloudflare/kv.js — Workers KV namespace tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function register(server) {
  server.tool(
    "cf_kv_namespaces_list",
    "List all of the KV namespaces in your Cloudflare account",
    {
      page: z.number().optional(),
      per_page: z.number().optional(),
      order: z.enum(["id", "title"]).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
    },
    async ({ page, per_page, order, direction }) => {
      const params = new URLSearchParams();
      if (page) params.set("page", String(page));
      if (per_page) params.set("per_page", String(per_page));
      if (order) params.set("order", order);
      if (direction) params.set("direction", direction);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return textResult(await cfAccountRequest(`/storage/kv/namespaces${qs}`));
    }
  );

  server.tool(
    "cf_kv_namespace_get",
    "Get details of a kv namespace in your Cloudflare account",
    { namespace_id: z.string() },
    async ({ namespace_id }) => textResult(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`))
  );

  server.tool(
    "cf_kv_namespace_create",
    "Create a new kv namespace in your Cloudflare account",
    { title: z.string() },
    async ({ title }) =>
      textResult(await cfAccountRequest("/storage/kv/namespaces", { method: "POST", body: { title } }))
  );

  server.tool(
    "cf_kv_namespace_update",
    "Update the title of a kv namespace in your Cloudflare account",
    { namespace_id: z.string(), title: z.string() },
    async ({ namespace_id, title }) =>
      textResult(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`, { method: "PUT", body: { title } }))
  );

  server.tool(
    "cf_kv_namespace_delete",
    "Delete a kv namespace in your Cloudflare account",
    { namespace_id: z.string() },
    async ({ namespace_id }) =>
      textResult(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`, { method: "DELETE" }))
  );
}
