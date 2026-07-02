// ---------------------------------------------------------------------------
// connectors/cloudflare/client.js
// Thin wrapper around the Cloudflare REST API (api.cloudflare.com/client/v4),
// scoped to a single account. Mirrors the auth/error pattern used by the
// GitHub connector's client.js.
// ---------------------------------------------------------------------------

import { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API } from "../../config.js";

function assertConfigured() {
  if (!CLOUDFLARE_API_TOKEN) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN is not set. Add it as an environment variable on the Manufact server."
    );
  }
  if (!CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID is not set. Add it as an environment variable on the Manufact server."
    );
  }
}

// Generic request against any Cloudflare API path (not account-scoped).
export async function cfRequest(path, { method = "GET", body, accept } = {}) {
  assertConfigured();
  const res = await fetch(`${CLOUDFLARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      Accept: accept || "application/json",
      "Content-Type": "application/json",
      "User-Agent": "manufact-mcp-server",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  // Non-JSON responses (e.g. raw worker script source) are returned as-is.
  if (!contentType.includes("application/json")) {
    if (!res.ok) {
      throw new Error(`Cloudflare API error (${res.status}): ${text || res.statusText}`);
    }
    return text;
  }

  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok || (data && data.success === false)) {
    const errors = (data && data.errors && data.errors.map(e => e.message).join("; ")) || res.statusText;
    throw new Error(`Cloudflare API error (${res.status}): ${errors}`);
  }

  // Cloudflare wraps successful payloads as { success, result, result_info }.
  return data && Object.prototype.hasOwnProperty.call(data, "result") ? data.result : data;
}

// Convenience helper for the common case: paths under /accounts/{account_id}/...
export function cfAccountRequest(subpath, opts) {
  return cfRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}${subpath}`, opts);
}
