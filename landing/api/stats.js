import { position, readRecord, stats } from "./_lib.js";

// Public counts + (optionally) your own place in line. Also hands the page its Meta Pixel ID.
export default async function handler(req, res) {
  try {
    const s = await stats();
    let me = null;
    const code = String(req.query.code || "");
    if (/^[A-Za-z0-9_-]{10}$/.test(code)) {
      const rec = await readRecord(code);
      if (rec) me = { founding: rec.intent === "founding", ...(await position(rec)) };
    }
    res.setHeader("cache-control", me ? "no-store" : "public, s-maxage=15, stale-while-revalidate=60");
    return res.status(200).json({ ...s, me, pixelId: process.env.META_PIXEL_ID || null });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ total: null, founding: null, foundingCap: 500, me: null, pixelId: process.env.META_PIXEL_ID || null });
  }
}
