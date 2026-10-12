import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fjwt from "@fastify/jwt";
import cors from "@fastify/cors";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Redis } from "ioredis";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { LlmClient } from "./llm/provider.js";
import { hit, usedToday } from "./services/limits.js";
import { helplinesFor } from "./services/safety.js";
import { chatRoutes } from "./routes/chat.js";
import { assistRoutes } from "./routes/assist.js";

export type Deps = { cfg: Config; db: Db; redis: Redis; llm: LlmClient; vision: LlmClient };

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
    auth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function planOf(row: { plan: string; plan_expires_at: Date | null }): "free" | "plus" {
  return row.plan === "plus" && (!row.plan_expires_at || row.plan_expires_at > new Date()) ? "plus" : "free";
}

export const ProfileSchema = z.object({
  name: z.string().trim().min(1).max(30),
  birthYear: z.number().int().min(1900),
  country: z.string().trim().length(2).toUpperCase(),
  situation: z.enum(["single", "talking", "dating", "relationship", "breakup", "complicated"]),
  interestedIn: z.enum(["men", "women", "everyone", "unsaid"]),
  tone: z.enum(["gentle", "direct", "funny"]),
});

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { cfg, db, redis } = deps;
  const app = Fastify({
    logger: cfg.NODE_ENV === "test" ? false : { level: "info", redact: ["req.headers.authorization"] },
    bodyLimit: 32 * 1024,
    trustProxy: true,
  });
  app.decorate("deps", deps);
  await app.register(cors, { origin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(",") });
  await app.register(fjwt, { secret: cfg.JWT_SECRET, sign: { expiresIn: cfg.ACCESS_TOKEN_TTL } });

  app.decorate("auth", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized", message: "Sign in again." });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_input", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "server_error" : "bad_request", message: status >= 500 ? "Something went wrong." : (err as Error).message });
  });

  async function issueTokens(userId: string) {
    const refresh = randomBytes(32).toString("base64url");
    await db.query("INSERT INTO refresh_tokens(token_hash,user_id,expires_at) VALUES ($1,$2, now() + make_interval(days => $3))", [
      sha256(refresh), userId, cfg.REFRESH_TOKEN_DAYS,
    ]);
    return { accessToken: app.jwt.sign({ sub: userId }), refreshToken: refresh, userId };
  }

  // ---- health
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_req, reply) => {
    try {
      await Promise.all([db.query("SELECT 1"), redis.ping()]);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ---- auth: no phone number or email needed to start
  app.post("/v1/auth/anonymous", async (req, reply) => {
    if (!(await hit(redis, `anon:${req.ip}`, 20, 3600))) return reply.code(429).send({ error: "rate_limited", message: "Too many sign-ups from this network. Try later." });
    const { rows } = await db.query<{ id: string }>("INSERT INTO users DEFAULT VALUES RETURNING id");
    return reply.code(201).send(await issueTokens(rows[0].id));
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(20).max(200) }).parse(req.body);
    // Rotation: the old token is deleted in the same statement it is checked.
    const { rows } = await db.query<{ user_id: string }>(
      "DELETE FROM refresh_tokens WHERE token_hash=$1 AND expires_at > now() RETURNING user_id",
      [sha256(refreshToken)],
    );
    if (!rows[0]) return reply.code(401).send({ error: "invalid_refresh", message: "Session expired. Sign in again." });
    return issueTokens(rows[0].user_id);
  });

  // ---- public info
  app.get("/v1/plans", async () => ({
    free: { messagesPerDay: cfg.FREE_MESSAGES_PER_DAY },
    plus: { messagesPerDay: cfg.PLUS_MESSAGES_PER_DAY, monthly: cfg.PLUS_MONTHLY_PRICE, yearly: cfg.PLUS_YEARLY_PRICE, trialDays: 3 },
    note: "Crisis and safety messages are always free and never blocked.",
  }));
  app.get("/v1/helplines", async (req) => {
    const { country } = z.object({ country: z.string().length(2) }).parse(req.query);
    return helplinesFor(country);
  });

  // ---- me
  app.get("/v1/me", { onRequest: app.auth }, async (req, reply) => {
    const { rows } = await db.query(
      `SELECT u.id, u.plan, u.plan_expires_at, p.name, p.birth_year, p.country, p.situation, p.interested_in, p.tone
       FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`,
      [req.user.sub],
    );
    const r = rows[0];
    if (!r) return reply.code(401).send({ error: "unauthorized", message: "Account not found." });
    const plan = planOf(r);
    const limit = plan === "plus" ? cfg.PLUS_MESSAGES_PER_DAY : cfg.FREE_MESSAGES_PER_DAY;
    return {
      id: r.id,
      plan,
      planExpiresAt: r.plan_expires_at,
      usage: { used: await usedToday(redis, r.id), limit },
      profile: r.name
        ? { name: r.name, birthYear: r.birth_year, country: r.country, situation: r.situation, interestedIn: r.interested_in, tone: r.tone }
        : null,
    };
  });

  app.put("/v1/me/profile", { onRequest: app.auth }, async (req, reply) => {
    const p = ProfileSchema.parse(req.body);
    const age = new Date().getUTCFullYear() - p.birthYear;
    if (age < 18) return reply.code(403).send({ error: "under_18", message: "Wingmate is only for people 18 and over." });
    if (age > 120) return reply.code(400).send({ error: "invalid_input", message: "Check your birth year." });
    await db.query(
      `INSERT INTO profiles(user_id,name,birth_year,country,situation,interested_in,tone) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET name=$2,birth_year=$3,country=$4,situation=$5,interested_in=$6,tone=$7,updated_at=now()`,
      [req.user.sub, p.name, p.birthYear, p.country, p.situation, p.interestedIn, p.tone],
    );
    return { profile: p };
  });

  // Full data export and one-tap deletion: privacy is a feature.
  app.get("/v1/me/export", { onRequest: app.auth }, async (req) => {
    const uid = req.user.sub;
    const [profile, convs, msgs] = await Promise.all([
      db.query("SELECT name,birth_year,country,situation,interested_in,tone FROM profiles WHERE user_id=$1", [uid]),
      db.query("SELECT id,title,created_at FROM conversations WHERE user_id=$1 ORDER BY created_at", [uid]),
      db.query(
        "SELECT m.conversation_id,m.role,m.content,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 ORDER BY m.id",
        [uid],
      ),
    ]);
    return { profile: profile.rows[0] ?? null, conversations: convs.rows, messages: msgs.rows };
  });

  app.delete("/v1/me", { onRequest: app.auth }, async (req, reply) => {
    await db.query("DELETE FROM users WHERE id=$1", [req.user.sub]);
    return reply.code(204).send();
  });

  // ---- RevenueCat → entitlement sync
  app.post("/v1/webhooks/revenuecat", async (req, reply) => {
    const secret = cfg.REVENUECAT_WEBHOOK_SECRET;
    const got = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const ev = z
      .object({ event: z.object({ type: z.string(), app_user_id: z.string(), expiration_at_ms: z.number().nullish() }) })
      .parse(req.body).event;
    if (!/^[0-9a-f-]{36}$/i.test(ev.app_user_id)) return { ok: true, ignored: true };
    const grant = ["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "NON_RENEWING_PURCHASE"];
    if (grant.includes(ev.type)) {
      await db.query("UPDATE users SET plan='plus', plan_expires_at=$2 WHERE id=$1", [
        ev.app_user_id, ev.expiration_at_ms ? new Date(ev.expiration_at_ms) : null,
      ]);
    } else if (ev.type === "EXPIRATION") {
      await db.query("UPDATE users SET plan='free', plan_expires_at=NULL WHERE id=$1", [ev.app_user_id]);
    }
    return { ok: true };
  });

  await app.register(chatRoutes);
  await app.register(assistRoutes);
  return app;
}

export function makeDeps(cfg: Config, db: Db): Deps {
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
  const providers = [{ baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, model: cfg.LLM_MODEL }];
  if (cfg.LLM_FALLBACK_BASE_URL && cfg.LLM_FALLBACK_MODEL) {
    providers.push({ baseUrl: cfg.LLM_FALLBACK_BASE_URL, apiKey: cfg.LLM_FALLBACK_API_KEY, model: cfg.LLM_FALLBACK_MODEL });
  }
  const vision = cfg.LLM_VISION_MODEL
    ? [{ baseUrl: cfg.LLM_VISION_BASE_URL || cfg.LLM_BASE_URL, apiKey: cfg.LLM_VISION_API_KEY || cfg.LLM_API_KEY, model: cfg.LLM_VISION_MODEL }, ...providers.slice(1)]
    : providers;
  return {
    cfg, db, redis,
    llm: new LlmClient(providers, cfg.LLM_FIRST_TOKEN_TIMEOUT_MS, cfg.LLM_TOTAL_TIMEOUT_MS),
    vision: new LlmClient(vision, cfg.LLM_FIRST_TOKEN_TIMEOUT_MS, cfg.LLM_TOTAL_TIMEOUT_MS),
  };
}
