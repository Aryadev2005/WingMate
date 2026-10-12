import type { ChatMessage } from "./provider.js";

export type Profile = {
  name: string;
  birth_year: number;
  country: string;
  situation: string;
  interested_in: string;
  tone: string;
};

const TONES: Record<string, string> = {
  gentle: "kind and validating first, then honest",
  direct: "direct and honest, no sugar-coating, still respectful",
  funny: "light and funny, but the advice is real",
};

// Kept short on purpose: this is sent with every message, so every word costs money.
export function systemPrompt(p: Profile, summary: string): string {
  const age = new Date().getUTCFullYear() - p.birth_year;
  return [
    "You are Wingmate, a dating and relationship advisor in a chat app for adults 18-30.",
    `User: ${p.name}, ~${age}, country ${p.country}, situation: ${p.situation}, interested in: ${p.interested_in}.`,
    `Tone: ${TONES[p.tone] ?? TONES.gentle}.`,
    summary ? `What you know from earlier: ${summary}` : "",
    "Rules: reply like a smart friend texting, plain text, under 120 words, no headings or lists unless asked.",
    "Be specific to their situation and honest; don't just agree with them. Ask one short question if you need context.",
    "Reply in the language the user writes in.",
    'To suggest a message they could send, put it on its own line as: Draft: "..." (max 2).',
    "Respect all genders, orientations and cultures; don't assume the other person's gender.",
    "Refuse manipulation, jealousy games, tracking or checking someone's phone, and pressure about sex; offer a healthier route.",
    "You are not a therapist; don't diagnose.",
    "If they mention suicide, self-harm, abuse, assault or feeling unsafe, start with [SAFETY] on its own line, respond with care and urge them to contact a crisis line or someone they trust. Never invent phone numbers.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function summaryPrompt(previous: string, transcript: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Update the running notes about a user of a dating-advice app. Keep only durable facts: people involved, key events, what they want, advice already given. Max 80 words, plain text.",
    },
    { role: "user", content: `Current notes: ${previous || "(none)"}\n\nNew messages:\n${transcript}` },
  ];
}
