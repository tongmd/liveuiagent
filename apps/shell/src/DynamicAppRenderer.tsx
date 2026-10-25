import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AppRecord, A2UIMessage, A2UISurfaceSpec } from '@liveuiagent/app-spec';

type RendererProps = {
  app: AppRecord;
  onAction: (actionId: string, eventPayload: unknown) => Promise<void>;
  busy: boolean;
};

type A2UIComponent = Record<string, any> & {
  id: string;
  component: string;
};

type SurfaceModel = {
  surfaceId: string;
  components: Map<string, A2UIComponent>;
  rootId: string;
  data: Record<string, any>;
};

function requiredObject<T extends object>(value: unknown, message: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as T;
}

function requiredArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value as T[];
}

function optionalArray<T>(value: unknown, message: string): T[] {
  if (value === undefined) return [];
  return requiredArray<T>(value, message);
}

function requiredText(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value;
}

function requiredA2ui(app: AppRecord): A2UISurfaceSpec {
  const a2ui = requiredObject<A2UISurfaceSpec>(app.appPackage.ui.meta?.a2ui, `app ${app.appId} missing A2UI surface`);
  if (a2ui.protocol !== 'a2ui') throw new Error(`app ${app.appId} A2UI protocol is invalid`);
  requiredText(a2ui.surfaceId, `app ${app.appId} A2UI missing surfaceId`);
  requiredArray<A2UIMessage>(a2ui.messages, `app ${app.appId} A2UI missing messages`);
  requiredObject(a2ui.initialData, `app ${app.appId} A2UI missing initialData`);
  return a2ui;
}

function buildSurfaceModel(app: AppRecord): SurfaceModel {
  const a2ui = requiredA2ui(app);
  const components = new Map<string, A2UIComponent>();
  let rootId = '';
  let data: Record<string, any> | null = null;

  for (const message of a2ui.messages) {
    const createSurface = (message as any).createSurface;
    if (createSurface !== undefined) {
      const created = requiredObject<{ surfaceId: unknown }>(createSurface, 'A2UI createSurface must be an object');
      if (created.surfaceId !== a2ui.surfaceId) throw new Error(`A2UI createSurface surfaceId mismatch for ${app.appId}`);
    }

    const updateComponents = (message as any).updateComponents;
    if (updateComponents !== undefined) {
      const update = requiredObject<{ surfaceId: unknown; components: unknown }>(updateComponents, 'A2UI updateComponents must be an object');
      if (update.surfaceId !== a2ui.surfaceId) throw new Error(`A2UI updateComponents surfaceId mismatch for ${app.appId}`);
      for (const component of requiredArray<A2UIComponent>(update.components, 'A2UI updateComponents missing components')) {
        requiredText(component.id, 'A2UI component missing id');
        requiredText(component.component, `A2UI component ${component.id} missing component`);
        components.set(component.id, component);
        if (component.id === 'root') rootId = component.id;
      }
    }

    const updateDataModel = (message as any).updateDataModel;
    if (updateDataModel !== undefined) {
      const update = requiredObject<{ surfaceId: unknown; value: unknown }>(updateDataModel, 'A2UI updateDataModel must be an object');
      if (update.surfaceId !== a2ui.surfaceId) throw new Error(`A2UI updateDataModel surfaceId mismatch for ${app.appId}`);
      data = requiredObject<Record<string, any>>(update.value, 'A2UI updateDataModel missing value');
    }
  }

  if (!rootId) throw new Error(`app ${app.appId} A2UI missing root component`);
  if (!data) throw new Error(`app ${app.appId} A2UI missing data model`);
  return { surfaceId: a2ui.surfaceId, components, rootId, data };
}

function resolvePath(data: Record<string, any>, descriptor: unknown) {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor) || !('path' in descriptor)) return descriptor;
  const path = requiredText((descriptor as { path?: unknown }).path, 'A2UI binding missing path');
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  let current: unknown = data;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`A2UI binding path ${path} cannot be resolved`);
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined || current === null) throw new Error(`A2UI binding path ${path} resolved empty`);
  return current;
}

function setPath(data: Record<string, any>, descriptor: unknown, value: string) {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor) || !('path' in descriptor)) {
    throw new Error('TextField value must bind to a data path');
  }
  const path = requiredText((descriptor as { path?: unknown }).path, 'TextField binding missing path');
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  if (!parts.length) throw new Error('TextField binding path is empty');
  let current: Record<string, any> = data;
  for (const part of parts.slice(0, -1)) {
    current = requiredObject<Record<string, any>>(current[part], `TextField binding path ${path} cannot be resolved`);
  }
  current[parts[parts.length - 1]] = value;
}

