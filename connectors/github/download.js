// ---------------------------------------------------------------------------
// connectors/github/download.js — download_repo tool
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";
import { readFileViaBlob } from "./helpers.js";

export function register(server) {
  server.tool(
    "download_repo",
    "Fetch all files from a GitHub repository and return their full contents as a JSON payload. Claude receives {summary, files:[{path,content}], errors} and can then write them locally using create_file.",
    {
      owner:      z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:       z.string().describe("Repository name"),
      ref:        z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
      src_path:   z.string().optional().describe("Subdirectory inside the repo to download (default: entire repo root)"),
      extensions: z.array(z.string()).optional().describe("Only download files with these extensions e.g. ['.js', '.ts']. Omit to download everything."),
      max_files:  z.number().optional().describe("Safety cap on number of files to download (default: 200)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref, src_path = "", extensions, max_files = 200 }) => {
      const repoInfo     = await githubRequest(`/repos/${owner}/${repo}`);
      const targetBranch = ref || repoInfo.default_branch;
      let treeSha;
      try {
        const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
        treeSha = refData.object.sha;
      } catch {
        treeSha = targetBranch;
      }
      const treeData = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
      let blobs = treeData.tree.filter((item) => item.type === "blob");
      if (src_path) {
        const prefix = src_path.endsWith("/") ? src_path : src_path + "/";
        blobs = blobs.filter((item) => item.path.startsWith(prefix));
      }
      if (extensions && extensions.length > 0) {
        const exts = extensions.map((e) => e.startsWith(".") ? e : "." + e);
        blobs = blobs.filter((item) => exts.some((ext) => item.path.endsWith(ext)));
      }
      if (blobs.length > max_files) {
        return {
          content: [{ type: "text", text: `⚠️ Repo has ${blobs.length} matching files which exceeds max_files=${max_files}. Use src_path or extensions to narrow the scope, or raise max_files.` }],
          isError: true,
        };
      }
      const files = [];
      const errors = [];
      for (const item of blobs) {
        try {
          const content = await readFileViaBlob(owner, repo, item.path, treeSha);
          files.push({ path: item.path, content });
        } catch (err) {
          errors.push({ path: item.path, error: err.message });
        }
      }
      const summary = `Fetched ${files.length}/${blobs.length} files from ${owner}/${repo}@${targetBranch}${errors.length ? ` (${errors.length} failed)` : ""}`;
      return { content: [{ type: "text", text: JSON.stringify({ summary, files, errors }, null, 2) }] };
    }
  );
}
