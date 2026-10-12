// Load test against a running API (point it at the fake LLM so no money is spent).
//   API_URL=http://localhost:8080 RC_SECRET=... USERS=300 node scripts/loadtest.mjs
import autocannon from "autocannon";

const API = process.env.API_URL ?? "http://localhost:8080";
const USERS = Number(process.env.USERS ?? 300);
const RC = process.env.RC_SECRET ?? "";
const year = new Date().getUTCFullYear();

async function j(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function makeUser(i) {
  const t = await j("/v1/auth/anonymous", { method: "POST", body: "{}", headers: { "x-forwarded-for": `10.0.${(i >> 8) & 255}.${i & 255}` } });
  const h = { authorization: `Bearer ${t.accessToken}` };
  await j("/v1/me/profile", { method: "PUT", headers: h, body: JSON.stringify({ name: `U${i}`, birthYear: year - 25, country: "US", situation: "talking", interestedIn: "everyone", tone: "direct" }) });
  if (RC) await j("/v1/webhooks/revenuecat", { method: "POST", headers: { authorization: `Bearer ${RC}` }, body: JSON.stringify({ event: { type: "INITIAL_PURCHASE", app_user_id: t.userId, expiration_at_ms: Date.now() + 864e5 } }) });
  const c = await j("/v1/conversations", { method: "POST", headers: h, body: "{}" });
  return { h, conv: c.id };
}

async function chat(u) {
  const t0 = performance.now();
  const r = await fetch(`${API}/v1/conversations/${u.conv}/messages`, { method: "POST", headers: { ...u.h, "content-type": "application/json" }, body: JSON.stringify({ content: "He replies fast at night but slow on weekdays. Is he losing interest?" }) });
  const body = await r.text();
  return { ok: r.ok && body.includes("event: done"), ms: performance.now() - t0 };
}

const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

console.log(`Creating ${USERS} users…`);
const users = [];
for (let i = 0; i < USERS; i += 50) users.push(...(await Promise.all(Array.from({ length: Math.min(50, USERS - i) }, (_, k) => makeUser(i + k)))));

console.log(`\n1) ${USERS} users each send a chat message at the same moment (streamed replies)`);
let t0 = performance.now();
const results = await Promise.all(users.map(chat));
const wall = performance.now() - t0;
const ms = results.map((r) => r.ms);
console.log(`   success ${results.filter((r) => r.ok).length}/${USERS}, wall ${Math.round(wall)}ms, p50 ${Math.round(pct(ms, 0.5))}ms, p95 ${Math.round(pct(ms, 0.95))}ms`);

console.log(`\n2) Authenticated read path (GET /v1/me: JWT + Postgres + Redis), 100 connections, 10s`);
const r = await autocannon({ url: `${API}/v1/me`, connections: 100, duration: 10, headers: users[0].h });
console.log(`   ${Math.round(r.requests.average)} req/s avg, p50 ${r.latency.p50}ms, p99 ${r.latency.p99}ms, errors ${r.errors}, non-2xx ${r.non2xx}`);
