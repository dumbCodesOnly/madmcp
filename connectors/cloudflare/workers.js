// ---------------------------------------------------------------------------
// connectors/cloudflare/workers.js — Workers script inspection tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function register(server) {
  server.tool(
    "cf_workers_list",
    "List all Workers in your Cloudflare account",
    {},
    async () => textResult(await cfAccountRequest("/workers/scripts"))
  );

  server.tool(
    "cf_workers_get_worker",
    "Get the details of the Cloudflare Worker",
    { scriptName: z.string() },
    async ({ scriptName }) => textResult(await cfAccountRequest(`/workers/scripts/${scriptName}/settings`))
  );

  server.tool(
    "cf_workers_get_worker_code",
    "Get the source code of a Cloudflare Worker. Note: This may be a bundled version of the worker.",
    { scriptName: z.string() },
    async ({ scriptName }) => textResult(await cfAccountRequest(`/workers/scripts/${scriptName}`))
  );
}
