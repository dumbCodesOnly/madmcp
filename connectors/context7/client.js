// ---------------------------------------------------------------------------
// connectors/context7/client.js — Context7 REST API (context7.com)
// Docs: https://context7.com/docs/api-guide
// Auth header: "Authorization: Bearer <api_key>" (optional — unauthenticated
// requests work at lower rate limits, unlike every other connector here).
// ---------------------------------------------------------------------------

import { CONTEXT7_API_KEY, CONTEXT7_API } from "../../config.js";

export async function context7Request(path, params = {}) {
  const url = new URL(`${CONTEXT7_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const headers = {};
  if (CONTEXT7_API_KEY) headers.Authorization = `Bearer ${CONTEXT7_API_KEY}`;

  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.message || data.error || JSON.stringify(data))) || res.statusText;
    throw new Error(`Context7 API error (${res.status}): ${message}`);
  }
  return data;
}
