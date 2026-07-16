// ---------------------------------------------------------------------------
// connectors/github/search.js — search tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";

export function register(server) {
  server.tool(
    "search_issues",
    "Search issues and pull requests across GitHub using GitHub's issue-search syntax (e.g. 'label:bounty is:issue is:open stars:>100 -repo:owner/name -org:someorg'). Returns issue/PR title, repo, state, labels, assignee, created date, and URL for each result — useful for cross-repo discovery like bounty hunting or good-first-issue scanning, which list_issues (single-repo) can't do.",
    {
      query:    z.string().describe("GitHub issue-search query string using standard qualifiers: label:, is:issue, is:pr, is:open, is:closed, stars:>N, org:, repo:, -repo: (exclude), -org: (exclude), created:, assignee:, no:assignee, etc. Combine with spaces (AND). e.g. 'label:bounty is:issue is:open stars:>100 -org:mergeos-bounties'"),
      sort:     z.enum(["created", "updated", "comments"]).optional().describe("Sort field (default: best-match relevance if omitted)"),
      order:    z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 20)"),
    },
    async ({ query, sort, order = "desc", per_page = 20 }) => {
      let path = `/search/issues?q=${encodeURIComponent(query)}&order=${order}&per_page=${per_page}`;
      if (sort) path += `&sort=${sort}`;
      const data = await githubRequest(path);
      if (!data.items?.length) return { content: [{ type: "text", text: "No results found." }] };
      const lines = data.items.map((item) => {
        const kind = item.pull_request ? "PR" : "Issue";
        const labels = item.labels?.length ? ` [${item.labels.map((l) => l.name).join(", ")}]` : "";
        const assignee = item.assignee ? ` (assigned: ${item.assignee.login})` : " (unassigned)";
        return `${kind} #${item.number} [${item.state}] ${item.title}${labels}${assignee}\n  ${item.repository_url.replace("https://api.github.com/repos/", "")} | created ${item.created_at.slice(0, 10)} | ${item.html_url}`;
      });
      return { content: [{ type: "text", text: `Found ${data.total_count} total result(s) (GitHub search caps at 1000), showing ${data.items.length}:\n\n${lines.join("\n\n")}` }] };
    }
  );

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
