import { useLocalSearchParams, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AppRecord, QueryStateResponse } from '@liveuiagent/app-spec';
import { agentPost } from '../../src/agentApi';
import { DynamicAppRenderer } from '../../src/DynamicAppRenderer';

function requiredArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value as T[];
}

function requiredText(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value;
}

export default function GeneratedAppScreen() {
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const data = await agentPost<QueryStateResponse>('/agent/query-state', {});
    setApps(requiredArray<AppRecord>(data.apps, 'query-state missing apps'));
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setMessage(`加载失败：${err.message}`));
  }, [refresh]);

  const app = useMemo(() => apps.find((candidate) => candidate.appId === appId), [apps, appId]);

  async function dispatchAction(actionId: string, eventPayload: unknown) {
    if (!app) throw new Error(`app not found: ${appId}`);
    setBusy(true);
    try {
      const data = await agentPost<any>('/agent/action', {
        appId: app.appId,
        actionId,
        eventPayload,
        clientState: {},
        platform: 'ios',
      });
      const messages = requiredArray<string>(data.messages, 'action response missing messages');
      setMessage(requiredText(messages[0], 'action response missing first message'));
      await refresh();
    } catch (err) {
      setMessage(`操作失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.windowControls} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.dot, styles.dotRed]} />
          <View style={[styles.dot, styles.dotYellow]} />
          <View style={[styles.dot, styles.dotGreen]} />
        </View>
        <Pressable style={styles.closeButton} onPress={() => router.replace('/')}>
          <Text style={styles.closeText}>×</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>已打开</Text>
          <Text style={styles.title}>{app ? app.name : requiredText(appId, 'route missing appId')}</Text>
        </View>
        {busy ? <ActivityIndicator /> : null}
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {loaded ? (
          <DynamicAppRenderer app={app ?? (() => { throw new Error(`app not found: ${appId}`); })()} onAction={dispatchAction} busy={busy} />
        ) : (
          <ActivityIndicator />
        )}
      </ScrollView>
      {message ? <Text style={styles.status}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#eef3f9' },
  header: { paddingTop: 52, paddingHorizontal: 14, paddingBottom: 14, backgroundColor: 'rgba(248,251,255,.78)', borderBottomWidth: 1, borderColor: 'rgba(255,255,255,.68)', flexDirection: 'row', alignItems: 'center', gap: 12 },
  windowControls: { flexDirection: 'row', gap: 8, marginRight: 2 },
  dot: { width: 12, height: 12, borderRadius: 999 },
  dotRed: { backgroundColor: '#ff5f57' },
  dotYellow: { backgroundColor: '#febc2e' },
  dotGreen: { backgroundColor: '#28c840' },
  closeButton: { marginLeft: 'auto', minHeight: 36, width: 36, borderRadius: 999, backgroundColor: 'rgba(255,255,255,.78)', alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#172033', fontSize: 20, fontWeight: '900' },
  headerText: { flex: 1 },
  eyebrow: { color: '#667386', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  title: { color: '#172033', fontSize: 22, fontWeight: '900', marginTop: 3, letterSpacing: -.02 },
  body: { padding: 14, gap: 12 },
  empty: { padding: 18, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(186,197,212,.9)', borderRadius: 18, backgroundColor: 'rgba(255,255,255,.76)' },
  emptyTitle: { fontSize: 18, fontWeight: '900', color: '#172033', marginBottom: 6 },
  muted: { color: '#667386' },
  status: { padding: 12, backgroundColor: 'rgba(255,255,255,.72)', color: '#536174', borderTopWidth: 1, borderColor: 'rgba(255,255,255,.68)' },
});
