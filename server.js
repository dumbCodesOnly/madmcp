import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
//
// GITHUB_TOKEN must be set as an environment variable on the Manufact server
// (Manufact dashboard -> server settings -> environment variables, or passed
// via `env` on deploy/update_server). It should be a GitHub Personal Access
// Token scoped to only the repos you want this server to touch. Never commit
// the token to the repo itself.
//
// NOTION_TOKEN  — Notion integration token (starts with "secret_")
// MEM_API_KEY   — Mem API key
// ---------------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API = "https://api.github.com";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const MEM_API_KEY = process.env.MEM_API_KEY;
const MEM_API = "https://api.mem.ai/v0";

// Default repo owner to use when a tool call omits `owner`. Set via env var
// on the Manufact server, or hardcode a fallback string below.
const DEFAULT_OWNER = process.env.DEFAULT_OWNER || "dumbCodesOnly";

function assertConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it as an environment variable on the Manufact server."
    );
  }
}

async function githubRequest(path, { method = "GET", body, accept } = {}) {
  assertConfigured();
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "github-mcp-server",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const message =
      (data && (data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`GitHub API error (${res.status}): ${message}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------
async function notionRequest(path, { method = "GET", body } = {}) {
  if (!NOTION_TOKEN) {
    throw new Error("NOTION_TOKEN is not set. Add it as an environment variable on the Manufact server.");
  }
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data && (data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`Notion API error (${res.status}): ${message}`);
  }
  return data;
}

// Extract plain text from Notion rich_text arrays
function notionRichTextToString(richText = []) {
  return richText.map((t) => t.plain_text || "").join("");
}

// Extract page title from Notion page object
function notionPageTitle(page) {
  const titleProp = Object.values(page.properties || {}).find(
    (p) => p.type === "title"
  );
  return titleProp ? notionRichTextToString(titleProp.title) : "(untitled)";
}

// Flatten Notion blocks to readable text (one level deep)
function notionBlocksToText(blocks = []) {
  return blocks
    .map((b) => {
      const type = b.type;
      const block = b[type];
      if (!block) return "";
      const text = notionRichTextToString(block.rich_text || []);
      if (type === "heading_1") return `# ${text}`;
      if (type === "heading_2") return `## ${text}`;
      if (type === "heading_3") return `### ${text}`;
      if (type === "bulleted_list_item") return `• ${text}`;
      if (type === "numbered_list_item") return `1. ${text}`;
      if (type === "to_do") return `[${block.checked ? "x" : " "}] ${text}`;
      if (type === "code") return `\`\`\`${block.language || ""}\n${text}\n\`\`\``;
      if (type === "divider") return "---";
      if (type === "paragraph") return text;
      return text;
    })
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Mem helpers
// ---------------------------------------------------------------------------
async function memRequest(path, { method = "GET", body } = {}) {
  if (!MEM_API_KEY) {
    throw new Error("MEM_API_KEY is not set. Add it as an environment variable on the Manufact server.");
  }
  const res = await fetch(`${MEM_API}${path}`, {
    method,
    headers: {
      Authorization: `ApiAccessToken ${MEM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data && (data.message || data.error || JSON.stringify(data))) || res.statusText;
    throw new Error(`Mem API error (${res.status}): ${message}`);
  }
  return data;
}

function toBase64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

function fromBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf-8");
}

// ---------------------------------------------------------------------------
// MCP server definition
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({
    name: "manufact-mcp-server",
    version: "1.1.0",
  });

  // -------------------------------------------------------------------------
  // File & directory tools
  // -------------------------------------------------------------------------

  server.tool(
    "read_file",
    "Read a file's contents from a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo, e.g. 'src/server.js'"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, ref }) => {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const data = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
      );
      if (Array.isArray(data)) {
        return {
          content: [
            {
              type: "text",
              text: `"${path}" is a directory, not a file. Use list_directory instead.`,
            },
          ],
          isError: true,
        };
      }
      const fileContent = fromBase64(data.content);
      return {
        content: [{ type: "text", text: fileContent }],
      };
    }
  );

  server.tool(
    "list_directory",
    "List files and folders at a path in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      path: z.string().optional().describe("Directory path within the repo (default: repo root)"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path = "", ref }) => {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const data = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
      );
      const items = Array.isArray(data) ? data : [data];
      const lines = items.map(
        (item) => `${item.type === "dir" ? "📁" : "📄"} ${item.path}`
      );
      return {
        content: [{ type: "text", text: lines.join("\n") || "(empty)" }],
      };
    }
  );

  server.tool(
    "get_file_tree",
    "Recursively list all files and folders in a GitHub repository (full tree).",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, ref }) => {
      let treeSha;
      if (ref) {
        try {
          const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
          treeSha = refData.object.sha;
        } catch {
          treeSha = ref;
        }
      } else {
        const repoData = await githubRequest(`/repos/${owner}/${repo}`);
        const branchData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`);
        treeSha = branchData.object.sha;
      }

      const data = await githubRequest(
        `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`
      );

      const lines = data.tree.map(
        (item) => `${item.type === "tree" ? "📁" : "📄"} ${item.path}`
      );

      const truncatedNote = data.truncated ? "\n\n⚠️ Tree was truncated (repo too large for full listing)." : "";
      return {
        content: [
          {
            type: "text",
            text: lines.join("\n") + truncatedNote || "(empty repository)",
          },
        ],
      };
    }
  );

  server.tool(
    "create_or_update_file",
    "Create a new file or update an existing file's contents in a GitHub repository, committing the change directly to a branch.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo, e.g. 'src/server.js'"),
      content: z.string().describe("The full new content of the file (plain text, not base64)"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, content, message, branch }) => {
      let sha;
      try {
        const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
        const existing = await githubRequest(
          `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
        );
        sha = existing.sha;
      } catch {
        // File doesn't exist yet — that's fine, we're creating it.
      }

      const result = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
        {
          method: "PUT",
          body: {
            message,
            content: toBase64(content),
            branch,
            sha,
          },
        }
      );

      return {
        content: [
          {
            type: "text",
            text: `${sha ? "Updated" : "Created"} ${path} in ${owner}/${repo} (commit ${result.commit.sha.slice(0, 7)}).`,
          },
        ],
      };
    }
  );

  server.tool(
    "delete_file",
    "Delete a file from a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, message, branch }) => {
      const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
      );
      await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "DELETE",
        body: { message, sha: existing.sha, branch },
      });
      return {
        content: [{ type: "text", text: `Deleted ${path} from ${owner}/${repo}.` }],
      };
    }
  );

  server.tool(
    "rename_file",
    "Rename or move a file in a GitHub repository (copies content to new path and deletes the old one).",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      old_path: z.string().describe("Current file path"),
      new_path: z.string().describe("New file path / destination"),
      message: z.string().optional().describe("Commit message (default: 'rename <old> to <new>')"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner, repo, old_path, new_path, message, branch }) => {
      const commitMessage = message || `rename ${old_path} to ${new_path}`;

      const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(old_path)}${query}`
      );
      const content = existing.content.replace(/\n/g, "");

      const createResult = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(new_path)}`,
        {
          method: "PUT",
          body: { message: commitMessage, content, branch },
        }
      );

      await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(old_path)}`,
        {
          method: "DELETE",
          body: { message: commitMessage, sha: existing.sha, branch },
        }
      );

      return {
        content: [
          {
            type: "text",
            text: `Renamed ${old_path} → ${new_path} in ${owner}/${repo} (commit ${createResult.commit.sha.slice(0, 7)}).`,
          },
        ],
      };
    }
  );

  server.tool(
    "push_files",
    "Commit multiple files to a GitHub repository in a single commit (like a git push).",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      branch: z.string().optional().describe("Branch to push to (default: repo's default branch)"),
      message: z.string().describe("Commit message"),
      files: z
        .array(
          z.object({
            path: z.string().describe("File path within the repo, e.g. 'src/server.js'"),
            content: z.string().describe("Full new content of the file (plain text, not base64)"),
          })
        )
        .min(1)
        .describe("Files to include in this commit"),
    },
    async ({ owner = DEFAULT_OWNER, repo, branch, message, files }) => {
      const repoInfo = await githubRequest(`/repos/${owner}/${repo}`);
      const targetBranch = branch || repoInfo.default_branch;

      const refData = await githubRequest(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`
      );
      const baseCommitSha = refData.object.sha;

      const baseCommit = await githubRequest(
        `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`
      );
      const baseTreeSha = baseCommit.tree.sha;

      const blobs = await Promise.all(
        files.map((f) =>
          githubRequest(`/repos/${owner}/${repo}/git/blobs`, {
            method: "POST",
            body: { content: toBase64(f.content), encoding: "base64" },
          })
        )
      );

      const tree = files.map((f, i) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        sha: blobs[i].sha,
      }));

      const newTree = await githubRequest(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: { base_tree: baseTreeSha, tree },
      });

      const newCommit = await githubRequest(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: { message, tree: newTree.sha, parents: [baseCommitSha] },
      });

      await githubRequest(
        `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(targetBranch)}`,
        { method: "PATCH", body: { sha: newCommit.sha } }
      );

      return {
        content: [
          {
            type: "text",
            text: `Pushed ${files.length} file(s) to ${owner}/${repo}@${targetBranch} (commit ${newCommit.sha.slice(0, 7)}).`,
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Branch & commit tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_branches",
    "List branches in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
    },
    async ({ owner = DEFAULT_OWNER, repo }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/branches`);
      const lines = data.map((b) => `${b.name}${b.protected ? " (protected)" : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") || "(no branches)" }] };
    }
  );

  server.tool(
    "create_branch",
    "Create a new branch in a GitHub repository from an existing ref.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      branch: z.string().describe("Name of the new branch to create"),
      from_branch: z.string().optional().describe("Branch, tag, or SHA to branch from (default: repo's default branch)"),
    },
    async ({ owner, repo, branch, from_branch }) => {
      let sha;
      if (from_branch) {
        const ref = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`);
        sha = ref.object.sha;
      } else {
        const repoData = await githubRequest(`/repos/${owner}/${repo}`);
        const defaultBranch = repoData.default_branch;
        const ref = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
        sha = ref.object.sha;
      }

      await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha },
      });

      return {
        content: [{ type: "text", text: `Created branch '${branch}' in ${owner}/${repo} from ${sha.slice(0, 7)}.` }],
      };
    }
  );

  server.tool(
    "list_commits",
    "List commits on a branch in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      branch: z.string().optional().describe("Branch name (default: repo's default branch)"),
      per_page: z.number().optional().describe("Number of commits to return, max 100 (default: 20)"),
    },
    async ({ owner, repo, branch, per_page = 20 }) => {
      const query = new URLSearchParams({ per_page: String(per_page) });
      if (branch) query.set("sha", branch);
      const data = await githubRequest(`/repos/${owner}/${repo}/commits?${query}`);
      const lines = data.map(
        (c) =>
          `${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`
      );
      return { content: [{ type: "text", text: lines.join("\n") || "(no commits)" }] };
    }
  );

  server.tool(
    "get_commit",
    "Get details of a specific commit in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      sha: z.string().describe("Commit SHA"),
    },
    async ({ owner, repo, sha }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
      const files = data.files
        .map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join("\n");
      const text =
        `Commit: ${data.sha.slice(0, 7)}\n` +
        `Author: ${data.commit.author.name} <${data.commit.author.email}>\n` +
        `Date: ${data.commit.author.date}\n` +
        `Message: ${data.commit.message}\n\n` +
        `Files changed (${data.files.length}):\n${files}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // -------------------------------------------------------------------------
  // Pull request tools
  // -------------------------------------------------------------------------

  server.tool(
    "get_pull_requests",
    "List pull requests in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      state: z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state (default: open)"),
      per_page: z.number().optional().describe("Number of PRs to return, max 100 (default: 20)"),
    },
    async ({ owner, repo, state = "open", per_page = 20 }) => {
      const data = await githubRequest(
        `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`
      );
      if (!data.length) {
        return { content: [{ type: "text", text: `No ${state} pull requests found.` }] };
      }
      const lines = data.map(
        (pr) =>
          `#${pr.number} [${pr.state}] ${pr.title}\n  ${pr.head.label} → ${pr.base.label} | by ${pr.user.login} | ${pr.created_at.slice(0, 10)}\n  ${pr.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "create_pull_request",
    "Open a new pull request in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      title: z.string().describe("PR title"),
      head: z.string().describe("The branch containing the changes (source branch)"),
      base: z.string().describe("The branch to merge into (target branch, e.g. 'main')"),
      body: z.string().optional().describe("PR description body"),
      draft: z.boolean().optional().describe("Open as a draft PR (default: false)"),
    },
    async ({ owner, repo, title, head, base, body, draft = false }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { title, head, base, body, draft },
      });
      return {
        content: [
          {
            type: "text",
            text: `Created PR #${data.number}: "${data.title}"\n${data.html_url}`,
          },
        ],
      };
    }
  );

  server.tool(
    "merge_pull_request",
    "Merge a pull request in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge strategy (default: merge)"),
      commit_title: z.string().optional().describe("Title for the merge commit (merge/squash only)"),
      commit_message: z.string().optional().describe("Body for the merge commit (merge/squash only)"),
    },
    async ({ owner, repo, pull_number, merge_method = "merge", commit_title, commit_message }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
        method: "PUT",
        body: { merge_method, commit_title, commit_message },
      });
      return {
        content: [{ type: "text", text: `Merged PR #${pull_number}: ${data.message}\nCommit: ${data.sha?.slice(0, 7) ?? "n/a"}` }],
      };
    }
  );

  server.tool(
    "review_pull_request",
    "Submit a review on a pull request (approve, request changes, or comment).",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("Review action"),
      body: z.string().optional().describe("Review comment body"),
    },
    async ({ owner, repo, pull_number, event, body }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
        method: "POST",
        body: { event, body },
      });
      return {
        content: [{ type: "text", text: `Submitted review #${data.id} (${event}) on PR #${pull_number}.` }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Issues tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_issues",
    "List issues in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      state: z.enum(["open", "closed", "all"]).optional().describe("Filter by state (default: open)"),
      labels: z.string().optional().describe("Comma-separated list of label names to filter by"),
      assignee: z.string().optional().describe("Filter by assignee username"),
      per_page: z.number().optional().describe("Number of issues to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, state = "open", labels, assignee, per_page = 20 }) => {
      const query = new URLSearchParams({ state, per_page: String(per_page) });
      if (labels) query.set("labels", labels);
      if (assignee) query.set("assignee", assignee);
      const data = await githubRequest(`/repos/${owner}/${repo}/issues?${query}`);
      // Filter out PRs (GitHub issues endpoint returns PRs too)
      const issues = data.filter((i) => !i.pull_request);
      if (!issues.length) {
        return { content: [{ type: "text", text: `No ${state} issues found.` }] };
      }
      const lines = issues.map(
        (i) =>
          `#${i.number} [${i.state}] ${i.title}\n  by ${i.user.login} | ${i.created_at.slice(0, 10)}${i.labels.length ? ` | labels: ${i.labels.map((l) => l.name).join(", ")}` : ""}${i.assignee ? ` | assigned: ${i.assignee.login}` : ""}\n  ${i.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "create_issue",
    "Open a new issue in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Issue body (markdown supported)"),
      labels: z.array(z.string()).optional().describe("Labels to apply to the issue"),
      assignees: z.array(z.string()).optional().describe("GitHub usernames to assign the issue to"),
    },
    async ({ owner = DEFAULT_OWNER, repo, title, body, labels, assignees }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues`, {
        method: "POST",
        body: { title, body, labels, assignees },
      });
      return {
        content: [{ type: "text", text: `Created issue #${data.number}: "${data.title}"\n${data.html_url}` }],
      };
    }
  );

  server.tool(
    "update_issue",
    "Update an existing issue (close, reopen, retitle, relabel, or reassign).",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      issue_number: z.number().describe("Issue number"),
      title: z.string().optional().describe("New title"),
      body: z.string().optional().describe("New body"),
      state: z.enum(["open", "closed"]).optional().describe("New state"),
      labels: z.array(z.string()).optional().describe("Replacement label list (replaces all existing labels)"),
      assignees: z.array(z.string()).optional().describe("Replacement assignee list (replaces all existing assignees)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, issue_number, title, body, state, labels, assignees }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}`, {
        method: "PATCH",
        body: { title, body, state, labels, assignees },
      });
      return {
        content: [{ type: "text", text: `Updated issue #${data.number}: "${data.title}" [${data.state}]\n${data.html_url}` }],
      };
    }
  );

  server.tool(
    "add_issue_comment",
    "Post a comment on an issue or pull request.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      issue_number: z.number().describe("Issue or PR number"),
      body: z.string().describe("Comment body (markdown supported)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, issue_number, body }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
        method: "POST",
        body: { body },
      });
      return {
        content: [{ type: "text", text: `Posted comment #${data.id} on #${issue_number}.\n${data.html_url}` }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Releases & tags tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_releases",
    "List releases in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of releases to return, max 100 (default: 10)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 10 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=${per_page}`);
      if (!data.length) {
        return { content: [{ type: "text", text: "No releases found." }] };
      }
      const lines = data.map(
        (r) =>
          `${r.tag_name} — ${r.name || "(no name)"}${r.draft ? " [DRAFT]" : ""}${r.prerelease ? " [PRE-RELEASE]" : ""}\n  Published: ${r.published_at?.slice(0, 10) ?? "unpublished"} | ${r.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "create_release",
    "Create a new release in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      tag_name: z.string().describe("Tag name for the release (e.g. 'v1.2.0')"),
      name: z.string().optional().describe("Release title"),
      body: z.string().optional().describe("Release notes (markdown supported)"),
      draft: z.boolean().optional().describe("Create as a draft release (default: false)"),
      prerelease: z.boolean().optional().describe("Mark as a pre-release (default: false)"),
      target_commitish: z.string().optional().describe("Branch or commit SHA the tag should point to (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, tag_name, name, body, draft = false, prerelease = false, target_commitish }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/releases`, {
        method: "POST",
        body: { tag_name, name, body, draft, prerelease, target_commitish },
      });
      return {
        content: [{ type: "text", text: `Created release "${data.name || data.tag_name}"${draft ? " (draft)" : ""}.\n${data.html_url}` }],
      };
    }
  );

  server.tool(
    "list_tags",
    "List tags in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of tags to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/tags?per_page=${per_page}`);
      if (!data.length) {
        return { content: [{ type: "text", text: "No tags found." }] };
      }
      const lines = data.map((t) => `${t.name}  ${t.commit.sha.slice(0, 7)}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // -------------------------------------------------------------------------
  // Repo metadata tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_repos",
    "List repositories for a GitHub user or organization.",
    {
      owner: z.string().describe("GitHub username or organization name"),
      type: z.enum(["all", "owner", "member"]).optional().describe("Filter by repo type (default: all)"),
      sort: z.enum(["created", "updated", "pushed", "full_name"]).optional().describe("Sort order (default: updated)"),
      per_page: z.number().optional().describe("Number of repos to return, max 100 (default: 30)"),
    },
    async ({ owner, type = "all", sort = "updated", per_page = 30 }) => {
      let data;
      try {
        data = await githubRequest(
          `/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`
        );
      } catch {
        data = await githubRequest(
          `/orgs/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`
        );
      }
      const lines = data.map(
        (r) =>
          `${r.private ? "🔒" : "🌐"} ${r.full_name}${r.description ? ` — ${r.description}` : ""} [${r.language || "unknown"}] ⭐${r.stargazers_count}`
      );
      return {
        content: [{ type: "text", text: lines.join("\n") || "(no repositories found)" }],
      };
    }
  );

  server.tool(
    "get_repo",
    "Get detailed metadata for a GitHub repository (stars, forks, default branch, topics, visibility, etc.).",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
    },
    async ({ owner = DEFAULT_OWNER, repo }) => {
      const r = await githubRequest(`/repos/${owner}/${repo}`);
      const text =
        `${r.full_name} (${r.private ? "private" : "public"})\n` +
        `Description: ${r.description || "(none)"}\n` +
        `Default branch: ${r.default_branch}\n` +
        `Language: ${r.language || "unknown"}\n` +
        `Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Open issues: ${r.open_issues_count}\n` +
        `Topics: ${r.topics?.join(", ") || "(none)"}\n` +
        `Created: ${r.created_at.slice(0, 10)} | Last push: ${r.pushed_at.slice(0, 10)}\n` +
        `URL: ${r.html_url}`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "list_contributors",
    "List contributors to a GitHub repository with commit counts.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of contributors to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/contributors?per_page=${per_page}`);
      if (!data.length) {
        return { content: [{ type: "text", text: "No contributors found." }] };
      }
      const lines = data.map((c, i) => `${i + 1}. ${c.login} — ${c.contributions} commit${c.contributions !== 1 ? "s" : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_repo_topics",
    "Get or replace the topics (tags) on a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      set_topics: z.array(z.string()).optional().describe("If provided, replaces all existing topics with this list. Omit to just read current topics."),
    },
    async ({ owner = DEFAULT_OWNER, repo, set_topics }) => {
      if (set_topics !== undefined) {
        await githubRequest(`/repos/${owner}/${repo}/topics`, {
          method: "PUT",
          body: { names: set_topics },
          accept: "application/vnd.github.mercy-preview+json",
        });
        return {
          content: [{ type: "text", text: `Updated topics for ${owner}/${repo}: ${set_topics.join(", ") || "(none)"}` }],
        };
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/topics`, {
        accept: "application/vnd.github.mercy-preview+json",
      });
      return {
        content: [{ type: "text", text: `Topics for ${owner}/${repo}: ${data.names?.join(", ") || "(none)"}` }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Search tools
  // -------------------------------------------------------------------------

  server.tool(
    "search_code",
    "Search for code across GitHub repositories.",
    {
      query: z.string().describe("Search query (e.g. 'VLESS filename:worker.js user:dumbCodesOnly')"),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 10)"),
    },
    async ({ query, per_page = 10 }) => {
      const data = await githubRequest(
        `/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`
      );
      if (!data.items || data.items.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }
      const lines = data.items.map(
        (item) => `📄 ${item.repository.full_name}/${item.path} (${item.html_url})`
      );
      return {
        content: [
          {
            type: "text",
            text: `Found ${data.total_count} result(s), showing ${data.items.length}:\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // GitHub Actions / CI tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_workflow_runs",
    "List recent GitHub Actions workflow runs for a repository.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      workflow_id: z.string().optional().describe("Workflow file name or ID to filter by (e.g. 'ci.yml'). Omit for all workflows."),
      branch: z.string().optional().describe("Filter by branch name"),
      status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]).optional().describe("Filter by run status"),
      per_page: z.number().optional().describe("Number of runs to return, max 100 (default: 10)"),
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
      if (!runs?.length) {
        return { content: [{ type: "text", text: "No workflow runs found." }] };
      }

      const statusIcon = (s, c) => {
        if (s === "in_progress") return "🔄";
        if (s === "queued" || s === "waiting") return "⏳";
        if (c === "success") return "✅";
        if (c === "failure") return "❌";
        if (c === "cancelled") return "🚫";
        return "⚪";
      };

      const lines = runs.map(
        (r) =>
          `${statusIcon(r.status, r.conclusion)} #${r.run_number} — ${r.name} (${r.head_branch})\n` +
          `  Status: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""} | Triggered: ${r.event} | ${r.created_at.slice(0, 10)}\n` +
          `  ${r.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "get_workflow_run_logs",
    "Get the logs URL or summary for a specific GitHub Actions workflow run.",
    {
      owner: z.string().optional().describe(`Repository owner (user or org). Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo: z.string().describe("Repository name"),
      run_id: z.number().describe("Workflow run ID (from list_workflow_runs)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, run_id }) => {
      const run = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}`);
      const jobsData = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
      const jobs = jobsData.jobs || [];

      const statusIcon = (s, c) => {
        if (s === "in_progress") return "🔄";
        if (c === "success") return "✅";
        if (c === "failure") return "❌";
        if (c === "cancelled") return "🚫";
        return "⚪";
      };

      const jobLines = jobs.map((j) => {
        const icon = statusIcon(j.status, j.conclusion);
        const steps = j.steps
          ?.filter((s) => s.conclusion === "failure" || s.conclusion === "skipped" ? true : s.status !== "completed" || s.conclusion !== "success")
          .map((s) => `      ${statusIcon(s.status, s.conclusion)} Step ${s.number}: ${s.name} [${s.conclusion || s.status}]`)
          .join("\n") || "";
        return `  ${icon} Job: ${j.name} [${j.conclusion || j.status}]\n${steps}`;
      });

      const text =
        `Run #${run.run_number}: ${run.name}\n` +
        `Status: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}\n` +
        `Branch: ${run.head_branch} | Commit: ${run.head_sha.slice(0, 7)}\n` +
        `Triggered by: ${run.event} | Started: ${run.created_at.slice(0, 10)}\n\n` +
        `Jobs (${jobs.length}):\n${jobLines.join("\n\n")}\n\n` +
        `Full logs: ${run.html_url}\n` +
        `Logs download: https://api.github.com/repos/${owner}/${repo}/actions/runs/${run_id}/logs`;

      return { content: [{ type: "text", text }] };
    }
  );

  // -------------------------------------------------------------------------
  // Notion tools
  // -------------------------------------------------------------------------

  server.tool(
    "notion_search",
    "Search pages and databases in your Notion workspace.",
    {
      query: z.string().describe("Search query string"),
      filter_type: z.enum(["page", "database"]).optional().describe("Filter results to only pages or only databases (default: both)"),
      page_size: z.number().optional().describe("Number of results to return (default: 10, max: 100)"),
    },
    async ({ query, filter_type, page_size = 10 }) => {
      const body = { query, page_size };
      if (filter_type) {
        body.filter = { value: filter_type, property: "object" };
      }
      const data = await notionRequest("/search", { method: "POST", body });
      if (!data.results?.length) {
        return { content: [{ type: "text", text: "No results found." }] };
      }
      const lines = data.results.map((r) => {
        const title = r.object === "page" ? notionPageTitle(r) : (notionRichTextToString(r.title) || "(untitled)");
        const url = r.url || "";
        return `[${r.object}] ${title}\n  ID: ${r.id}\n  URL: ${url}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "notion_get_page",
    "Get a Notion page's properties and content blocks.",
    {
      page_id: z.string().describe("Notion page ID (UUID format, e.g. from notion_search)"),
    },
    async ({ page_id }) => {
      const [page, blocksData] = await Promise.all([
        notionRequest(`/pages/${page_id}`),
        notionRequest(`/blocks/${page_id}/children?page_size=100`),
      ]);

      const title = notionPageTitle(page);
      const content = notionBlocksToText(blocksData.results || []);
      const hasMore = blocksData.has_more ? "\n\n⚠️ Page has more blocks — only first 100 shown." : "";

      const text =
        `# ${title}\n` +
        `ID: ${page.id}\n` +
        `URL: ${page.url}\n` +
        `Created: ${page.created_time?.slice(0, 10)} | Last edited: ${page.last_edited_time?.slice(0, 10)}\n\n` +
        (content || "(no content)") +
        hasMore;

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "notion_create_page",
    "Create a new Notion page inside a parent page or database.",
    {
      parent_id: z.string().describe("ID of the parent page or database to create the page in"),
      parent_type: z.enum(["page", "database"]).describe("Whether the parent is a page or a database"),
      title: z.string().describe("Title of the new page"),
      content: z.string().optional().describe("Plain text content to add as paragraph blocks"),
    },
    async ({ parent_id, parent_type, title, content }) => {
      const parent =
        parent_type === "database"
          ? { database_id: parent_id }
          : { page_id: parent_id };

      const properties =
        parent_type === "database"
          ? { Name: { title: [{ text: { content: title } }] } }
          : { title: { title: [{ text: { content: title } }] } };

      const children = content
        ? content.split("\n").filter(Boolean).map((line) => ({
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
          }))
        : [];

      const data = await notionRequest("/pages", {
        method: "POST",
        body: { parent, properties, children },
      });

      return {
        content: [
          {
            type: "text",
            text: `Created Notion page "${title}"\nID: ${data.id}\nURL: ${data.url}`,
          },
        ],
      };
    }
  );

  server.tool(
    "notion_update_page",
    "Update a Notion page's title or properties, or append text content to it.",
    {
      page_id: z.string().describe("Notion page ID to update"),
      title: z.string().optional().describe("New title for the page"),
      append_content: z.string().optional().describe("Plain text to append as new paragraph blocks at the end of the page"),
      archived: z.boolean().optional().describe("Set to true to archive (trash) the page, false to restore it"),
    },
    async ({ page_id, title, append_content, archived }) => {
      const results = [];

      // Update properties / archive state
      if (title !== undefined || archived !== undefined) {
        const body = {};
        if (archived !== undefined) body.archived = archived;
        if (title !== undefined) {
          body.properties = {
            title: { title: [{ text: { content: title } }] },
          };
        }
        const data = await notionRequest(`/pages/${page_id}`, { method: "PATCH", body });
        results.push(`Updated page "${notionPageTitle(data)}" (ID: ${data.id}).`);
      }

      // Append content blocks
      if (append_content) {
        const children = append_content
          .split("\n")
          .filter(Boolean)
          .map((line) => ({
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
          }));
        await notionRequest(`/blocks/${page_id}/children`, {
          method: "PATCH",
          body: { children },
        });
        results.push(`Appended ${children.length} paragraph(s) to page.`);
      }

      return {
        content: [{ type: "text", text: results.join("\n") || "No changes made." }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Mem tools
  // -------------------------------------------------------------------------

  server.tool(
    "mem_list",
    "List recent mems from your Mem workspace.",
    {
      limit: z.number().optional().describe("Number of mems to return (default: 20)"),
    },
    async ({ limit = 20 }) => {
      const data = await memRequest(`/mems?limit=${limit}`);
      const mems = data.mems || data.items || data || [];
      if (!mems.length) {
        return { content: [{ type: "text", text: "No mems found." }] };
      }
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
      const m = await memRequest(`/mems/${mem_id}`);
      const content = m.content || m.markdown || "(no content)";
      const text =
        `ID: ${m.id}\n` +
        `Created: ${m.created_at?.slice(0, 10) || "unknown"} | Updated: ${m.updated_at?.slice(0, 10) || "unknown"}\n\n` +
        content;
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
      const data = await memRequest("/mems", {
        method: "POST",
        body: { content },
      });
      return {
        content: [
          {
            type: "text",
            text: `Created mem (ID: ${data.id}).\nCreated: ${data.created_at?.slice(0, 10) || "unknown"}`,
          },
        ],
      };
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
      const data = await memRequest("/mems/search", {
        method: "POST",
        body: { query, limit },
      });
      const mems = data.mems || data.items || data || [];
      if (!mems.length) {
        return { content: [{ type: "text", text: "No mems found matching your query." }] };
      }
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
      mem_id: z.string().describe("The mem ID to update"),
      content: z.string().describe("New content for the mem (replaces existing content)"),
    },
    async ({ mem_id, content }) => {
      const data = await memRequest(`/mems/${mem_id}`, {
        method: "PATCH",
        body: { content },
      });
      return {
        content: [
          {
            type: "text",
            text: `Updated mem (ID: ${data.id || mem_id}).\nUpdated: ${data.updated_at?.slice(0, 10) || "unknown"}`,
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport (stateless: a fresh MCP server/transport pair per request)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "manufact-mcp-server",
    configured: {
      github: Boolean(GITHUB_TOKEN),
      notion: Boolean(NOTION_TOKEN),
      mem: Boolean(MEM_API_KEY),
    },
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`manufact-mcp-server listening on port ${PORT}`);
  if (!GITHUB_TOKEN) console.warn("WARNING: GITHUB_TOKEN is not set.");
  if (!NOTION_TOKEN) console.warn("WARNING: NOTION_TOKEN is not set. Notion tools will fail.");
  if (!MEM_API_KEY) console.warn("WARNING: MEM_API_KEY is not set. Mem tools will fail.");
});
