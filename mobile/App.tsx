import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import Purchases from "react-native-purchases";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError, type Me } from "./src/api";
import { Chat } from "./src/screens/Chat";
import { Onboarding } from "./src/screens/Onboarding";
import { Paywall, RC_KEY } from "./src/screens/Paywall";
import { Settings } from "./src/screens/Settings";
import { useTheme } from "./src/theme";
import { Button } from "./src/ui";

type Screen = "chat" | "profile" | "paywall" | "settings";

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const t = useTheme();
  const [me, setMe] = useState<Me | null>(null);
  const [screen, setScreen] = useState<Screen>("chat");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const m = await api.me();
      setMe(m);
      if (RC_KEY) {
        if (!(await Purchases.isConfigured())) Purchases.configure({ apiKey: RC_KEY, appUserID: m.id });
        else await Purchases.logIn(m.id);
      }
    } catch (e) {
      setErr((e as ApiError).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!me) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}>
        {err ? (
          <>
            <Text style={{ color: t.ink, textAlign: "center" }}>{err}</Text>
            <Button label="Try again" onPress={load} />
          </>
        ) : (
          <ActivityIndicator color={t.accent} />
        )}
      </SafeAreaView>
    );
  }

  const needsProfile = !me.profile || screen === "profile";
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style="auto" />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderColor: t.line }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 22, height: 22, backgroundColor: t.accent, borderRadius: 11, borderBottomLeftRadius: 3 }} />
          <Text style={{ color: t.ink, fontSize: 20, fontWeight: "800" }}>Wingmate</Text>
        </View>
        {me.profile && (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable onPress={() => setScreen("paywall")} style={{ backgroundColor: t.accentSoft, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10 }}>
              <Text style={{ color: t.accent, fontSize: 12, fontWeight: "700" }}>
                {me.plan === "plus" ? "Plus" : `Free · ${Math.max(0, me.usage.limit - me.usage.used)} left`}
              </Text>
            </Pressable>
            <Pressable onPress={() => setScreen("settings")} accessibilityLabel="Settings" style={{ paddingHorizontal: 6, justifyContent: "center" }}>
              <Text style={{ color: t.ink, fontSize: 18 }}>⋯</Text>
            </Pressable>
          </View>
        )}
      </View>
      {needsProfile ? (
        <Onboarding initial={me.profile} onDone={(p) => { setMe({ ...me, profile: p }); setScreen("chat"); }} />
      ) : screen === "paywall" ? (
        <Paywall onClose={() => setScreen("chat")} onUpgraded={async () => { await load(); setScreen("chat"); }} />
      ) : screen === "settings" ? (
        <Settings me={me} onEditProfile={() => setScreen("profile")} onDeleted={() => { setMe(null); setScreen("chat"); load(); }} onClose={() => setScreen("chat")} />
      ) : (
        <Chat me={me} onPaywall={() => setScreen("paywall")} onUsage={(used) => setMe((m) => (m ? { ...m, usage: { ...m.usage, used } } : m))} />
      )}
    </SafeAreaView>
  );
}
