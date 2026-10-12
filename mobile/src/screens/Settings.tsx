import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { api, type Me } from "../api";
import { useTheme } from "../theme";
import { Button } from "../ui";

export function Settings({ me, onEditProfile, onDeleted, onClose }: { me: Me; onEditProfile: () => void; onDeleted: () => void; onClose: () => void }) {
  const t = useTheme();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");

  async function del() {
    try {
      await api.deleteAccount();
      onDeleted();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
      <Text style={{ color: t.ink, fontSize: 28, fontWeight: "800" }}>Settings</Text>
      <Text style={{ color: t.muted }}>Plan: {me.plan === "plus" ? "Wingmate Plus" : "Free"}</Text>
      <Button label="Edit my profile" kind="ghost" onPress={onEditProfile} />
      <Text style={{ color: t.ink, fontWeight: "700", marginTop: 12 }}>Your privacy</Text>
      <Text style={{ color: t.muted }}>
        Wingmate never asks for your phone number or email. Your chats aren't sold or used to train AI models. Deleting your account erases your profile and every chat from our servers immediately.
      </Text>
      {confirm ? (
        <>
          <Text style={{ color: t.accent, fontWeight: "600" }}>This permanently deletes everything. It can't be undone.</Text>
          <Button label="Yes, delete everything" onPress={del} />
          <Button label="Keep my account" kind="ghost" onPress={() => setConfirm(false)} />
        </>
      ) : (
        <Button label="Delete my account and data" kind="ghost" onPress={() => setConfirm(true)} />
      )}
      {!!err && <Text style={{ color: t.accent }}>{err}</Text>}
      <Button label="Done" onPress={onClose} style={{ marginTop: 12 }} />
    </ScrollView>
  );
}
