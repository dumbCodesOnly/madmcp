// ---------------------------------------------------------------------------
// connectors/github/client.js
// ---------------------------------------------------------------------------

import { GITHUB_TOKEN, GITHUB_API } from "../../config.js";

function assertConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it as an environment variable on the Manufact server."
    );
  }
}

export async function githubRequest(path, { method = "GET", body, accept } = {}) {
  assertConfigured();
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "manufact-mcp-server",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`GitHub API error (${res.status}): ${message}`);
  }
  return data;
}

export function toBase64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

export function fromBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf-8");
}
