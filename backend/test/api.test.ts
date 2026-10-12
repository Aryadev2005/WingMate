import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSse, setup } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.close(); });

const profile = { name: "Maya", birthYear: new Date().getUTCFullYear() - 24, country: "GB", situation: "talking", interestedIn: "men", tone: "direct" };

async function newUser(withProfile = true) {
  const r = await t.app.inject({ method: "POST", url: "/v1/auth/anonymous" });
  expect(r.statusCode).toBe(201);
  const tok = r.json();
  const h = { authorization: `Bearer ${tok.accessToken}` };
  if (withProfile) expect((await t.app.inject({ method: "PUT", url: "/v1/me/profile", headers: h, payload: profile })).statusCode).toBe(200);
  const c = await t.app.inject({ method: "POST", url: "/v1/conversations", headers: h });
  return { ...tok, h, convId: c.json().id as string };
}
const send = (u: { h: any; convId: string }, content: string) =>
  t.app.inject({ method: "POST", url: `/v1/conversations/${u.convId}/messages`, headers: u.h, payload: { content } });

describe("auth", () => {
  it("signs up without phone or email, and rotates refresh tokens", async () => {
    const u = await newUser(false);
    expect(u.accessToken).toBeTruthy();
    const r1 = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: u.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const r2 = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: u.refreshToken } });
    expect(r2.statusCode).toBe(401); // old token is single-use
  });
  it("rejects requests without a token", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
  });
});

describe("profile", () => {
  it("blocks under-18s", async () => {
    const u = await newUser(false);
    const r = await t.app.inject({ method: "PUT", url: "/v1/me/profile", headers: u.h, payload: { ...profile, birthYear: new Date().getUTCFullYear() - 16 } });
    expect(r.statusCode).toBe(403);
  });
  it("validates input", async () => {
    const u = await newUser(false);
    const r = await t.app.inject({ method: "PUT", url: "/v1/me/profile", headers: u.h, payload: { ...profile, tone: "mean" } });
    expect(r.statusCode).toBe(400);
  });
  it("requires a profile before chatting", async () => {
    const u = await newUser(false);
    expect((await send(u, "hi")).statusCode).toBe(409);
  });
});

