// ---------------------------------------------------------------------------
// connectors/github/helpers.js — shared helpers for GitHub connector modules
// ---------------------------------------------------------------------------

import { githubRequest, fromBase64 } from "./client.js";

export async function getFileBlobSha(owner, repo, filePath, ref) {
  const repoInfo = await githubRequest(`/repos/${owner}/${repo}`);
  const branch = ref || repoInfo.default_branch;
  let treeSha;
  try {
    const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    treeSha = refData.object.sha;
  } catch {
    treeSha = branch;
  }
  const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const entry = tree.tree.find((item) => item.path === filePath && item.type === "blob");
  if (!entry) throw new Error(`File not found in tree: ${filePath}`);
  return { blobSha: entry.sha, treeSha };
}

export async function readFileViaBlob(owner, repo, filePath, ref) {
  const { blobSha } = await getFileBlobSha(owner, repo, filePath, ref);
  const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${blobSha}`);
  return fromBase64(blob.content.replace(/\n/g, ""));
}

export const CHUNK_SIZE = 20000;
export const CHUNK_THRESHOLD = 100000;
