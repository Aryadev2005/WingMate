// Shared helpers for the waitlist API. Storage: a private Vercel Blob store.
//   signups/<code>.json      one record per email (code = HMAC of the email, so it's stable and unguessable)
//   founding/<code>          marker: this person reserved the founding price
//   refs/<referrer>/<code>   marker: <code> joined through <referrer>'s link
import { createHmac } from "node:crypto";
import { get, list, put } from "@vercel/blob";

export const FOUNDING_CAP = 500;
const SECRET = process.env.CODE_SECRET || "wingmate-dev-secret";

export const codeFor = (email) => createHmac("sha256", SECRET).update(email).digest("base64url").slice(0, 10);
export const validEmail = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export async function countPrefix(prefix) {
  let n = 0, cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    n += r.blobs.length;
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return n;
}

let statsCache = { at: 0, value: null };
export async function stats(fresh = false) {
  if (!fresh && statsCache.value && Date.now() - statsCache.at < 15000) return statsCache.value;
  const [total, founding] = await Promise.all([countPrefix("signups/"), countPrefix("founding/")]);
  statsCache = { at: Date.now(), value: { total, founding, foundingCap: FOUNDING_CAP } };
  return statsCache.value;
}

export async function readRecord(code) {
  const r = await get(`signups/${code}.json`, { access: "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

export const writeMarker = (path) =>
  put(path, "1", { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain" });

export const writeRecord = (code, rec) =>
  put(`signups/${code}.json`, JSON.stringify(rec), { access: "private", addRandomSuffix: false, contentType: "application/json" });

/** Your place in line: join order, minus 25 places for every friend who joined with your link. */
export async function position(rec) {
  const refs = await countPrefix(`refs/${rec.code}/`);
  return { refs, position: Math.max(1, rec.n - refs * 25) };
}

// Small per-instance rate limit; enough to stop casual spam on a waitlist.
const hits = new Map();
export function limited(ip, max = 8, windowMs = 60000) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  h.push(now);
  hits.set(ip, h);
  return h.length > max;
}

export function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}