describe("chat", () => {
  it("streams a reply, stores it with cost, and titles the chat", async () => {
    t.primary.mode = "ok";
    const u = await newUser();
    const r = await send(u, "He replies fast at night but slow on weekdays");
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const ev = parseSse(r.body);
    const text = ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
    expect(text).toContain("Draft:");
    const done = ev.find((e) => e.event === "done")!;
    expect(done.data.remaining).toBe(4);
    const { rows } = await t.deps.db.query("SELECT role, cost_micros, prompt_tokens FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.id=$1 ORDER BY m.id", [u.convId]);
    expect(rows.map((x: any) => x.role)).toEqual(["user", "assistant"]);
    expect(rows[1].prompt_tokens).toBe(120);
    expect(rows[1].cost_micros).toBe(Math.round(120 * 0.3 + 30 * 1.0));
    const list = await t.app.inject({ method: "GET", url: "/v1/conversations", headers: u.h });
    expect(list.json().conversations[0].title).toContain("He replies fast");
    // System prompt carries the profile
    expect(t.primary.calls.at(-1).messages[0].content).toContain("Maya");
  });

  it("enforces the free daily quota but never blocks a crisis message", async () => {
    t.primary.mode = "ok";
    const u = await newUser();
    for (let i = 0; i < 5; i++) expect((await send(u, `question ${i}`)).statusCode).toBe(200);
    const blocked = await send(u, "one more");
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error).toBe("quota_exhausted");
    t.primary.mode = "safety";
    const crisis = await send(u, "I want to die, I can't do this anymore");
    expect(crisis.statusCode).toBe(200);
    const ev = parseSse(crisis.body);
    expect(ev[0].event).toBe("safety");
    expect(ev[0].data.lines[0].contact).toContain("116 123");
    expect(ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).not.toContain("[SAFETY]");
  });

  it("strips the model's [SAFETY] token, shows helplines, and doesn't charge", async () => {
    t.primary.mode = "safety";
    const u = await newUser();
    const ev = parseSse((await send(u, "things are bad with my partner lately")).body);
    expect(ev.some((e) => e.event === "safety")).toBe(true);
    const text = ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
    expect(text).not.toContain("[SAFETY]");
    expect(text).toContain("glad you told me");
    const me = await t.app.inject({ method: "GET", url: "/v1/me", headers: u.h });
    expect(me.json().usage.used).toBe(0);
  });

  it("falls back to the second provider when the first fails", async () => {
    t.primary.mode = "fail";
    t.fallback.mode = "ok";
    const u = await newUser();
    const ev = parseSse((await send(u, "hello")).body);
    expect(ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe("Fallback reply.");
  });

  it("refunds quota and removes the message when every provider fails", async () => {
    t.primary.mode = "fail";
    t.fallback.mode = "fail";
    const u = await newUser();
    const ev = parseSse((await send(u, "hello")).body);
    expect(ev.at(-1)!.event).toBe("error");
    const me = await t.app.inject({ method: "GET", url: "/v1/me", headers: u.h });
    expect(me.json().usage.used).toBe(0);
    const msgs = await t.app.inject({ method: "GET", url: `/v1/conversations/${u.convId}/messages`, headers: u.h });
    expect(msgs.json().messages).toHaveLength(0);
    t.fallback.mode = "ok";
  });

  it("never restarts an answer on the fallback once text has streamed", async () => {
    t.primary.mode = "midfail";
    t.fallback.mode = "ok";
    const u = await newUser();
    const ev = parseSse((await send(u, "hello")).body);
    const text = ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
    expect(text).not.toContain("Fallback");
    expect(ev.at(-1)!.event).toBe("error");
    t.primary.mode = "ok";
  });

  it("allows only one reply in flight per user", async () => {
    t.primary.mode = "ok";
    const u = await newUser();
    await t.deps.redis.set(`lock:${u.userId}`, "1", "EX", 30);
    expect((await send(u, "hi")).statusCode).toBe(409);
    await t.deps.redis.del(`lock:${u.userId}`);
  });

  it("keeps chats private between users", async () => {
    const a = await newUser();
    const b = await newUser();
    const r = await t.app.inject({ method: "GET", url: `/v1/conversations/${a.convId}/messages`, headers: b.h });
    expect(r.statusCode).toBe(404);
    expect((await send({ h: b.h, convId: a.convId }, "hi")).statusCode).toBe(404);
  });

  it("summarizes long chats so the prompt stays small", async () => {
    t.primary.mode = "ok";
    const u = await newUser();
    await t.deps.db.query("UPDATE users SET plan='plus' WHERE id=$1", [u.userId]);
    for (let i = 0; i < 4; i++) await send(u, `message number ${i} about my situation`);
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await t.deps.db.query("SELECT summary, summarized_upto FROM conversations WHERE id=$1", [u.convId]);
    expect(rows[0].summary.length).toBeGreaterThan(0);
    expect(Number(rows[0].summarized_upto)).toBeGreaterThan(0);
    await send(u, "next");
    const sys = t.primary.calls.at(-1).messages;
    expect(sys[0].content).toContain("What you know from earlier");
    expect(sys.length).toBeLessThanOrEqual(1 + 4);
  });
});

describe("billing", () => {
  const hook = (auth: string, event: object) =>
    t.app.inject({ method: "POST", url: "/v1/webhooks/revenuecat", headers: { authorization: `Bearer ${auth}` }, payload: { event } });

  it("rejects webhooks with the wrong secret", async () => {
    expect((await hook("nope", { type: "INITIAL_PURCHASE", app_user_id: "x" })).statusCode).toBe(401);
  });

  it("grants and revokes Plus", async () => {
    const u = await newUser();
    await hook("rc-secret", { type: "INITIAL_PURCHASE", app_user_id: u.userId, expiration_at_ms: Date.now() + 86400000 });
    let me = (await t.app.inject({ method: "GET", url: "/v1/me", headers: u.h })).json();
    expect(me.plan).toBe("plus");
    expect(me.usage.limit).toBe(300);
    await hook("rc-secret", { type: "EXPIRATION", app_user_id: u.userId });
    me = (await t.app.inject({ method: "GET", url: "/v1/me", headers: u.h })).json();
    expect(me.plan).toBe("free");
  });

  it("lists plans publicly", async () => {
    const r = await t.app.inject({ method: "GET", url: "/v1/plans" });
    expect(r.json().free.messagesPerDay).toBe(5);
  });
});

describe("privacy", () => {
  it("exports and fully deletes an account", async () => {
    t.primary.mode = "ok";
    const u = await newUser();
    await send(u, "hello");
    const ex = (await t.app.inject({ method: "GET", url: "/v1/me/export", headers: u.h })).json();
    expect(ex.messages.length).toBe(2);
    expect((await t.app.inject({ method: "DELETE", url: "/v1/me", headers: u.h })).statusCode).toBe(204);
    const left = await t.deps.db.query("SELECT count(*)::int n FROM conversations WHERE user_id=$1", [u.userId]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe("health", () => {
  it("reports ready when db and redis are up", async () => {
    expect((await t.app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });
});
