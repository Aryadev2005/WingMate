import * as SecureStore from "expo-secure-store";
import { fetch as streamFetch } from "expo/fetch";

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

export type Profile = {
  name: string;
  birthYear: number;
  country: string;
  situation: "single" | "talking" | "dating" | "relationship" | "breakup" | "complicated";
  interestedIn: "men" | "women" | "everyone" | "unsaid";
  tone: "gentle" | "direct" | "funny";
};
export type Me = { id: string; plan: "free" | "plus"; usage: { used: number; limit: number }; profile: Profile | null };
export type Message = { id?: number; role: "user" | "assistant"; content: string; safety?: boolean };
export type Helplines = { lines: { name: string; contact: string }[]; directory: string; emergency: string };
export type Plans = { free: { messagesPerDay: number }; plus: { messagesPerDay: number; monthly: string; yearly: string; trialDays: number } };

export type AssistMode = "reply" | "opener" | "bio";
export type AssistTone = "flirty" | "funny" | "smooth" | "chill" | "bold";
export type AssistResult = { suggestions: string[]; feedback?: string; safety?: Helplines; remaining: number; plan: "free" | "plus" };

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(message);
  }
}

let access: string | null = null;
const KEY = "wingmate.refresh";

async function signIn(): Promise<void> {
  const refresh = await SecureStore.getItemAsync(KEY);
  if (refresh) {
    const r = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (r.ok) return store(await r.json());
  }
  // No phone number, no email: a private anonymous account.
  const r = await fetch(`${API_URL}/v1/auth/anonymous`, { method: "POST" });
  if (!r.ok) throw new ApiError("network", "Can't reach Wingmate. Check your connection.");
  await store(await r.json());
}
async function store(t: { accessToken: string; refreshToken: string }) {
  access = t.accessToken;
  await SecureStore.setItemAsync(KEY, t.refreshToken);
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  if (!access) await signIn();
  let r: Response;
  try {
    r = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${access}`, ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError("network", "Can't reach Wingmate. Check your connection.");
  }
  if (r.status === 401 && !retried) {
    access = null;
    return request<T>(path, init, true);
  }
  if (r.status === 204) return undefined as T;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(body.error ?? "error", body.message ?? "Something went wrong.", r.status);
  return body as T;
}

export const api = {
  me: () => request<Me>("/v1/me"),
  plans: () => request<Plans>("/v1/plans"),
  saveProfile: (p: Profile) => request<{ profile: Profile }>("/v1/me/profile", { method: "PUT", body: JSON.stringify(p) }),
  conversations: () => request<{ conversations: { id: string; title: string; updated_at: string }[] }>("/v1/conversations"),
  newConversation: () => request<{ id: string }>("/v1/conversations", { method: "POST", body: "{}" }),
  messages: (id: string) => request<{ messages: Message[] }>(`/v1/conversations/${id}/messages`),
  assist: (b: { mode: AssistMode; tone: AssistTone; text?: string; image?: string; avoid?: string[] }) =>
    request<AssistResult>("/v1/assist", { method: "POST", body: JSON.stringify(b) }),
  deleteAccount: async () => {
    await request<void>("/v1/me", { method: "DELETE" });
    access = null;
    await SecureStore.deleteItemAsync(KEY);
  },
};

/**
 * Sends a message and streams the reply (Server-Sent Events).
 * Returns when the reply is complete; throws ApiError on failure.
 */
export async function sendMessage(
  conversationId: string,
  content: string,
  on: { delta: (t: string) => void; safety: (h: Helplines) => void; done: (d: { remaining: number }) => void },
  signal?: AbortSignal,
  retried = false,
): Promise<void> {
  if (!access) await signIn();
  let res;
  try {
    res = await streamFetch(`${API_URL}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}`, accept: "text/event-stream" },
      body: JSON.stringify({ content }),
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    throw new ApiError("network", "Can't reach Wingmate. Check your connection.");
  }
  if (res.status === 401 && !retried) {
    access = null;
    return sendMessage(conversationId, content, on, signal, true);
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({}) as any);
    throw new ApiError(b.error ?? "error", b.message ?? "Something went wrong.", res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const raw = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !raw) continue;
      const data = JSON.parse(raw);
      if (event === "delta") on.delta(data.text);
      else if (event === "safety") on.safety(data);
      else if (event === "done") on.done(data);
      else if (event === "error") throw new ApiError(data.error, data.message);
    }
  }
}
