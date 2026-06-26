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
// ---------------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API = "https://api.github.com";

function assertConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it as an environment variable on the Manufact server."
    );
  }
}

async function githubRequest(path, { method = "GET", body } = {}) {
  assertConfigured();
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
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
    name: "github-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "read_file",
    "Read a file's contents from a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo, e.g. 'src/server.js'"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, path, ref }) => {
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
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().optional().describe("Directory path within the repo (default: repo root)"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, path = "", ref }) => {
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
    "create_or_update_file",
    "Create a new file or update an existing file's contents in a GitHub repository, committing the change directly to a branch.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo, e.g. 'src/server.js'"),
      content: z.string().describe("The full new content of the file (plain text, not base64)"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner, repo, path, content, message, branch }) => {
      // Need the current file SHA if it already exists, otherwise GitHub
      // will reject the update as a conflict.
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
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner, repo, path, message, branch }) => {
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
    "list_branches",
    "List branches in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
    },
    async ({ owner, repo }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/branches`);
      const lines = data.map((b) => `${b.name}${b.protected ? " (protected)" : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") || "(no branches)" }] };
    }
  );

  server.tool(
    "create_repo",
    "Create a new GitHub repository under the authenticated account.",
    {
      name: z.string().describe("Repository name"),
      private: z.boolean().optional().describe("Whether the repo should be private (default true)"),
      description: z.string().optional().describe("Repository description"),
    },
    async ({ name, private: isPrivate, description }) => {
      const data = await githubRequest(`/user/repos`, {
        method: "POST",
        body: { name, private: isPrivate ?? true, description },
      });
      return {
        content: [{ type: "text", text: `Created repo: ${data.full_name} (${data.html_url})` }],
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
  res.json({ status: "ok", service: "github-mcp-server", configured: Boolean(GITHUB_TOKEN) });
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
  console.log(`github-mcp-server listening on port ${PORT}`);
  if (!GITHUB_TOKEN) {
    console.warn("WARNING: GITHUB_TOKEN is not set. Tools will fail until it is configured.");
  }
});
