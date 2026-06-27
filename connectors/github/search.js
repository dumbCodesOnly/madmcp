// ---------------------------------------------------------------------------
// connectors/github/search.js — search tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";

export function register(server) {
  server.tool(
    "search_code",
    "Search for code across GitHub repositories.",
    {
      query:    z.string().describe("Search query (e.g. 'VLESS filename:worker.js user:dumbCodesOnly')"),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 10)"),
    },
    async ({ query, per_page = 10 }) => {
      const data = await githubRequest(`/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`);
      if (!data.items?.length) return { content: [{ type: "text", text: "No results found." }] };
      const lines = data.items.map((item) => `📄 ${item.repository.full_name}/${item.path} (${item.html_url})`);
      return { content: [{ type: "text", text: `Found ${data.total_count} result(s), showing ${data.items.length}:\n\n${lines.join("\n")}` }] };
    }
  );
}
