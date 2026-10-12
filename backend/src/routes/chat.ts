import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { planOf } from "../app.js";
import { systemPrompt, summaryPrompt, type Profile } from "../llm/prompt.js";
import type { ChatMessage } from "../llm/provider.js";
import { acquireLock, hit, refundQuota, releaseLock, reserveQuota, usedToday } from "../services/limits.js";
import { detectCrisis, helplinesFor, stripSafetyToken } from "../services/safety.js";

const Id = z.object({ id: z.string().uuid() });

export async function chatRoutes(app: FastifyInstance) {
  const { cfg, db, redis, llm } = app.deps;
  const costMicros = (pt: number, ct: number) => Math.round(pt * cfg.LLM_PRICE_IN_PER_M + ct * cfg.LLM_PRICE_OUT_PER_M);

  app.get("/v1/conversations", { onRequest: app.auth }, async (req) => {
    const { before } = z.object({ before: z.string().datetime().optional() }).parse(req.query);
    const { rows } = await db.query(
      `SELECT id,title,message_count,updated_at FROM conversations
       WHERE user_id=$1 AND ($2::timestamptz IS NULL OR updated_at < $2) ORDER BY updated_at DESC LIMIT 30`,
      [req.user.sub, before ?? null],
    );
    return { conversations: rows };
  });

  app.post("/v1/conversations", { onRequest: app.auth }, async (req, reply) => {
    const { rows } = await db.query("INSERT INTO conversations(user_id) VALUES ($1) RETURNING id,title,created_at", [req.user.sub]);
    return reply.code(201).send(rows[0]);
  });

  app.delete("/v1/conversations/:id", { onRequest: app.auth }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    await db.query("DELETE FROM conversations WHERE id=$1 AND user_id=$2", [id, req.user.sub]);
    return reply.code(204).send();
  });

  app.get("/v1/conversations/:id/messages", { onRequest: app.auth }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(req.query);
    const own = await db.query("SELECT 1 FROM conversations WHERE id=$1 AND user_id=$2", [id, req.user.sub]);
    if (!own.rowCount) return reply.code(404).send({ error: "not_found", message: "Chat not found." });
    const { rows } = await db.query(
      `SELECT id,role,content,safety,created_at FROM messages
       WHERE conversation_id=$1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 50`,
      [id, before ?? null],
    );
    return { messages: rows.reverse() };
  });

  // Send a message; the reply streams back as Server-Sent Events:
  //   event: safety {lines, directory, emergency}   (only when needed, sent first)
  //   event: delta  {text}
  //   event: done   {messageId, remaining, plan}
  //   event: error  {error, message}
  app.post("/v1/conversations/:id/messages", { onRequest: app.auth }, async (req, reply) => {
    const uid = req.user.sub;
    const { id } = Id.parse(req.params);
    const { content } = z.object({ content: z.string().trim().min(1).max(cfg.MAX_INPUT_CHARS) }).parse(req.body);

    if (!(await hit(redis, `msg:${uid}`, 20, 60))) return reply.code(429).send({ error: "rate_limited", message: "Slow down a little and try again." });

    const { rows } = await db.query(
      `SELECT c.summary, c.summarized_upto, c.message_count, u.plan, u.plan_expires_at,
              p.name, p.birth_year, p.country, p.situation, p.interested_in, p.tone
       FROM conversations c JOIN users u ON u.id=c.user_id LEFT JOIN profiles p ON p.user_id=u.id
       WHERE c.id=$1 AND c.user_id=$2`,
      [id, uid],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found", message: "Chat not found." });
    if (!row.name) return reply.code(409).send({ error: "profile_required", message: "Finish setting up your profile first." });

    const plan = planOf(row);
    const limit = plan === "plus" ? cfg.PLUS_MESSAGES_PER_DAY : cfg.FREE_MESSAGES_PER_DAY;
    const crisis = detectCrisis(content);

    if (!(await acquireLock(redis, uid))) return reply.code(409).send({ error: "busy", message: "Wait for the current reply to finish." });

    let charged = false;
    let remaining = limit - (await usedToday(redis, uid));
    try {
      if (!crisis) {
        remaining = await reserveQuota(redis, uid, limit);
        if (remaining < 0) {
          return reply.code(402).send({
            error: "quota_exhausted",
            message: plan === "plus" ? "You've hit today's fair-use limit. It resets tomorrow." : `You've used your ${limit} free messages today. They reset tomorrow, or upgrade to Plus.`,
            plan,
          });
        }
        charged = true;
      }

      const ins = await db.query<{ id: string }>("INSERT INTO messages(conversation_id,role,content,safety) VALUES ($1,'user',$2,$3) RETURNING id", [id, content, crisis]);
      const userMsgId = Number(ins.rows[0].id);

      const recent = await db.query<{ role: "user" | "assistant"; content: string }>(
        "SELECT role,content FROM messages WHERE conversation_id=$1 AND id > $2 ORDER BY id DESC LIMIT $3",
        [id, row.summarized_upto, cfg.CONTEXT_MESSAGES],
      );
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt(row as Profile, row.summary) },
        ...recent.rows.reverse().map((m) => ({ role: m.role, content: m.content })),
      ];

      // ---- stream
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      if (crisis) send("safety", helplinesFor(row.country));

      const ctl = new AbortController();
      res.on("close", () => { if (!res.writableFinished) ctl.abort(); }); // user left: stop paying for tokens

      // Hold back the first few characters so a leading [SAFETY] token is never shown.
      let pending = "";
      let started = false;
      try {
        const result = await llm.chat(messages, plan === "plus" ? cfg.MAX_REPLY_TOKENS_PLUS : cfg.MAX_REPLY_TOKENS_FREE, {
          signal: ctl.signal,
          onDelta: (d) => {
            if (started) return send("delta", { text: d });
            pending += d;
            if (pending.length < 10 && "[SAFETY]".startsWith(pending.trimStart())) return;
            started = true;
            const s = stripSafetyToken(pending);
            if (s.flagged && !crisis) send("safety", helplinesFor(row.country));
            if (s.text) send("delta", { text: s.text });
          },
        });
        const { text, flagged } = stripSafetyToken(result.text);
        if (flagged && !started && !crisis) send("safety", helplinesFor(row.country));
        if (!started && text) send("delta", { text });
        const safety = crisis || flagged;
        if (safety && charged) { await refundQuota(redis, uid); charged = false; remaining++; }

        const a = await db.query<{ id: string }>(
          `INSERT INTO messages(conversation_id,role,content,safety,model,prompt_tokens,completion_tokens,cost_micros)
           VALUES ($1,'assistant',$2,$3,$4,$5,$6,$7) RETURNING id`,
          [id, text, safety, result.model, result.usage.promptTokens, result.usage.completionTokens, costMicros(result.usage.promptTokens, result.usage.completionTokens)],
        );
        await db.query(
          `UPDATE conversations SET message_count=message_count+2, updated_at=now(),
             title = CASE WHEN message_count=0 THEN left($2, 48) ELSE title END WHERE id=$1`,
          [id, content],
        );
        send("done", { messageId: Number(a.rows[0].id), remaining: Math.max(0, remaining), plan });
        res.end();
        const count = row.message_count + 2;
        if (count >= cfg.SUMMARIZE_AFTER && count % 8 === 0) void summarize(id).catch((e) => app.log.warn(e, "summarize failed"));
      } catch (e) {
        const err = e as { message?: string; streamed?: boolean };
        // No complete answer was delivered, so the message is never charged.
        if (charged) { await refundQuota(redis, uid); charged = false; }
        // If nothing reached the user, remove their message too so a retry is clean.
        if (!err.streamed) await db.query("DELETE FROM messages WHERE id=$1", [userMsgId]);
        if (!ctl.signal.aborted) send("error", { error: "llm_unavailable", message: "Couldn't get a reply right now. Try again in a moment." });
        res.end();
      }
    } finally {
      await releaseLock(redis, uid);
    }
  });

  /** Folds older messages into a short running summary so prompts stay small as chats grow. */
  async function summarize(conversationId: string) {
    const lock = await redis.set(`sum:${conversationId}`, "1", "EX", 120, "NX");
    if (!lock) return;
    try {
      const c = await db.query<{ summary: string; summarized_upto: string }>("SELECT summary, summarized_upto FROM conversations WHERE id=$1", [conversationId]);
      if (!c.rows[0]) return;
      const old = await db.query<{ id: string; role: string; content: string }>(
        `SELECT id,role,content FROM messages WHERE conversation_id=$1 AND id > $2 ORDER BY id`,
        [conversationId, c.rows[0].summarized_upto],
      );
      const fold = old.rows.slice(0, Math.max(0, old.rows.length - cfg.CONTEXT_MESSAGES));
      if (fold.length < 4) return;
      const transcript = fold.map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n");
      const r = await llm.chat(summaryPrompt(c.rows[0].summary, transcript), 160);
      await db.query("UPDATE conversations SET summary=$2, summarized_upto=$3 WHERE id=$1", [conversationId, r.text.trim().slice(0, 1200), fold[fold.length - 1].id]);
    } finally {
      await redis.del(`sum:${conversationId}`);
    }
  }
}
