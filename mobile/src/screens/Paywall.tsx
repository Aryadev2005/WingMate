import { useEffect, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import Purchases, { type PurchasesPackage } from "react-native-purchases";
import { api, type Plans } from "../api";
import { useTheme } from "../theme";
import { Button } from "../ui";

export const RC_KEY = Platform.select({ ios: process.env.EXPO_PUBLIC_RC_IOS_KEY, android: process.env.EXPO_PUBLIC_RC_ANDROID_KEY }) ?? "";

export function Paywall({ onClose, onUpgraded }: { onClose: () => void; onUpgraded: () => void }) {
  const t = useTheme();
  const [plans, setPlans] = useState<Plans | null>(null);
  const [pkgs, setPkgs] = useState<PurchasesPackage[]>([]);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.plans().then(setPlans).catch(() => {});
    if (RC_KEY) {
      Purchases.getOfferings()
        .then((o) => setPkgs(o.current?.availablePackages ?? []))
        .catch(() => setMsg("The store isn't available right now."));
    }
  }, []);

  async function buy() {
    const p = pkgs[pick];
    if (!p) return setMsg("Purchases aren't set up in this build yet.");
    setBusy(true);
    setMsg("");
    try {
      await Purchases.purchasePackage(p);
      // The server learns about the purchase from RevenueCat's webhook; give it a moment.
      setTimeout(onUpgraded, 2500);
    } catch (e: any) {
      if (!e?.userCancelled) setMsg("The purchase didn't go through. You haven't been charged.");
    } finally {
      setBusy(false);
    }
  }

  // Real store prices (localized per country) when available; otherwise the server's list prices.
  const options = pkgs.length
    ? pkgs.map((p) => ({ title: p.product.title || p.packageType, price: p.product.priceString }))
    : plans
      ? [{ title: "Monthly", price: plans.plus.monthly }, { title: "Yearly", price: plans.plus.yearly }]
      : [];

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
      <Text style={{ color: t.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.5 }}>Wingmate Plus</Text>
      <Text style={{ color: t.muted, fontSize: 15 }}>
        {plans ? `Free gives you ${plans.free.messagesPerDay} messages a day, reset every day. Plus gives you up to ${plans.plus.messagesPerDay}.` : " "}
      </Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {options.map((o, i) => (
          <View
            key={o.title}
            onTouchEnd={() => setPick(i)}
            style={{ flex: 1, borderWidth: pick === i ? 2 : 1, borderColor: pick === i ? t.accent : t.line, borderRadius: 16, padding: 14, gap: 4 }}
          >
            <Text style={{ color: t.muted }}>{o.title}</Text>
            <Text style={{ color: t.ink, fontSize: 24, fontWeight: "800" }}>{o.price}</Text>
          </View>
        ))}
      </View>
      {["Unlimited everyday advice (fair use)", "Longer, more detailed replies", "Full chat history and memory of your situation"].map((f) => (
        <Text key={f} style={{ color: t.ink, fontSize: 15 }}>✓  {f}</Text>
      ))}
      <Text style={{ color: t.muted, fontSize: 13 }}>Safety and crisis support is always free, on every plan.</Text>
      {!!msg && <Text style={{ color: t.accent }}>{msg}</Text>}
      <Button label={busy ? "Opening store…" : plans ? `Start ${plans.plus.trialDays}-day free trial` : "Continue"} onPress={buy} disabled={busy} />
      <Button label="Not now" kind="ghost" onPress={onClose} />
      <Text style={{ color: t.muted, fontSize: 12 }}>The price is shown before you pay. Cancel anytime in your App Store or Google Play settings; you keep Plus until the period ends.</Text>
    </ScrollView>
  );
}
