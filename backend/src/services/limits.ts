import type { Redis } from "ioredis";

const day = () => new Date().toISOString().slice(0, 10);

/** Fixed-window counter. Returns true while under the limit. */
export async function hit(redis: Redis, key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  return n <= limit;
}

/** Atomically reserves one message from today's quota. Returns remaining after reserve, or -1 if exhausted. */
export async function reserveQuota(redis: Redis, userId: string, limit: number): Promise<number> {
  const k = `q:${userId}:${day()}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 60 * 60 * 26);
  if (n > limit) {
    await redis.decr(k);
    return -1;
  }
  return limit - n;
}

export async function refundQuota(redis: Redis, userId: string): Promise<void> {
  const k = `q:${userId}:${day()}`;
  const n = await redis.decr(k);
  if (n < 0) await redis.set(k, 0, "KEEPTTL");
}

export async function usedToday(redis: Redis, userId: string): Promise<number> {
  return Number((await redis.get(`q:${userId}:${day()}`)) ?? 0);
}

/** One reply generating at a time per user: stops parallel-request quota abuse. */
export async function acquireLock(redis: Redis, userId: string, ttlSec = 90): Promise<boolean> {
  return (await redis.set(`lock:${userId}`, "1", "EX", ttlSec, "NX")) === "OK";
}
export async function releaseLock(redis: Redis, userId: string): Promise<void> {
  await redis.del(`lock:${userId}`);
}
