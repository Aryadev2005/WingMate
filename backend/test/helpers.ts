import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, makeDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, migrate } from "../src/db.js";

export type Mode = "ok" | "fail" | "safety" | "midfail";
export type FakeLlm = { url: string; mode: Mode; reply: string; calls: any[]; close: () => Promise<void> };

/** OpenAI-compatible fake that streams SSE like the real providers. */
export async function fakeLlm(): Promise<FakeLlm> {
  const state: FakeLlm = { url: "", mode: "ok", reply: "Sounds like a schedule thing.\nDraft: \"Drinks Thursday?\"", calls: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      state.calls.push(j);
      if (state.mode === "fail") { res.writeHead(500); return res.end("boom"); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = state.mode === "safety" ? "[SAFETY]\nI'm really glad you told me." : state.reply;
      const chunks = text.match(/.{1,6}/gs) ?? [];
      if (state.mode === "midfail") {
        // Send some text, then cut the connection without a finish marker.
        chunks.slice(0, 2).forEach((c) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`));
        setTimeout(() => res.destroy(), 30);
        return;
      }
      chunks.forEach((c) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`));
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

export async function setup(extra: Record<string, string> = {}) {
  const primary = await fakeLlm();
  const fallback = await fakeLlm();
  fallback.reply = "Fallback reply.";
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/wingmate_test",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
    LLM_BASE_URL: primary.url,
    LLM_API_KEY: "test",
    LLM_MODEL: "primary-model",
    LLM_VISION_BASE_URL: primary.url,
    LLM_VISION_API_KEY: "test",
    LLM_VISION_MODEL: "vision-model",
    LLM_FALLBACK_BASE_URL: fallback.url,
    LLM_FALLBACK_MODEL: "fallback-model",
    REVENUECAT_WEBHOOK_SECRET: "rc-secret",
    SUMMARIZE_AFTER: "8",
    CONTEXT_MESSAGES: "4",
    ...extra,
  });
  const db = createDb(cfg.DATABASE_URL, 5);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const deps = makeDeps(cfg, db);
  await deps.redis.flushdb();
  const app = await buildApp(deps);
  await app.ready();
  return {
    app, deps, primary, fallback,
    async close() {
      await app.close();
      await db.end();
      await deps.redis.quit();
      await primary.close();
      await fallback.close();
    },
  };
}

export function parseSse(body: string) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const ev = /event: (.+)/.exec(block)?.[1];
      const data = /data: (.+)/.exec(block)?.[1];
      return { event: ev!, data: data ? JSON.parse(data) : null };
    });
}