function resolveActionContext(data: Record<string, any>, context: unknown, rootData: Record<string, any>): Record<string, unknown> {
  const record = requiredObject<Record<string, unknown>>(context, 'A2UI action missing context');
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    const binding = value && typeof value === 'object' ? (value as any).path : undefined;
    if (data !== rootData && typeof binding === 'string' && binding.startsWith('/draft/slots/')) {
      if (binding !== `/draft/slots/${key}` || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        || ['__proto__', 'prototype', 'constructor', 'entityName', 'entityId', 'sourceComponentId'].includes(key)
        || !Object.hasOwn(rootData.draft?.slots || {}, key)) throw new Error('Invalid row slot binding');
      return [key, resolvePath(rootData, value)];
    }
    return [key, resolvePath(data, value)];
  }));
}

export function DynamicAppRenderer({ app, onAction, busy }: RendererProps) {
  const model = useMemo(() => buildSurfaceModel(app), [app]);
  const [data, setData] = useState<Record<string, any>>(() => JSON.parse(JSON.stringify(model.data)));

  // A committed server revision is authoritative after an action or reopen.
  useEffect(() => {
    setData(current => {
      const next = JSON.parse(JSON.stringify(model.data));
      // A poll is not a submitted command. Preserve its visible draft while the
      // same host-issued request remains current; only a new committed nonce clears it.
      if(next.hostCommand?.requestId && next.hostCommand.requestId===current.hostCommand?.requestId && typeof current.hostCommand.draft==='string')next.hostCommand.draft=current.hostCommand.draft;
      return next;
    });
  }, [model]);

  function mutateData(mutator: (draft: Record<string, any>) => void) {
    setData((current) => {
      const next = JSON.parse(JSON.stringify(current)) as Record<string, any>;
      mutator(next);
      return next;
    });
  }

  return (
    <View style={styles.page}>
      <RenderA2UI
        busy={busy}
        componentId={model.rootId}
        data={data}
        model={model}
        mutateData={mutateData}
        onAction={onAction}
      />
    </View>
  );
}

function childIds(component: A2UIComponent): string[] {
  if (component.children !== undefined) return requiredArray<string>(component.children, `A2UI component ${component.id} children must be an array`);
  if (component.child !== undefined) return [requiredText(component.child, `A2UI component ${component.id} child must be text`)];
  return [];
}

function RenderA2UI({ model, componentId, data, rootData = data, busy, mutateData, onAction }: {
  model: SurfaceModel;
  componentId: string;
  data: Record<string, any>;
  rootData?: Record<string, any>;
  busy: boolean;
  mutateData: (mutator: (draft: Record<string, any>) => void) => void;
  onAction: (actionId: string, eventPayload: unknown) => Promise<void>;
}) {
  const component = model.components.get(componentId);
  if (!component) throw new Error(`A2UI component not found: ${componentId}`);

  if (component.component === 'Card') {
    return (
      <View style={styles.card}>
        {childIds(component).map((childId) => (
          <RenderA2UI key={childId} {...{ model, componentId: childId, data, rootData, busy, mutateData, onAction }} />
        ))}
      </View>
    );
  }

  if (component.component === 'Column') {
    return (
      <View style={styles.column}>
        {childIds(component).map((childId) => (
          <RenderA2UI key={childId} {...{ model, componentId: childId, data, rootData, busy, mutateData, onAction }} />
        ))}
      </View>
    );
  }

  if (component.component === 'Row') {
    return (
      <View style={styles.row}>
        {childIds(component).map((childId) => (
          <RenderA2UI key={childId} {...{ model, componentId: childId, data, rootData, busy, mutateData, onAction }} />
        ))}
      </View>
    );
  }

  if (component.component === 'Text') {
    const text = resolvePath(data, component.text);
    return <Text style={textStyle(component.variant)}>{String(text)}</Text>;
  }

  if (component.component === 'TextField') {
    const label = requiredText(component.label, `TextField ${component.id} missing label`);
    const value = String(resolvePath(data, component.value));
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          editable={!busy}
          multiline={component.variant === 'longText'}
          onChangeText={(next) => mutateData((draft) => setPath(draft, component.value, next))}
          style={[styles.input, component.variant === 'longText' && styles.longInput]}
          value={value}
        />
      </View>
    );
  }

  if (component.component === 'Button') {
    const action = requiredObject<any>(component.action, `Button ${component.id} missing action`);
    const event = requiredObject<any>(action.event, `Button ${component.id} missing action event`);
    const actionName = requiredText(event.name, `Button ${component.id} missing action name`);
    const payload = resolveActionContext(data, event.context, rootData);
    return (
      <Pressable
        disabled={busy}
        onPress={() => onAction(actionName, { ...payload, sourceComponentId: component.id })}
        style={[component.variant === 'primary' ? styles.primaryButton : styles.button, busy && styles.disabled]}
      >
        {childIds(component).map((childId) => (
          <RenderA2UI key={childId} {...{ model, componentId: childId, data, rootData, busy, mutateData, onAction }} />
        ))}
      </Pressable>
    );
  }

  if (component.component === 'Tabs') {
    return <RenderTabs {...{ component, model, data, rootData, busy, mutateData, onAction }} />;
  }

  if (component.component === 'List') {
    const children = requiredObject<{ componentId: unknown; path: unknown }>(component.children, `List ${component.id} missing children descriptor`);
    const itemComponentId = requiredText(children.componentId, `List ${component.id} missing item component id`);
    const rows = requiredArray<Record<string, any>>(resolvePath(data, { path: children.path }), `List ${component.id} binding must resolve rows`);
    return (
      <View style={styles.list}>
        {rows.map((row, index) => (
          <RenderA2UI
            busy={busy}
            componentId={itemComponentId}
            data={row}
            rootData={rootData}
            key={`${itemComponentId}-${index}`}
            model={model}
            mutateData={mutateData}
            onAction={onAction}
          />
        ))}
      </View>
    );
  }

  throw new Error(`unsupported A2UI component: ${component.component}`);
}

