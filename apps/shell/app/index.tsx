import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { AgentTrace, AppRecord, CanvasPatchResponse, CanvasState, QueryStateResponse } from '@liveuiagent/app-spec';
import { agentPost } from '../src/agentApi';
import { SvgIcon } from '../src/SvgIcon';

const emptyCanvas: CanvasState = {
  canvasId: 'home',
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  inputDock: { position: 'bottom', placeholder: '描述你想生成的 agent app...' },
};

function requiredArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value as T[];
}

function requiredText(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value;
}

function requiredCanvas(value: unknown): CanvasState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('query-state missing canvasState');
  const canvas = value as CanvasState;
  requiredText(canvas.canvasId, 'canvasState missing canvasId');
  requiredArray(canvas.nodes, 'canvasState missing nodes');
  requiredArray(canvas.edges, 'canvasState missing edges');
  if (!canvas.viewport || typeof canvas.viewport !== 'object') throw new Error('canvasState missing viewport');
  if (!canvas.inputDock || typeof canvas.inputDock !== 'object') throw new Error('canvasState missing inputDock');
  return canvas;
}

function requiredTrace(value: unknown): AgentTrace[] {
  return requiredArray<AgentTrace>(value, 'response missing trace');
}

function requiredApp(apps: AppRecord[], appId: string) {
  const app = apps.find((candidate) => candidate.appId === appId);
  if (!app) throw new Error(`canvas references missing app ${appId}`);
  return app;
}

function friendlyTraceTitle(agent: string) {
  if (/router/i.test(agent)) return '理解需求';
  if (/requirement/i.test(agent)) return '整理需求';
  if (/planner/i.test(agent)) return '设计应用';
  if (/\bui\b|interface/i.test(agent)) return '生成界面';
  if (/action/i.test(agent)) return '连接操作';
  if (/data/i.test(agent)) return '准备内容';
  if (/asset/i.test(agent)) return '制作图标';
  if (/layout/i.test(agent)) return '放到桌面';
  if (/safety/i.test(agent)) return '检查可用性';
  if (/memory/i.test(agent)) return '保存上下文';
  return '处理请求';
}

