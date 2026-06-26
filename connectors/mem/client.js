// ---------------------------------------------------------------------------
// connectors/mem/client.js
// ---------------------------------------------------------------------------

import { MEM_API_KEY, MEM_API } from "../../config.js";

export async function memRequest(path, { method = "GET", body } = {}) {
  if (!MEM_API_KEY) throw new Error("MEM_API_KEY is not set. Add it as an environment variable on the Manufact server.");
  const res = await fetch(`${MEM_API}${path}`, {
    method,
    headers: {
      Authorization:  `ApiAccessToken ${MEM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = (data && (data.message || data.error || JSON.stringify(data))) || res.statusText;
    throw new Error(`Mem API error (${res.status}): ${message}`);
  }
  return data;
}
