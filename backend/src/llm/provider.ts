// Minimal OpenAI-compatible streaming client (no SDK). Works with OpenRouter, DeepSeek,
// Gemini's OpenAI endpoint, Groq, Together, etc. Falls back to a second provider only
// if the first fails before any text has streamed, so a user never sees a half answer twice.

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };
const textOf = (c: ChatMessage["content"]) => (typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : "x".repeat(4000))).join(""));
/** priceIn/priceOut are USD per 1M tokens, so every reply's cost is logged at the rate of the model that answered. */
export type Provider = { baseUrl: string; apiKey: string; model: string; priceIn: number; priceOut: number };
export type Usage = { promptTokens: number; completionTokens: number };
export type ChatResult = { text: string; usage: Usage; model: string; costMicros: number };

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly streamed = false) {
    super(message);
  }
}

const estimate = (s: string) => Math.ceil(s.length / 4);

async function streamOnce(
  p: Provider,
  messages: ChatMessage[],
  maxTokens: number,
  opts: { signal?: AbortSignal; onDelta?: (d: string) => void; firstTokenMs: number; totalMs: number },
): Promise<ChatResult> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let firstTimer: NodeJS.Timeout | undefined = setTimeout(() => ctl.abort(), opts.firstTokenMs);
  const totalTimer = setTimeout(() => ctl.abort(), opts.totalMs);
  let text = "";
  let finished = false;
  let usage: Usage | undefined;
  try {
    const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok || !res.body) throw new LlmError(`LLM HTTP ${res.status}`, res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { finished = true; continue; }
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new LlmError(String(j.error.message ?? "LLM error"), undefined, text.length > 0);
        const d: string | undefined = j.choices?.[0]?.delta?.content;
        if (d) {
          if (firstTimer) { clearTimeout(firstTimer); firstTimer = undefined; }
          text += d;
          opts.onDelta?.(d);
        }
        if (j.choices?.[0]?.finish_reason) finished = true;
        if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
      }
    }
    if (!text) throw new LlmError("Empty completion");
    if (!finished) throw new LlmError("Stream cut off", undefined, true);
    const u = usage ?? { promptTokens: estimate(messages.map((m) => textOf(m.content)).join("")), completionTokens: estimate(text) };
    return { text, model: p.model, usage: u, costMicros: Math.round(u.promptTokens * p.priceIn + u.completionTokens * p.priceOut) };
  } catch (e) {
    if (e instanceof LlmError) throw new LlmError(e.message, e.status, text.length > 0);
    if (opts.signal?.aborted) throw new LlmError("cancelled", 499, text.length > 0);
    throw new LlmError(ctl.signal.aborted ? "LLM timeout" : String((e as Error).message), undefined, text.length > 0);
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export class LlmClient {
  constructor(
    private providers: Provider[],
    private firstTokenMs: number,
    private totalMs: number,
  ) {}

  async chat(
    messages: ChatMessage[],
    maxTokens: number,
    opts: { signal?: AbortSignal; onDelta?: (d: string) => void } = {},
  ): Promise<ChatResult> {
    let last: LlmError | undefined;
    for (const p of this.providers) {
      try {
        return await streamOnce(p, messages, maxTokens, { ...opts, firstTokenMs: this.firstTokenMs, totalMs: this.totalMs });
      } catch (e) {
        last = e as LlmError;
        if (last.streamed || opts.signal?.aborted) throw last; // never restart a visible answer
      }
    }
    throw last ?? new LlmError("No LLM provider configured");
  }
}
