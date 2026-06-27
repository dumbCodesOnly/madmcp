// ---------------------------------------------------------------------------
// connectors/github/actions.js — GitHub Actions / CI tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "list_workflow_runs",
    "List recent GitHub Actions workflow runs for a repository.",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      workflow_id: z.string().optional().describe("Workflow file name or ID (e.g. 'ci.yml'). Omit for all workflows."),
      branch:      z.string().optional().describe("Filter by branch name"),
      status:      z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]).optional().describe("Filter by run status"),
      per_page:    z.number().optional().describe("Number of runs to return, max 100 (default: 10)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, workflow_id, branch, status, per_page = 10 }) => {
      const query = new URLSearchParams({ per_page: String(per_page) });
      if (branch) query.set("branch", branch);
      if (status) query.set("status", status);
      const endpoint = workflow_id
        ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/runs?${query}`
        : `/repos/${owner}/${repo}/actions/runs?${query}`;
      const data = await githubRequest(endpoint);
      const runs = data.workflow_runs;
      if (!runs?.length) return { content: [{ type: "text", text: "No workflow runs found." }] };
      const icon  = (s, c) => s === "in_progress" ? "🔄" : s === "queued" || s === "waiting" ? "⏳" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "cancelled" ? "🚫" : "⚪";
      const lines = runs.map((r) =>
        `${icon(r.status, r.conclusion)} #${r.run_number} — ${r.name} (${r.head_branch})\n` +
        `  Status: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""} | Triggered: ${r.event} | ${r.created_at.slice(0, 10)}\n` +
        `  ${r.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "get_workflow_run_logs",
    "Get the logs summary for a specific GitHub Actions workflow run.",
    {
      owner:  z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:   z.string().describe("Repository name"),
      run_id: z.number().describe("Workflow run ID (from list_workflow_runs)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, run_id }) => {
      const run      = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}`);
      const jobsData = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
      const jobs     = jobsData.jobs || [];
      const icon     = (s, c) => s === "in_progress" ? "🔄" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "cancelled" ? "🚫" : "⚪";
      const jobLines = jobs.map((j) => {
        const steps = j.steps
          ?.filter((s) => s.conclusion !== "success")
          .map((s) => `      ${icon(s.status, s.conclusion)} Step ${s.number}: ${s.name} [${s.conclusion || s.status}]`)
          .join("\n") || "";
        return `  ${icon(j.status, j.conclusion)} Job: ${j.name} [${j.conclusion || j.status}]\n${steps}`;
      });
      const text =
        `Run #${run.run_number}: ${run.name}\n` +
        `Status: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}\n` +
        `Branch: ${run.head_branch} | Commit: ${run.head_sha.slice(0, 7)}\n` +
        `Triggered by: ${run.event} | Started: ${run.created_at.slice(0, 10)}\n\n` +
        `Jobs (${jobs.length}):\n${jobLines.join("\n\n")}\n\n` +
        `Full logs: ${run.html_url}`;
      return { content: [{ type: "text", text }] };
    }
  );
}
