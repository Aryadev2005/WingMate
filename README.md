# Wingmate

A private AI dating and relationship advisor for adults 18–30, anywhere in the world. Decode their texts, draft your reply, spot red flags, get through a breakup.

```
mobile/    Expo (React Native) app for iOS and Android
backend/   Node 22 + Fastify API, Postgres, Redis, any OpenAI-compatible LLM
```

## What we fixed vs. Hot Girl Hotline

Hot Girl Hotline launched recently and has almost no public user reviews yet. These fixes target its documented weak points (from its listing and press) plus the most common complaints about AI advice apps in general.

| Complaint | Source | What Wingmate does |
|---|---|---|
| Phone number required to sign up | HGH listing | Anonymous account. No phone, no email. Token stored in the device keychain. |
| Paywall hits after a few messages, without warning | HGH listing | Live "N of 5 left today" counter, resets daily. Failed replies are never charged. |
| Pricing not clear before paying | HGH listing | `/v1/plans` + paywall show prices up front; store prices are localized per country. |
| Only for women | HGH positioning | All genders and orientations. The AI never assumes the other person's gender. |
| Language support unclear | HGH listing | Replies in whatever language the user writes in. |
| Crisis help locked behind a paywall | Category risk | Crisis messages are **always free**, never blocked by the quota, and show local helplines instantly. |
| Generic advice that forgets context | Category complaint | Profile (situation, tone) in every prompt, plus a rolling summary of long chats. Last chat resumes on open. |
| AI just agrees with you | Category complaint | Prompt requires honest, specific advice, not validation. User picks Gentle / Straight-up / Funny. |
| Privacy fears (chats leaked or sold) | Category complaint | One-tap full account deletion, data export, no data sold, minimal data stored. |
| AI helps with manipulation or snooping | Category risk | Refuses jealousy games, phone-checking, pressure about sex; offers a healthier route. |

## Reply Lab (Rizz and Plug AI features, done better)

A second tab next to the Coach chat:

| Mode | Input | Output |
|---|---|---|
| Reply to a chat | Screenshot or pasted conversation | 3 next messages to send |
| Opening line | Screenshot of their profile, or their bio | 3 openers that mention something specific |
| Fix my bio | Your own profile | Honest feedback + 3 rewritten bios |

Pick a vibe (Smooth, Flirty, Funny, Chill, Bold), tap a suggestion to copy it, or "More like this" for fresh options that don't repeat.

Fixes for what users complain about in those apps' App Store reviews:

| Their complaint | Wingmate |
|---|---|
| Replies are cheesy / "cringe" | Prompt bans pickup-line clichés and requires short, natural messages that reference the actual chat or profile. |
| Generation loads forever | First-token and total timeouts, fallback provider, clear error, and the try is refunded. |
| Random, odd replies | Model output must be valid JSON in the expected shape or it's rejected and refunded. |
| Keyboard extension gets stuck or grows | No keyboard extension. Copy-to-clipboard instead. |
| Subscription required up front | Shares the free daily allowance with chat. |

Screenshots are read by **Gemini 2.5 Flash-Lite** ($0.10 / $0.40 per 1M tokens) through Gemini's OpenAI-compatible endpoint. Set `LLM_VISION_API_KEY` (from Google AI Studio) and it works; the model and endpoint are already the defaults. Screenshots are shrunk to 900px on the phone first, so a screenshot reply costs roughly $0.0003. They're never stored; only cost and mode are logged (`assist_events`), priced at the vision model's own rate.

## Backend

**Stack:** Fastify, Postgres (plain SQL, auto-migrations with advisory lock), Redis (quotas, rate limits, locks), Zod validation, JWT + rotating refresh tokens.

### Endpoints

| Method | Path | |
|---|---|---|
| POST | `/v1/auth/anonymous` | Create account, returns access + refresh tokens |
| POST | `/v1/auth/refresh` | Rotate refresh token |
| GET | `/v1/me` | Plan, today's usage, profile |
| PUT | `/v1/me/profile` | Save profile (18+ enforced) |
| GET | `/v1/me/export` | Download all your data |
| DELETE | `/v1/me` | Delete account and every chat |
| GET/POST | `/v1/conversations` | List / create chats |
| GET | `/v1/conversations/:id/messages` | History (paginated) |
| POST | `/v1/conversations/:id/messages` | Send; reply streams as SSE: `safety`, `delta`, `done`, `error` |
| DELETE | `/v1/conversations/:id` | Delete a chat |
| POST | `/v1/assist` | Reply Lab: `{mode: reply\|opener\|bio, tone, text?, image?, avoid?}` → 3 suggestions |
| GET | `/v1/plans`, `/v1/helplines?country=US` | Public info |
| POST | `/v1/webhooks/revenuecat` | Subscription sync |
| GET | `/health`, `/ready` | Liveness / readiness |