export default function WhiteboardHome() {
  const [canvas, setCanvas] = useState<CanvasState>(emptyCanvas);
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [summary, setSummary] = useState<QueryStateResponse['summary'] | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<AgentTrace[]>([]);
  const [message, setMessage] = useState('输入一句话，LIVEUIAGENT 会生成一个可打开、可交互的 agent app。');
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const boardSize = useMemo(() => {
    const padding = 180;
    const minWidth = 1120;
    const minHeight = 860;
    const width = canvas.nodes.reduce((max, node) => Math.max(max, node.position.x + Math.max(node.size.width, 104) + padding), minWidth);
    const height = canvas.nodes.reduce((max, node) => Math.max(max, node.position.y + Math.max(node.size.height, 124) + padding), minHeight);
    return { width, height };
  }, [canvas.nodes]);

  const refresh = useCallback(async () => {
    const data = await agentPost<QueryStateResponse>('/agent/query-state', {});
    const nextApps = requiredArray<AppRecord>(data.apps, 'query-state missing apps');
    setCanvas(requiredCanvas(data.canvasState));
    setApps(nextApps);
    if (!data.summary) throw new Error('query-state missing summary');
    setSummary(data.summary);
    if (selectedAppId && !nextApps.some((app) => app.appId === selectedAppId)) setSelectedAppId(null);
  }, [selectedAppId]);

  async function moveNode(nodeId: string, position: { x: number; y: number }) {
    try {
      const data = await agentPost<CanvasPatchResponse>('/agent/patch-canvas', {
        canvasId: canvas.canvasId,
        nodeId,
        position,
      });
      setCanvas(requiredCanvas(data.canvasState));
      setTrace(requiredTrace(data.trace));
      setMessage('白板位置已保存。');
    } catch (err) {
      setMessage(`保存白板位置失败：${(err as Error).message}`);
      await refresh();
    }
  }

  useEffect(() => {
    refresh().catch((err) => setMessage(`加载失败：${err.message}`));
  }, [refresh]);

  const selectedApp = useMemo(() => selectedAppId ? requiredApp(apps, selectedAppId) : null, [apps, selectedAppId]);

  async function submitPrompt() {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setMessage('正在处理...');
    try {
      const data = await agentPost<any>('/agent/run', {
        prompt: text,
        selectedAppId,
        selectedNodeId: canvas.selectedNodeId,
        canvasState: canvas,
        platform: 'web',
      });
      setTrace(requiredTrace(data.trace));
      setPrompt('');
      await refresh();
      if (data.type === 'app_created') setSelectedAppId(requiredText(data.appSummary?.appId, 'app_created missing appSummary.appId'));
      else if (data.type === 'app_patched') setSelectedAppId(requiredText(data.appPackage?.manifest?.appId, 'app_patched missing app id'));
      if (data.type === 'state') setMessage(requiredText(data.summary?.text, 'state response missing summary text'));
      else if (data.type === 'needs_confirmation') setMessage(requiredText(data.report?.reason, 'needs_confirmation missing reason'));
      else setMessage(data.type === 'app_patched' ? '已更新应用。' : '已生成应用。');
    } catch (err) {
      setMessage(`执行失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerBrand}>
          <View style={styles.brandMark} />
          <View style={styles.headerCopy}>
            <Text style={styles.title}>liveUI</Text>
            <Text style={styles.headerSummary} numberOfLines={1}>{summary ? summary.text : 'One sentence becomes a live agent app.'}</Text>
          </View>
        </View>
        <Text style={styles.count}>{apps.length} 个应用</Text>
      </View>

      <ScrollView contentContainerStyle={styles.board} testID="whiteboard-canvas">
        <View style={[styles.boardSurface, { width: boardSize.width, height: boardSize.height }]} testID="whiteboard-surface">
        {apps.length === 0 ? (
          <View style={styles.emptyBoard}>
            <Text style={styles.emptyTitle}>白板等待第一个应用</Text>
            <Text style={styles.muted}>输入任意需求，生成一个有界面、有状态、有交互的 agent app。</Text>
          </View>
        ) : null}

        {canvas.nodes.map((node) => {
          const app = requiredApp(apps, node.appId);
          return (
            <AppCanvasCard
              active={selectedAppId === app.appId}
              app={app}
              node={node}
              key={node.id}
              dragging={draggingNodeId === node.id}
              onDragStart={() => setDraggingNodeId(node.id)}
              onDragMove={(position) => {
                setCanvas((current) => ({
                  ...current,
                  selectedNodeId: node.id,
                  nodes: current.nodes.map((candidate) => candidate.id === node.id ? { ...candidate, position } : candidate),
                }));
              }}
              onDragFinish={() => setDraggingNodeId(null)}
              onDragEnd={(position) => {
                setDraggingNodeId(null);
                void moveNode(node.id, position);
              }}
              onOpen={() => {
                setSelectedAppId(app.appId);
                router.push(`/app/${app.appId}`);
              }}
            />
          );
        })}

        {canvas.edges.length ? (
          <View style={styles.connections}>
            {canvas.edges.map((edge) => (
              <View style={styles.connectionCard} key={edge.id}>
                <Text style={styles.connectionTitle}>{edge.label}</Text>
                <Text style={styles.connectionText}>{`${edge.sourceAppId} -> ${edge.targetAppId}`}</Text>
                <Text style={styles.connectionStatus}>{edge.status}</Text>
              </View>
            ))}
          </View>
        ) : null}
        </View>
      </ScrollView>

      <View style={styles.inspector}>
        <Text style={styles.panelTitle}>当前应用</Text>
        <Text style={styles.muted}>{selectedApp ? selectedApp.name : '还没有选中应用。'}</Text>
        {summary ? <Text style={styles.summary}>{summary.text}</Text> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.traceRow}>
          {trace.slice(-6).map((item, index) => (
            <Text key={`${item.agent}-${index}`} style={styles.tracePill}>{friendlyTraceTitle(item.agent)}</Text>
          ))}
        </ScrollView>
      </View>

      <View style={styles.promptDock}>
        <TextInput
          style={styles.promptInput}
          value={prompt}
          onChangeText={setPrompt}
          placeholder={canvas.inputDock.placeholder}
          placeholderTextColor="#7a8799"
          editable={!busy}
          returnKeyType="send"
          onSubmitEditing={submitPrompt}
        />
        <Pressable style={[styles.runButton, busy && styles.disabled]} onPress={submitPrompt} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.runText}>发送</Text>}
        </Pressable>
      </View>
      <Text style={styles.status}>{message}</Text>
    </View>
  );
}

function AppCanvasCard({ app, node, active, dragging, onDragStart, onDragMove, onDragFinish, onDragEnd, onOpen }: {
  app: AppRecord;
  node: CanvasState['nodes'][number];
  active: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragMove: (position: { x: number; y: number }) => void;
  onDragFinish: () => void;
  onDragEnd: (position: { x: number; y: number }) => void;
  onOpen: () => void;
}) {
  const preview = app.preview;
  const dragOrigin = useRef(node.position);
  const movedRef = useRef(false);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dx) > 6 || Math.abs(gestureState.dy) > 6,
    onPanResponderGrant: () => {
      dragOrigin.current = { ...node.position };
      movedRef.current = false;
      onDragStart();
    },
    onPanResponderMove: (_, gestureState) => {
      const next = {
        x: Math.max(0, Math.round(dragOrigin.current.x + gestureState.dx)),
        y: Math.max(0, Math.round(dragOrigin.current.y + gestureState.dy)),
      };
      if (Math.abs(next.x - dragOrigin.current.x) > 3 || Math.abs(next.y - dragOrigin.current.y) > 3) {
        movedRef.current = true;
      }
      onDragMove(next);
    },
    onPanResponderRelease: (_, gestureState) => {
      const next = {
        x: Math.max(0, Math.round(dragOrigin.current.x + gestureState.dx)),
        y: Math.max(0, Math.round(dragOrigin.current.y + gestureState.dy)),
      };
      if (movedRef.current) {
        onDragEnd(next);
        setTimeout(() => { movedRef.current = false; }, 0);
      }
      onDragFinish();
    },
    onPanResponderTerminate: () => {
      movedRef.current = false;
      onDragFinish();
    },
  }), [node.position.x, node.position.y, onDragEnd, onDragFinish, onDragMove, onDragStart]);
  return (
    <Pressable
      {...panResponder.panHandlers}
      style={[
        styles.appCard,
        active && styles.appCardActive,
        {
          opacity: dragging ? 0.92 : 1,
          left: node.position.x,
          top: node.position.y,
          width: Math.max(node.size.width, 104),
          minHeight: Math.max(node.size.height, 124),
        },
      ]}
      onPress={() => {
        if (movedRef.current) return;
        onOpen();
      }}
    >
      <View style={styles.appCardShell} />
      <View style={styles.appCardHalo} />
      <View style={[styles.iconWrap, { shadowColor: preview.accent }, active && { borderColor: preview.accent }]}>
        <SvgIcon svg={app.appPackage.assets.icon.svg} size={64} />
      </View>
      <Text style={styles.appIconName} numberOfLines={2}>{app.name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#eef3f9' },
  header: {
    paddingHorizontal: 18,
    paddingTop: 52,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,.66)',
    backgroundColor: 'rgba(248,251,255,.72)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerBrand: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  brandMark: { width: 20, height: 20, borderRadius: 7, backgroundColor: '#0f172a' },
  headerCopy: { minWidth: 0, flex: 1, gap: 3 },
  eyebrow: { color: '#667386', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  title: { color: '#172033', fontSize: 29, fontWeight: '900', marginTop: 2, letterSpacing: -0.4 },
  headerSummary: { color: '#5d6a7c', fontSize: 12, lineHeight: 17 },
  platforms: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: 190 },
  platform: { backgroundColor: 'rgba(255,255,255,.72)', color: '#3a4658', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 6, fontSize: 12, fontWeight: '800' },
  count: { backgroundColor: '#111827', color: '#fff', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, fontSize: 12, fontWeight: '900' },
  board: { minHeight: 520, padding: 18, gap: 12 },
  boardSurface: { position: 'relative', minWidth: '100%', minHeight: '100%', borderRadius: 28, overflow: 'hidden' },
  emptyBoard: { borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(169,180,195,.92)', borderRadius: 20, padding: 22, backgroundColor: 'rgba(255,255,255,.74)' },
  emptyTitle: { fontSize: 20, fontWeight: '900', color: '#172033', marginBottom: 8 },
  muted: { color: '#667386', lineHeight: 21 },
  appCard: { position: 'absolute', borderWidth: 0, borderColor: 'transparent', borderRadius: 8, backgroundColor: 'transparent', padding: 4, gap: 6, overflow: 'visible', alignItems: 'center', justifyContent: 'flex-start' },
  appCardActive: { transform: [{ translateY: -2 }] },
  appCardShell: { position: 'absolute', left: 4, right: 4, top: 10, bottom: 14, borderRadius: 26, backgroundColor: 'rgba(255,255,255,.64)', borderWidth: 1, borderColor: 'rgba(255,255,255,.72)', shadowColor: '#0f172a', shadowOpacity: .1, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 6 },
  appCardHalo: { position: 'absolute', left: 8, right: 8, top: 0, bottom: 10, borderRadius: 30, backgroundColor: 'rgba(37,99,235,.14)' },
  iconWrap: { width: 72, height: 72, borderWidth: 1, borderColor: 'rgba(255,255,255,.86)', borderRadius: 22, backgroundColor: 'rgba(255,255,255,.92)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', shadowOpacity: .18, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 5 },
  appIconName: { width: 100, color: '#182235', fontSize: 12, fontWeight: '900', lineHeight: 15, textAlign: 'center' },
  appCardGlow: { position: 'absolute', left: 0, right: 0, top: 0, height: 4, backgroundColor: '#2563eb' },
  cardHeader: { flexDirection: 'row', gap: 12 },
  cardText: { flex: 1, gap: 6 },
  cardKicker: { color: '#2563eb', fontSize: 11, fontWeight: '900', letterSpacing: .5 },
  cardTitle: { fontSize: 18, fontWeight: '900', color: '#172033' },
  cardDescription: { color: '#536174', lineHeight: 19 },
  previewMetrics: { flexDirection: 'row', gap: 7 },
  previewMetric: { flex: 1, borderWidth: 1, borderColor: '#e3e8f0', borderRadius: 8, backgroundColor: '#f8fafc', padding: 8, gap: 3 },
  previewMetricActive: { borderColor: '#bfdbfe', backgroundColor: '#eff6ff' },
  previewMetricUrgent: { borderColor: '#fed7aa', backgroundColor: '#fff7ed' },
  previewMetricDone: { borderColor: '#bbf7d0', backgroundColor: '#f0fdf4' },
  previewMetricLabel: { color: '#667386', fontSize: 10, fontWeight: '900' },
  previewMetricValue: { color: '#172033', fontSize: 16, fontWeight: '900' },
  previewRecords: { gap: 6 },
  previewRecord: { borderWidth: 1, borderColor: '#e3e8f0', borderRadius: 8, backgroundColor: '#fff', padding: 8, gap: 4 },
  previewRecordTitle: { color: '#172033', fontSize: 13, fontWeight: '900' },
  previewRecordSubtitle: { color: '#667386', fontSize: 11 },
  previewBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  previewBadge: { borderRadius: 999, backgroundColor: '#eef2f7', color: '#455266', paddingHorizontal: 6, paddingVertical: 4, fontSize: 10, fontWeight: '800', overflow: 'hidden' },
  previewEmpty: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#cfd7e4', borderRadius: 8, backgroundColor: '#f8fafc', color: '#667386', padding: 10, fontSize: 12, fontWeight: '800' },
  previewFooter: { gap: 8 },
  previewChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  previewChip: { borderRadius: 999, backgroundColor: '#eef2f7', color: '#455266', paddingHorizontal: 7, paddingVertical: 4, fontSize: 10, fontWeight: '800' },
  previewAction: { alignSelf: 'flex-start', borderRadius: 999, backgroundColor: '#f1f5f9', color: '#536174', paddingHorizontal: 8, paddingVertical: 5, fontSize: 11, fontWeight: '900', overflow: 'hidden' },
  previewActionDone: { backgroundColor: '#dcfce7', color: '#15803d' },
  previewActionActive: { backgroundColor: '#dbeafe', color: '#1d4ed8' },
  previewActionDanger: { backgroundColor: '#fee2e2', color: '#991b1b' },
  connections: { gap: 8 },
  connectionCard: { borderWidth: 1, borderColor: 'rgba(245,158,11,.30)', borderRadius: 16, backgroundColor: 'rgba(255,255,255,.78)', padding: 10, gap: 4, shadowColor: '#0f172a', shadowOpacity: .08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  connectionTitle: { color: '#78350f', fontWeight: '900' },
  connectionText: { color: '#92400e', fontSize: 12 },
  connectionStatus: { color: '#78350f', fontSize: 12, fontWeight: '900' },
  inspector: { borderTopWidth: 1, borderColor: 'rgba(255,255,255,.66)', backgroundColor: 'rgba(255,255,255,.66)', padding: 14, gap: 8 },
  panelTitle: { fontSize: 15, fontWeight: '900', color: '#172033' },
  traceRow: { gap: 8 },
  summary: { color: '#3d495a', lineHeight: 20 },
  tracePill: { backgroundColor: 'rgba(20,184,166,.12)', color: '#0f766e', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, fontSize: 12, fontWeight: '800' },
  promptDock: { flexDirection: 'row', gap: 10, padding: 12, paddingBottom: 6, borderTopWidth: 1, borderColor: 'rgba(255,255,255,.64)', backgroundColor: 'rgba(248,251,255,.82)' },
  promptInput: { flex: 1, minHeight: 50, borderWidth: 1, borderColor: 'rgba(203,213,225,.9)', borderRadius: 16, paddingHorizontal: 14, color: '#172033', backgroundColor: 'rgba(255,255,255,.86)' },
  runButton: { width: 88, minHeight: 50, borderRadius: 16, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  runText: { color: '#fff', fontWeight: '900' },
  disabled: { opacity: .55 },
  status: { color: '#536174', backgroundColor: 'rgba(255,255,255,.72)', paddingHorizontal: 12, paddingBottom: 10, fontSize: 12 },
});