function RenderTabs({ component, model, data, rootData, busy, mutateData, onAction }: {
  component: A2UIComponent;
  model: SurfaceModel;
  data: Record<string, any>;
  rootData?: Record<string, any>;
  busy: boolean;
  mutateData: (mutator: (draft: Record<string, any>) => void) => void;
  onAction: (actionId: string, eventPayload: unknown) => Promise<void>;
}) {
  const tabs = requiredArray<{ title: string; child: string }>(component.tabs, `Tabs ${component.id} missing tabs`);
  const [active, setActive] = useState(0);
  const tab = tabs[active];
  if (!tab) throw new Error(`Tabs ${component.id} active tab missing`);
  return (
    <View style={styles.tabs}>
      <View style={styles.tabBar}>
        {tabs.map((item, index) => (
          <Pressable key={item.child} onPress={() => setActive(index)} style={[styles.tab, active === index && styles.activeTab]}>
            <Text style={[styles.tabText, active === index && styles.activeTabText]}>{requiredText(item.title, `Tabs ${component.id} tab missing title`)}</Text>
          </Pressable>
        ))}
      </View>
      <RenderA2UI {...{ model, componentId: requiredText(tab.child, `Tabs ${component.id} tab missing child`), data, rootData, busy, mutateData, onAction }} />
    </View>
  );
}

function textStyle(variant: unknown) {
  if (variant === 'h1') return styles.h1;
  if (variant === 'h2') return styles.h2;
  if (variant === 'h3') return styles.h3;
  if (variant === 'caption') return styles.caption;
  return styles.bodyText;
}

const styles = StyleSheet.create({
  page: { gap: 14 },
  card: {
    backgroundColor: 'rgba(255,255,255,.9)',
    borderColor: 'rgba(184,194,208,.72)',
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    shadowColor: '#213047',
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  column: { gap: 12, alignItems: 'stretch' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' },
  field: { gap: 6 },
  label: { color: '#5b687a', fontSize: 12, fontWeight: '800' },
  input: {
    backgroundColor: 'rgba(255,255,255,.86)',
    borderColor: 'rgba(168,181,199,.8)',
    borderRadius: 12,
    borderWidth: 1,
    color: '#142033',
    fontSize: 15,
    minWidth: 220,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  longInput: { minHeight: 96, textAlignVertical: 'top' },
  primaryButton: {
    backgroundColor: '#1769ff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  button: {
    backgroundColor: 'rgba(234,240,249,.9)',
    borderColor: 'rgba(171,183,199,.8)',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  disabled: { opacity: 0.55 },
  tabs: { gap: 12 },
  tabBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tab: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(233,239,248,.82)' },
  activeTab: { backgroundColor: '#172033' },
  tabText: { color: '#536174', fontWeight: '800' },
  activeTabText: { color: '#fff' },
  list: { gap: 10 },
  h1: { color: '#111827', fontSize: 34, fontWeight: '900' },
  h2: { color: '#111827', fontSize: 24, fontWeight: '900' },
  h3: { color: '#182235', fontSize: 18, fontWeight: '900' },
  bodyText: { color: '#334155', fontSize: 15, lineHeight: 22 },
  caption: { color: '#69768a', fontSize: 12, fontWeight: '800' },
});
