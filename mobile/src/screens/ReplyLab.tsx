import * as Clipboard from "expo-clipboard";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, type AssistMode, type AssistResult, type AssistTone, type Me } from "../api";
import { useTheme } from "../theme";
import { Button, Chips, Label } from "../ui";

const MODES: [AssistMode, string, string][] = [
  ["reply", "Reply to a chat", "Screenshot your conversation and get 3 replies to send next."],
  ["opener", "Opening line", "Screenshot their profile and get 3 first messages that mention something real."],
  ["bio", "Fix my bio", "Paste or screenshot your own profile for honest feedback and better versions."],
];

export function ReplyLab({ me, onPaywall, onUsage }: { me: Me; onPaywall: () => void; onUsage: (used: number) => void }) {
  const t = useTheme();
  const [mode, setMode] = useState<AssistMode>("reply");
  const [tone, setTone] = useState<AssistTone>("smooth");
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ uri: string; base64: string } | null>(null);
  const [res, setRes] = useState<AssistResult | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  async function pick() {
    setErr("");
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (r.canceled || !r.assets[0]) return;
    // Shrink before upload: faster, and vision models charge by image size.
    const small = await manipulateAsync(r.assets[0].uri, [{ resize: { width: 900 } }], { compress: 0.6, format: SaveFormat.JPEG, base64: true });
    if (small.base64) setImage({ uri: small.uri, base64: small.base64 });
  }

  async function generate(more = false) {
    if (!text.trim() && !image) return setErr("Add a screenshot or paste some text first.");
    setBusy(true);
    setErr("");
    const avoid = more ? seen.slice(-9) : [];
    try {
      const out = await api.assist({ mode, tone, text: text.trim() || undefined, image: image ? `data:image/jpeg;base64,${image.base64}` : undefined, avoid });
      setRes(out);
      setSeen((s) => (more ? [...s, ...out.suggestions] : out.suggestions));
      onUsage(me.usage.limit - out.remaining);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === "quota_exhausted") onPaywall();
      else setErr(ae.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(s: string) {
    await Clipboard.setStringAsync(s);
    setCopied(s);
    setTimeout(() => setCopied(null), 1500);
  }

  const help = MODES.find((m) => m[0] === mode)!;
  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }} keyboardShouldPersistTaps="handled">
      <Chips value={mode} onChange={(m) => { setMode(m); setRes(null); setSeen([]); }} options={MODES.map(([v, l]) => [v, l] as [AssistMode, string])} />
      <Text style={{ color: t.muted }}>{help[2]}</Text>

      <Pressable
        onPress={pick}
        accessibilityRole="button"
        style={{ borderWidth: 1, borderStyle: "dashed", borderColor: t.line, borderRadius: 16, padding: 14, alignItems: "center", gap: 10, backgroundColor: t.sunk }}
      >
        {image ? (
          <>
            <Image source={{ uri: image.uri }} style={{ width: 120, height: 200, borderRadius: 10 }} resizeMode="cover" />
            <Text style={{ color: t.accent, fontWeight: "600" }}>Change screenshot</Text>
          </>
        ) : (
          <Text style={{ color: t.ink, fontWeight: "600" }}>+ Add a screenshot</Text>
        )}
      </Pressable>
      {image && (
        <Pressable onPress={() => setImage(null)}>
          <Text style={{ color: t.muted, textAlign: "center" }}>Remove screenshot</Text>
        </Pressable>
      )}

      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        maxLength={4000}
        placeholder={mode === "bio" ? "…or paste your bio" : "…or paste the messages here"}
        placeholderTextColor={t.muted}
        style={{ minHeight: 80, borderWidth: 1, borderColor: t.line, backgroundColor: t.sunk, color: t.ink, borderRadius: 12, padding: 12, fontSize: 15, textAlignVertical: "top" }}
      />

      <View style={{ gap: 8 }}>
        <Label>Vibe</Label>
        <Chips value={tone} onChange={setTone} options={[["smooth", "Smooth"], ["flirty", "Flirty"], ["funny", "Funny"], ["chill", "Chill"], ["bold", "Bold"]]} />
      </View>

      <Button label={busy ? "Thinking…" : "Get suggestions"} onPress={() => generate(false)} disabled={busy} />
      {!!err && <Text style={{ color: t.accent }} accessibilityRole="alert">{err}</Text>}
      {busy && <ActivityIndicator color={t.accent} />}

      {res && !busy && (
        <View style={{ gap: 10 }}>
          {res.safety && (
            <View style={{ backgroundColor: t.safe, padding: 14, borderRadius: 14, gap: 4 }}>
              <Text style={{ color: t.onSafe, fontWeight: "700" }}>If someone's in danger, help is available.</Text>
              {res.safety.lines.map((l) => <Text key={l.name} style={{ color: t.onSafe }} selectable>{l.name}: {l.contact}</Text>)}
              <Text style={{ color: t.onSafe }}>{res.safety.emergency}</Text>
            </View>
          )}
          {res.feedback && (
            <View style={{ backgroundColor: t.ai, padding: 14, borderRadius: 14 }}>
              <Text style={{ color: t.ink, fontSize: 15 }}>{res.feedback}</Text>
            </View>
          )}
          {res.suggestions.map((s) => (
            <Pressable key={s} onPress={() => copy(s)} style={{ backgroundColor: t.draft, padding: 14, borderRadius: 14, gap: 6 }} accessibilityHint="Copies this message">
              <Text style={{ color: t.onDraft, fontSize: 15 }}>{s}</Text>
              <Text style={{ color: t.onDraft, fontSize: 12, fontWeight: "700" }}>{copied === s ? "Copied" : "Tap to copy"}</Text>
            </Pressable>
          ))}
          <Button label="More like this" kind="ghost" onPress={() => generate(true)} />
          <Text style={{ color: t.muted, fontSize: 12 }}>Wingmate never saves your screenshots or pasted text.</Text>
        </View>
      )}
    </ScrollView>
  );
}
