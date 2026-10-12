import { timingSafeEqual } from "node:crypto";
import { list } from "@vercel/blob";
import { countPrefix, readRecord } from "./_lib.js";

// Download every signup as CSV:  /api/admin?key=<ADMIN_KEY>
export default async function handler(req, res) {
  const key = process.env.ADMIN_KEY || "";
  const got = String(req.query.key || "");
  if (!key || got.length !== key.length || !timingSafeEqual(Buffer.from(got), Buffer.from(key))) {
    return res.status(401).send("unauthorized");
  }
  const rows = [];
  let cursor;
  do {
    const r = await list({ prefix: "signups/", cursor, limit: 1000 });
    const recs = await Promise.all(r.blobs.map((b) => readRecord(b.pathname.slice(8, -5))));
    rows.push(...recs.filter(Boolean));
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  rows.sort((a, b) => a.n - b.n);
  const refCounts = await Promise.all(rows.map((r) => countPrefix(`refs/${r.code}/`)));
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    "n,email,intent,referrals,referred_by,country,source,created_at",
    ...rows.map((r, i) => [r.n, r.email, r.intent, refCounts[i], r.ref, r.country, r.source, r.createdAt].map(esc).join(",")),
  ].join("\n");
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", 'attachment; filename="wingmate-waitlist.csv"');
  res.setHeader("cache-control", "no-store");
  return res.status(200).send(csv);
}