### Cheap LLM, healthy margin

No Claude or OpenAI key required. Point `LLM_BASE_URL` at any OpenAI-compatible provider (OpenRouter, DeepSeek, Gemini's OpenAI endpoint, Groq, Together) and pick a cheap model. Reply Lab screenshots use a separate image-capable model (Gemini 2.5 Flash-Lite by default). A second provider can be set as automatic fallback.

Token savings built in:
- Short system prompt; only the last 8 messages are sent.
- Older messages are folded into an ~80-word running summary.
- Reply length capped (350 tokens free, 600 Plus).
- If the user closes the app mid-reply, the upstream request is cancelled, so you stop paying.
- Every reply stores prompt/completion tokens and cost (`messages.cost_micros`), so margin is measurable per user:

```sql
SELECT date_trunc('day', created_at) d, count(*) replies, sum(cost_micros)/1e6 AS usd
FROM messages WHERE role='assistant' GROUP BY 1 ORDER BY 1 DESC;
```

Rough math at $0.30 / $1.00 per million input/output tokens: a typical reply is ~900 input + 150 output tokens ≈ **$0.0004**. A heavy Plus user sending 50 messages a day costs ≈ $0.63/month against $7.99. Set your provider's real prices in `.env` and check the query above.

### Built for 1 lakh users

- Stateless API: scale horizontally behind a load balancer; `WEB_CONCURRENCY` runs one Node process per core.
- Atomic Redis quotas, per-user and per-IP rate limits, and one in-flight reply per user (stops parallel-request abuse).
- Indexed queries only; cursor pagination; DB statement timeout; graceful shutdown.
- LLM first-token and total timeouts; fallback provider if the primary fails before streaming.

Load test on a 2-core sandbox (API ×4 processes, Postgres, Redis and a fake LLM streaming ~1s replies, all on the same box):

| Test | Result |
|---|---|
| 500 users send a message at the same instant | 500/500 succeeded, p50 2.9s, p95 4.0s (includes the 1s simulated model time) |
| Authenticated reads (`GET /v1/me`), 100 connections | ~2,900 req/s, p50 28ms, p99 110ms, 0 errors |

1 lakh registered users typically means a few hundred chatting at the same moment at peak, which a couple of 2-vCPU instances plus managed Postgres and Redis cover. Your LLM provider's rate limit is usually the real ceiling; raise it before launch.

### Run it

```bash
cd backend
cp .env.example .env        # set JWT_SECRET and LLM_API_KEY
docker compose -f ../docker-compose.yml up --build
# or without Docker: npm install && npm run dev
```

Tests (28 integration tests against real Postgres + Redis, fake LLM):

```bash
cd backend && npm test
# load test with no LLM cost:
PORT=9999 node scripts/fake-llm.mjs &
LLM_BASE_URL=http://127.0.0.1:9999 npm run dev &
API_URL=http://localhost:8080 RC_SECRET=<your secret> USERS=500 npm run loadtest
```

CI runs typecheck and tests on every push (`.github/workflows/backend.yml`).

## Mobile

Expo SDK 57, TypeScript. Screens: onboarding (18+ gate, country, situation, interested in, tone), streaming chat with copyable draft replies and safety cards, Plus paywall (RevenueCat), settings with account deletion.

```bash
cd mobile
npm install
EXPO_PUBLIC_API_URL=http://<your-ip>:8080 npx expo start
```

Subscriptions need a development build (`npx expo run:ios` / `run:android` or EAS Build), plus:
- `EXPO_PUBLIC_RC_IOS_KEY`, `EXPO_PUBLIC_RC_ANDROID_KEY` from RevenueCat
- A RevenueCat webhook to `https://<api>/v1/webhooks/revenuecat` with the same secret as `REVENUECAT_WEBHOOK_SECRET`

## Before launch

- Have a professional review the crisis helplines (`backend/src/services/safety.ts`) and the safety wording.
- Write a privacy policy and terms (required by both stores for an AI chat app).
- Pick a final name and check trademarks; "Wingmate" is a working title.
