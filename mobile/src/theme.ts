import { useColorScheme } from "react-native";

const light = {
  bg: "#FFFFFF", sunk: "#F6F3FA", ink: "#1C1530", muted: "#6B6380", line: "#DDD6E8",
  accent: "#D6345E", onAccent: "#FFFFFF", accentSoft: "#FBE3EA",
  you: "#1C1530", onYou: "#FFFFFF", ai: "#F3EFF8", draft: "#FFF4D6", onDraft: "#3D2E00",
  safe: "#E8F3EE", onSafe: "#16503A",
};
const dark: typeof light = {
  bg: "#1B1529", sunk: "#221B33", ink: "#F1ECF8", muted: "#A79FBA", line: "#33294A",
  accent: "#FF5C84", onAccent: "#1A0610", accentSoft: "#3A1726",
  you: "#F1ECF8", onYou: "#1C1530", ai: "#2A2240", draft: "#3A3018", onDraft: "#FFE7A8",
  safe: "#13291F", onSafe: "#A9E3C6",
};
export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === "dark" ? dark : light);
