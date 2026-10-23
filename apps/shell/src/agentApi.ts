import Constants from 'expo-constants';
import { Platform } from 'react-native';

const extra = Constants.expoConfig?.extra as { agentGatewayUrl?: string } | undefined;

export function gatewayUrl() {
  const configured = process.env.EXPO_PUBLIC_AGENT_GATEWAY_URL ?? extra?.agentGatewayUrl;
  if (configured) return configured;
  return Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://127.0.0.1:8787';
}

export async function agentPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${gatewayUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!text.trim()) throw new Error(`${path} returned an empty response`);
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(String(data.error ?? text));
  return data as T;
}
