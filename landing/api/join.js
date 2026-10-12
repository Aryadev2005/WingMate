import { body, codeFor, FOUNDING_CAP, limited, position, readRecord, stats, validEmail, writeMarker, writeRecord } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "x";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited", message: "Too many tries. Give it a minute." });

  const b = body(req);
  if (b.website) return res.status(200).json({ ok: true }); // honeypot: bots fill hidden fields
  const email = String(b.email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "invalid_email", message: "That email doesn't look right." });
  const wantsFounding = b.intent === "founding";
  const ref = typeof b.ref === "string" && /^[A-Za-z0-9_-]{10}$/.test(b.ref) ? b.ref : null;
  const code = codeFor(email);

  try {
    let rec = await readRecord(code);
    const s = await stats(true);
    let foundingOk = wantsFounding && s.founding < FOUNDING_CAP;

    if (!rec) {
      rec = {
        email,
        code,
        n: s.total + 1,
        intent: foundingOk ? "founding" : "waitlist",
        ref: ref && ref !== code ? ref : null,
        country: req.headers["x-vercel-ip-country"] || null,
        source: typeof b.source === "string" ? b.source.slice(0, 60) : null,
        createdAt: new Date().toISOString(),
      };
      try {
        await writeRecord(code, rec);
      } catch {
        rec = (await readRecord(code)) || rec; // a parallel request created it first
      }
      if (rec.ref) await writeMarker(`refs/${rec.ref}/${code}`);
    } else if (foundingOk && rec.intent !== "founding") {
      rec = { ...rec, intent: "founding" };
      const { put } = await import("@vercel/blob");
      await put(`signups/${code}.json`, JSON.stringify(rec), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
    } else if (rec.intent === "founding") {
      foundingOk = true;
    }
    if (rec.intent === "founding") await writeMarker(`founding/${code}`);

    const p = await position(rec);
    return res.status(200).json({
      ok: true,
      code,
      founding: rec.intent === "founding",
      foundingFull: wantsFounding && !foundingOk,
      ...p,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error", message: "Couldn't save that. Try again in a moment." });
  }
}
