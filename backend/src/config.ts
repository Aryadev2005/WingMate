import { z } from "zod";

const num = (d: number) => z.coerce.number().default(d);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: num(8080),
  HOST: z.string().default("0.0.0.0"),
  WEB_CONCURRENCY: num(1),
  DATABASE_URL: z.string().default("postgres://postgres@localhost:5432/wingmate"),
  DB_POOL_MAX: num(20),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32).default("dev-only-secret-change-me-dev-only-secret"),
  ACCESS_TOKEN_TTL: z.string().default("1h"),
  REFRESH_TOKEN_DAYS: num(90),

  // Any OpenAI-compatible chat API (OpenRouter, DeepSeek, Gemini OpenAI endpoint, Together, Groq...)
  LLM_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("deepseek/deepseek-chat"),
  LLM_PRICE_IN_PER_M: num(0.3), // USD per 1M input tokens, for cost tracking
  LLM_PRICE_OUT_PER_M: num(1.0), // USD per 1M output tokens
  // Optional fallback provider, used only if the primary fails before streaming starts
  LLM_FALLBACK_BASE_URL: z.string().default(""),
  LLM_FALLBACK_API_KEY: z.string().default(""),
  LLM_FALLBACK_MODEL: z.string().default(""),
  LLM_FIRST_TOKEN_TIMEOUT_MS: num(20000),
  LLM_TOTAL_TIMEOUT_MS: num(60000),

  FREE_MESSAGES_PER_DAY: num(5),
  PLUS_MESSAGES_PER_DAY: num(300), // fair-use cap protects margin
  MAX_REPLY_TOKENS_FREE: num(350),
  MAX_REPLY_TOKENS_PLUS: num(600),
  CONTEXT_MESSAGES: num(8),
  SUMMARIZE_AFTER: num(16),
  MAX_INPUT_CHARS: num(2000),

  PLUS_MONTHLY_PRICE: z.string().default("$7.99"),
  PLUS_YEARLY_PRICE: z.string().default("$49.99"),
  REVENUECAT_WEBHOOK_SECRET: z.string().default(""),
  CORS_ORIGIN: z.string().default("*"),
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = schema.parse(env);
  if (c.NODE_ENV === "production") {
    if (c.JWT_SECRET.startsWith("dev-only")) throw new Error("Set JWT_SECRET in production");
    if (!c.LLM_API_KEY) throw new Error("Set LLM_API_KEY in production");
  }
  return c;
}
