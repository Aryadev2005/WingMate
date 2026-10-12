import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, sendMessage, type Helplines, type Me, type Message } from "../api";
import { useTheme } from "../theme";

type Item = Message & { key: string; help?: Helplines; streaming?: boolean };

const QUICK = ["Decode this text: \"\"", "Help me reply to: \"\"", "Should I text first?", "Red flag check", "I can't stop thinking about my ex", "Plan a first date"];

/** Splits `Draft: "..."` lines out of a reply so they can be shown as copyable cards. */
function splitDrafts(text: string) {
  const drafts: string[] = [];
  const body = text
    .replace(/^Draft:\s*(.+)$/gim, (_, d: string) => {
      drafts.push(d.trim().replace(/^["“]|["”]$/g, ""));
      return "";
    })
    .trim();
  return { body, drafts };
}

export function Chat({ me, onPaywall, onUsage }: { me: Me; onPaywall: () => void; onUsage: (used: number) => void }) {
  const t = useTheme();
  const [conv, setConv] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const listRef = useRef<FlatList<Item>>(null);
  const ctl = useRef<AbortController | null>(null);

  // Resume the most recent chat so context is never lost between sessions.
  useEffect(() => {
    (async () => {
      try {
        const { conversations } = await api.conversations();
        const id = conversations[0]?.id ?? (await api.newConversation()).id;
        setConv(id);
        if (conversations[0]) {
          const { messages } = await api.messages(id);
          setItems(messages.map((m, i) => ({ ...m, key: `h${m.id ?? i}` })));
        }
      } catch (e) {
        setErr((e as ApiError).message);
      }
    })();
    return () => ctl.current?.abort();
  }, []);

  async function newChat() {
    ctl.current?.abort();
    const { id } = await api.newConversation();
    setConv(id);
    setItems([]);
  }

  async function send() {
    const content = text.trim();
    if (!content || !conv || busy) return;
    setErr("");
    setText("");
    setBusy(true);
    const userKey = `u${Date.now()}`;
    const replyKey = `a${Date.now()}`;
    let got = false;
    setItems((x) => [...x, { key: userKey, role: "user", content }, { key: replyKey, role: "assistant", content: "", streaming: true }]);
    const patch = (fn: (i: Item) => Item) => setItems((x) => x.map((i) => (i.key === replyKey ? fn(i) : i)));
    ctl.current = new AbortController();
    try {
      await sendMessage(
        conv,
        content,
        {
          delta: (d) => { got = true; patch((i) => ({ ...i, content: i.content + d })); },
          safety: (h) => patch((i) => ({ ...i, help: h, safety: true })),
          done: (d) => onUsage(me.usage.limit - d.remaining),
        },
        ctl.current.signal,
      );
      patch((i) => ({ ...i, streaming: false }));
    } catch (e) {
      const ae = e as ApiError;
      if (got) {
        patch((i) => ({ ...i, streaming: false }));
      } else {
        // Nothing was delivered (and nothing was charged): put their message back so they can resend.
        setItems((x) => x.filter((i) => i.key !== replyKey && i.key !== userKey));
        setText(content);
      }
      if (ae.code === "quota_exhausted") onPaywall();
      else setErr(ae.message);
    } finally {
      setBusy(false);
    }
  }

  const left = Math.max(0, me.usage.limit - me.usage.used);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={60}>
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(i) => i.key}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={{ backgroundColor: t.ai, padding: 14, borderRadius: 18, alignSelf: "flex-start", maxWidth: "85%" }}>
            <Text style={{ color: t.ink, fontSize: 15 }}>
              Hey {me.profile?.name}. {me.profile?.situation === "breakup" ? "Breakups are rough. What happened?" : "What's on your mind? Paste a text you got, or tell me the situation."}
            </Text>
          </View>
        }
        renderItem={({ item }) => <Bubble item={item} />}
      />
      {!!err && <Text style={{ color: t.accent, paddingHorizontal: 16 }} accessibilityRole="alert">{err}</Text>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 6 }} style={{ flexGrow: 0 }}>
        {QUICK.map((q) => (
          <Pressable key={q} onPress={() => setText(q)} style={{ borderWidth: 1, borderStyle: "dashed", borderColor: t.line, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12 }}>
            <Text style={{ color: t.ink, fontSize: 13 }}>{q.replace(/: ""$/, "")}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end", paddingHorizontal: 12, paddingTop: 6, borderTopWidth: 1, borderColor: t.line }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Paste their text or ask anything…"
          placeholderTextColor={t.muted}
          multiline
          maxLength={2000}
          style={{ flex: 1, maxHeight: 120, borderWidth: 1, borderColor: t.line, backgroundColor: t.sunk, color: t.ink, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          onPress={send}
          disabled={busy || !text.trim()}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: "center", justifyContent: "center", opacity: busy || !text.trim() ? 0.45 : 1 }}
        >
          {busy ? <ActivityIndicator color={t.onAccent} /> : <Text style={{ color: t.onAccent, fontSize: 20, fontWeight: "700" }}>→</Text>}
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 8 }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {me.plan === "plus" ? "Wingmate Plus" : `${left} of ${me.usage.limit} free messages left today · safety help is always free`}
        </Text>
        {items.length > 0 && (
          <Pressable onPress={newChat}>
            <Text style={{ color: t.accent, fontSize: 12, fontWeight: "600" }}>New chat</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ item }: { item: Item }) {
  const t = useTheme();
  if (item.role === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "85%", backgroundColor: t.you, padding: 12, borderRadius: 18, borderBottomRightRadius: 6 }}>
        <Text style={{ color: t.onYou, fontSize: 15 }}>{item.content}</Text>
      </View>
    );
  }
  const { body, drafts } = splitDrafts(item.content);
  return (
    <View style={{ gap: 8 }}>
      {item.help && <HelpCard help={item.help} />}
      {item.streaming && !item.content ? (
        <Text style={{ color: t.muted, fontSize: 13 }}>Wingmate is typing…</Text>
      ) : (
        !!body && (
          <View style={{ alignSelf: "flex-start", maxWidth: "85%", backgroundColor: t.ai, padding: 12, borderRadius: 18, borderBottomLeftRadius: 6 }}>
            <Text style={{ color: t.ink, fontSize: 15 }}>{body}</Text>
          </View>
        )
      )}
      {!item.streaming &&
        drafts.map((d) => (
          <View key={d} style={{ alignSelf: "flex-start", maxWidth: "85%", backgroundColor: t.draft, padding: 12, borderRadius: 14, gap: 8 }}>
            <Text style={{ color: t.onDraft, fontSize: 11, fontWeight: "700", letterSpacing: 0.8 }}>DRAFT REPLY</Text>
            <Text style={{ color: t.onDraft, fontSize: 15 }}>{d}</Text>
            <Pressable onPress={() => Clipboard.setStringAsync(d)} style={{ alignSelf: "flex-start", borderWidth: 1, borderColor: t.onDraft, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 }}>
              <Text style={{ color: t.onDraft, fontSize: 12, fontWeight: "600" }}>Copy</Text>
            </Pressable>
          </View>
        ))}
    </View>
  );
}

function HelpCard({ help }: { help: Helplines }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.safe, padding: 14, borderRadius: 14, gap: 6 }} accessibilityRole="summary">
      <Text style={{ color: t.onSafe, fontWeight: "700", fontSize: 16 }}>You don't have to handle this alone.</Text>
      {help.lines.map((l) => (
        <Text key={l.name} style={{ color: t.onSafe }} selectable>
          {l.name}: <Text style={{ fontWeight: "700" }}>{l.contact}</Text>
        </Text>
      ))}
      {help.lines.length === 0 && (
        <Text style={{ color: t.onSafe, textDecorationLine: "underline" }} onPress={() => Linking.openURL(help.directory)}>
          Find a free, confidential helpline in your country
        </Text>
      )}
      <Text style={{ color: t.onSafe }}>{help.emergency}</Text>
    </View>
  );
}
