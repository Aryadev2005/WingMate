import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, type Profile } from "../api";
import { useTheme } from "../theme";
import { Button, Chips, Label } from "../ui";

const deviceRegion = () => {
  try {
    const r = Intl.DateTimeFormat().resolvedOptions().locale.split("-").pop() ?? "";
    return /^[A-Z]{2}$/i.test(r) ? r.toUpperCase() : "";
  } catch {
    return "";
  }
};

export function Onboarding({ initial, onDone }: { initial: Profile | null; onDone: (p: Profile) => void }) {
  const t = useTheme();
  const [name, setName] = useState(initial?.name ?? "");
  const [year, setYear] = useState(initial ? String(initial.birthYear) : "");
  const [country, setCountry] = useState(initial?.country ?? deviceRegion());
  const [situation, setSituation] = useState<Profile["situation"] | undefined>(initial?.situation);
  const [into, setInto] = useState<Profile["interestedIn"] | undefined>(initial?.interestedIn);
  const [tone, setTone] = useState<Profile["tone"]>(initial?.tone ?? "gentle");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const input = { borderWidth: 1, borderColor: t.line, backgroundColor: t.sunk, color: t.ink, borderRadius: 12, padding: 12, fontSize: 16 } as const;

  async function submit() {
    const by = Number(year);
    const age = new Date().getFullYear() - by;
    if (!name.trim()) return setErr("Add your first name so I know what to call you.");
    if (!by || by < 1900) return setErr("Add the year you were born.");
    if (age < 18) return setErr("Wingmate is only for people 18 and over.");
    if (!/^[A-Za-z]{2}$/.test(country)) return setErr("Add your country as a 2-letter code, like US, GB or IN.");
    if (!situation) return setErr("Pick what's going on right now.");
    const p: Profile = { name: name.trim(), birthYear: by, country: country.toUpperCase(), situation, interestedIn: into ?? "unsaid", tone };
    setBusy(true);
    setErr("");
    try {
      await api.saveProfile(p);
      onDone(p);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: t.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.5 }}>Tell me what's going on.</Text>
        <Text style={{ color: t.muted, fontSize: 15 }}>No phone number or email needed. You can delete everything anytime in Settings.</Text>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1, gap: 8 }}>
            <Label>First name</Label>
            <TextInput value={name} onChangeText={setName} maxLength={30} placeholder="Alex" placeholderTextColor={t.muted} style={input} />
          </View>
          <View style={{ width: 110, gap: 8 }}>
            <Label>Birth year</Label>
            <TextInput value={year} onChangeText={setYear} maxLength={4} keyboardType="number-pad" placeholder="2001" placeholderTextColor={t.muted} style={input} />
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <Label>Country</Label>
          <TextInput value={country} onChangeText={setCountry} maxLength={2} autoCapitalize="characters" placeholder="US" placeholderTextColor={t.muted} style={[input, { width: 90 }]} />
          <Text style={{ color: t.muted, fontSize: 13 }}>Used to show the right support numbers if you ever need them.</Text>
        </View>
        <View style={{ gap: 8 }}>
          <Label>Right now I'm</Label>
          <Chips
            value={situation}
            onChange={setSituation}
            options={[["single", "Single & looking"], ["talking", "Talking stage"], ["dating", "Dating someone"], ["relationship", "In a relationship"], ["breakup", "Just broke up"], ["complicated", "It's complicated"]]}
          />
        </View>
        <View style={{ gap: 8 }}>
          <Label>Interested in</Label>
          <Chips value={into} onChange={setInto} options={[["men", "Men"], ["women", "Women"], ["everyone", "Everyone"], ["unsaid", "Rather not say"]]} />
        </View>
        <View style={{ gap: 8 }}>
          <Label>How should I talk to you?</Label>
          <Chips value={tone} onChange={setTone} options={[["gentle", "Gentle"], ["direct", "Straight-up"], ["funny", "Funny but useful"]]} />
        </View>
        {!!err && <Text style={{ color: t.accent }} accessibilityRole="alert">{err}</Text>}
        <Button label={busy ? "Saving…" : initial ? "Save" : "Start chatting"} onPress={submit} disabled={busy} />
        <Text style={{ color: t.muted, fontSize: 12 }}>Wingmate is for adults 18+. It's an AI, not a therapist. Your chats are never sold or used to train AI models.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
