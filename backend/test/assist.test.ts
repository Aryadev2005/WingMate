import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseResult } from "../src/routes/assist.js";
import { setup } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.close(); });

const JSON_REPLY = '```json\n{"suggestions":["Thursday works, where are we going?","Only if you pick the bar","Deal. Loser buys fries"]}\n```';
const PNG = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");

async function user() {
  const tok = (await t.app.inject({ method: "POST", url: "/v1/auth/anonymous" })).json();
  const h = { authorization: `Bearer ${tok.accessToken}` };
  await t.app.inject({
    method: "PUT", url: "/v1/me/profile", headers: h,
    payload: { name: "Sam", birthYear: new Date().getUTCFullYear() - 22, country: "US", situation: "single", interestedIn: "everyone", tone: "funny" },
  });
  return { h, id: tok.userId as string };
}
const assist = (h: object, payload: object) => t.app.inject({ method: "POST", url: "/v1/assist", headers: h, payload });

beforeEach(() => {
  t.primary.mode = "ok";
  t.primary.reply = JSON_REPLY;
  t.fallback.mode = "ok";
});

describe("reply lab", () => {
  it("turns pasted chat into 3 replies, tracks cost, stores no text", async () => {
    const u = await user();
    const r = await assist(u.h, { mode: "reply", tone: "funny", text: "Them: drinks thursday?" });
    expect(r.statusCode).toBe(200);
    expect(r.json().suggestions).toHaveLength(3);
    expect(r.json().remaining).toBe(4);
    const ev = await t.deps.db.query("SELECT * FROM assist_events WHERE user_id=$1", [u.id]);
    expect(ev.rows[0].mode).toBe("reply");
    expect(ev.rows[0].cost_micros).toBeGreaterThan(0);
    expect(JSON.stringify(ev.rows[0])).not.toContain("thursday");
    expect(t.primary.calls.at(-1).model).toBe("primary-model");
  });

  it("sends screenshots to the vision model as an image part", async () => {
    const u = await user();
    const r = await assist(u.h, { mode: "opener", image: PNG });
    expect(r.statusCode).toBe(200);
    const call = t.primary.calls.at(-1);
    expect(call.model).toBe("vision-model");
    expect(call.messages[1].content[0].type).toBe("image_url");
    expect(call.messages[1].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("asks for new suggestions on 'More' and returns bio feedback", async () => {
    const u = await user();
    t.primary.reply = '{"suggestions":["a","b","c"],"feedback":"Lead with a specific hobby."}';
    const r = await assist(u.h, { mode: "bio", text: "I like travel and food", avoid: ["old one"] });
    expect(r.json().feedback).toContain("hobby");
    expect(t.primary.calls.at(-1).messages[0].content).toContain('"old one"');
  });

  it("rejects bad or oversized images without charging", async () => {
    const u = await user();
    expect((await assist(u.h, { mode: "reply", image: "data:image/gif;base64,AAAA" })).statusCode).toBe(400);
    const big = "A".repeat(2_100_000);
    expect((await assist(u.h, { mode: "reply", image: big })).statusCode).toBe(413);
    expect((await assist(u.h, { mode: "reply" })).statusCode).toBe(400);
    const me = (await t.app.inject({ method: "GET", url: "/v1/me", headers: u.h })).json();
    expect(me.usage.used).toBe(0);
  });

  it("refunds when the model returns garbage", async () => {
    const u = await user();
    t.primary.reply = "sorry I can't do JSON today";
    const r = await assist(u.h, { mode: "reply", text: "hey" });
    expect(r.statusCode).toBe(502);
    const me = (await t.app.inject({ method: "GET", url: "/v1/me", headers: u.h })).json();
    expect(me.usage.used).toBe(0);
  });

  it("shares the daily free quota with chat", async () => {
    const u = await user();
    for (let i = 0; i < 5; i++) expect((await assist(u.h, { mode: "reply", text: `msg ${i}` })).statusCode).toBe(200);
    expect((await assist(u.h, { mode: "reply", text: "one more" })).statusCode).toBe(402);
  });

  it("attaches helplines when pasted text mentions a crisis", async () => {
    const u = await user();
    const r = await assist(u.h, { mode: "reply", text: "Them: I want to die honestly" });
    expect(r.json().safety.lines[0].contact).toContain("988");
  });
});

describe("parseResult", () => {
  it("handles fences and stray text, rejects bad shapes", () => {
    expect(parseResult('Sure! {"suggestions":["x"]} hope that helps')?.suggestions).toEqual(["x"]);
    expect(parseResult('{"suggestions":[]}')).toBeNull();
    expect(parseResult("no json")).toBeNull();
  });
});
