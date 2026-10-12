import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { planOf } from "../app.js";
import type { ChatMessage, ContentPart } from "../llm/provider.js";
import { hit, refundQuota, reserveQuota } from "../services/limits.js";
import { detectCrisis, helplinesFor } from "../services/safety.js";

// Reply Lab: the Rizz / Plug AI style tools.
//   reply  - screenshot or pasted chat -> 3 replies to send next
//   opener - their profile (screenshot or bio) -> 3 first messages
//   bio    - your own profile -> feedback + 3 rewritten bios
const Body = z
  .object({
    mode: z.enum(["reply", "opener", "bio"]),
    tone: z.enum(["flirty", "funny", "smooth", "chill", "bold"]).default("smooth"),
    text: z.string().trim().max(4000).optional(),
    image: z.string().max(3_000_000).optional(), // base64 JPEG/PNG/WebP, with or without data: prefix
    avoid: z.array(z.string().max(500)).max(9).optional(), // earlier suggestions, so "More" gives new ones
  })
  .refine((b) => b.text || b.image, { message: "Add a screenshot or paste some text." });

const Result = z.object({
  suggestions: z.array(z.string().min(1).max(600)).min(1).max(5),
  feedback: z.string().max(1200).optional(),
});

const TONES = {
  flirty: "playful and flirty, confident but never sleazy",
  funny: "genuinely funny and witty",
  smooth: "smooth, warm and easy to reply to",
  chill: "low-key and casual",
  bold: "bold and direct",
} as const;

const TASK = {
  reply:
    "The input is a dating-app or text conversation (screenshot or pasted). The user's messages are usually on the right. Write 3 different next messages for the user to send.",
  opener:
    "The input is someone's dating profile (screenshot or bio). Write 3 different opening messages that reference something specific from their profile.",
  bio:
    "The input is the user's own dating profile or bio. Give honest, specific feedback in 'feedback' (max 60 words), then 3 rewritten bios as suggestions (max 300 characters each).",
} as const;

export function assistPrompt(mode: keyof typeof TASK, tone: keyof typeof TONES, avoid: string[] = []): string {
  return [
    "You write dating messages for an app used by adults 18-30.",
    TASK[mode],
    `Tone: ${TONES[tone]}.`,
    "Sound like a real person texting: natural, specific to the details given, short (under 25 words for messages).",
    "No cheesy pickup lines, no cringe, no pressure, nothing sexual or manipulative. Match the language of the conversation.",
    "If the image is unreadable or not a chat/profile, return one suggestion asking them to try a clearer screenshot.",
    avoid.length ? `Don't repeat these: ${avoid.map((a) => JSON.stringify(a)).join(", ")}` : "",
    'Reply with only JSON: {"suggestions":["...","...","..."]' + (mode === "bio" ? ',"feedback":"..."}' : "}"),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pulls the JSON object out of a model reply that may include stray text or code fences. */
export function parseResult(raw: string) {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const r = Result.safeParse(JSON.parse(raw.slice(a, b + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function assistRoutes(app: FastifyInstance) {
  const { cfg, db, redis, llm, vision } = app.deps;

  app.post("/v1/assist", { onRequest: app.auth, bodyLimit: 3_200_000 }, async (req, reply) => {
    const uid = req.user.sub;
    const body = Body.parse(req.body);

    let imageUrl: string | undefined;
    if (body.image) {
      const m = /^(?:data:(image\/(?:jpeg|png|webp));base64,)?([A-Za-z0-9+/=\s]+)$/.exec(body.image);
      if (!m) return reply.code(400).send({ error: "invalid_image", message: "Use a JPEG, PNG or WebP screenshot." });
      const bytes = Math.floor((m[2].replace(/\s/g, "").length * 3) / 4);
      if (bytes > cfg.MAX_IMAGE_BYTES) return reply.code(413).send({ error: "image_too_large", message: "That screenshot is too large. Try cropping it." });
      imageUrl = `data:${m[1] ?? "image/jpeg"};base64,${m[2].replace(/\s/g, "")}`;
    }

    if (!(await hit(redis, `assist:${uid}`, 15, 60))) return reply.code(429).send({ error: "rate_limited", message: "Slow down a little and try again." });

    const { rows } = await db.query("SELECT u.plan, u.plan_expires_at, p.country FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=$1", [uid]);
    if (!rows[0]) return reply.code(401).send({ error: "unauthorized", message: "Sign in again." });
    if (!rows[0].country) return reply.code(409).send({ error: "profile_required", message: "Finish setting up your profile first." });
    const plan = planOf(rows[0]);
    const limit = plan === "plus" ? cfg.PLUS_MESSAGES_PER_DAY : cfg.FREE_MESSAGES_PER_DAY;

    const remaining = await reserveQuota(redis, uid, limit);
    if (remaining < 0) {
      return reply.code(402).send({ error: "quota_exhausted", message: plan === "plus" ? "You've hit today's fair-use limit." : `You've used your ${limit} free tries today. They reset tomorrow, or upgrade to Plus.`, plan });
    }

    const parts: ContentPart[] = [];
    if (body.text) parts.push({ type: "text", text: body.text });
    if (imageUrl) parts.push({ type: "image_url", image_url: { url: imageUrl } });
    const messages: ChatMessage[] = [
      { role: "system", content: assistPrompt(body.mode, body.tone, body.avoid) },
      { role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts },
    ];

    try {
      const res = await (imageUrl ? vision : llm).chat(messages, body.mode === "bio" ? 500 : 300);
      const out = parseResult(res.text);
      if (!out) throw new Error("bad model output");
      const { promptTokens: pt, completionTokens: ct } = res.usage;
      await db.query(
        "INSERT INTO assist_events(user_id,mode,with_image,model,prompt_tokens,completion_tokens,cost_micros) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [uid, body.mode, !!imageUrl, res.model, pt, ct, Math.round(pt * cfg.LLM_PRICE_IN_PER_M + ct * cfg.LLM_PRICE_OUT_PER_M)],
      );
      return {
        suggestions: out.suggestions.slice(0, 3),
        feedback: out.feedback,
        safety: body.text && detectCrisis(body.text) ? helplinesFor(rows[0].country) : undefined,
        remaining,
        plan,
      };
    } catch {
      await refundQuota(redis, uid); // never charge for a failed generation
      return reply.code(502).send({ error: "generation_failed", message: "Couldn't come up with replies right now. Try again." });
    }
  });
}
