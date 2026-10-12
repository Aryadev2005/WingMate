// Server-side crisis detection. Runs before the model so help shows instantly, and
// crisis messages are never blocked by the paywall. The model can also flag with [SAFETY].
const CRISIS = new RegExp(
  [
    "kill (my ?self|myself)", "suicid", "end it all", "want to die", "don'?t want to (be alive|live)",
    "self[- ]?harm", "cut(ting)? myself", "hurt(ing)? myself", "overdose",
    "(he|she|they) (hits?|hit|beats?|chok\\w*|strangl\\w*) me", "hit me", "forced me", "rap(ed|e)\\b",
    "sexual(ly)? assault", "threaten\\w* to (kill|hurt)", "scared for my life", "not safe at home", "abusive",
  ].join("|"),
  "i",
);

export const SAFETY_TOKEN = "[SAFETY]";
export const detectCrisis = (text: string) => CRISIS.test(text);

export function stripSafetyToken(text: string): { text: string; flagged: boolean } {
  const t = text.trimStart();
  if (t.startsWith(SAFETY_TOKEN)) return { text: t.slice(SAFETY_TOKEN.length).trimStart(), flagged: true };
  return { text, flagged: false };
}

type Line = { name: string; contact: string };
const HELPLINES: Record<string, Line[]> = {
  US: [{ name: "988 Suicide & Crisis Lifeline", contact: "Call or text 988" }],
  CA: [{ name: "Suicide Crisis Helpline", contact: "Call or text 988" }],
  GB: [{ name: "Samaritans", contact: "Call 116 123 (free, 24/7)" }],
  IE: [{ name: "Samaritans", contact: "Call 116 123 (free, 24/7)" }],
  AU: [{ name: "Lifeline", contact: "Call 13 11 14" }],
  NZ: [{ name: "Need to talk?", contact: "Call or text 1737" }],
  IN: [{ name: "Tele-MANAS", contact: "Call 14416 (free, 24/7)" }],
};

export function helplinesFor(country: string) {
  return {
    lines: HELPLINES[country?.toUpperCase()] ?? [],
    directory: "https://findahelpline.com",
    emergency: "If you are in immediate danger, call your local emergency number.",
  };
}
