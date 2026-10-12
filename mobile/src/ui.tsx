import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

export function Button({ label, onPress, disabled, kind = "primary", style }: { label: string; onPress: () => void; disabled?: boolean; kind?: "primary" | "ghost"; style?: ViewStyle }) {
  const t = useTheme();
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn,
        primary ? { backgroundColor: t.accent } : { borderWidth: 1, borderColor: t.line },
        { opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      <Text style={{ color: primary ? t.onAccent : t.ink, fontWeight: "600", fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}

export function Chips<T extends string>({ options, value, onChange }: { options: [T, string][]; value: T | undefined; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={s.chips} accessibilityRole="radiogroup">
      {options.map(([v, label]) => {
        const on = v === value;
        return (
          <Pressable
            key={v}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(v)}
            style={[s.chip, { borderColor: on ? t.ink : t.line, backgroundColor: on ? t.ink : "transparent" }]}
          >
            <Text style={{ color: on ? t.bg : t.ink, fontSize: 14 }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Label({ children }: { children: string }) {
  const t = useTheme();
  return <Text style={{ color: t.muted, fontSize: 12, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase" }}>{children}</Text>;
}

const s = StyleSheet.create({
  btn: { paddingVertical: 14, paddingHorizontal: 18, borderRadius: 14, alignItems: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1 },
});
