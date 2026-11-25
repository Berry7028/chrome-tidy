import type { AnthropicConfig } from '../settings';
import { buildPrompt, parseNamingResponse, type NamingBackend, type NamingResult, type NamingTabInfo } from './types';
import { hasHostPermission } from './openai';

const API_URL = 'https://api.anthropic.com/v1/messages';

export function makeAnthropicBackend(getConfig: () => Promise<AnthropicConfig>): NamingBackend {
  return {
    id: 'anthropic',
    async name(tabs: NamingTabInfo[], signal?: AbortSignal): Promise<NamingResult | null> {
      const config = await getConfig();
      if (!config.apiKey) return null;
      if (!(await hasHostPermission(API_URL))) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      signal?.addEventListener('abort', () => controller.abort());
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 100,
            system:
              'You are a concise naming assistant inside a browser extension. Always reply with a single short line and nothing else.',
            messages: [{ role: 'user', content: buildPrompt(tabs) }],
          }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };
        const text = data.content?.find((b) => b.type === 'text')?.text;
        if (!text) return null;
        return parseNamingResponse(text);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
  sample?: string;
}

/** probe the endpoint with a tiny request — used by the options page test button */
export async function testAnthropicConnection(config: AnthropicConfig): Promise<ConnectionTestResult> {
  if (!config.apiKey) return { ok: false, detail: 'APIキーが未入力です' };
  if (!(await hasHostPermission(API_URL))) {
    return { ok: false, detail: 'ホスト権限がありません。一度「保存」して権限を許可してください' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim();
    if (!text) return { ok: false, detail: '応答は返りましたが本文が空でした' };
    return { ok: true, detail: '接続成功', sample: text.slice(0, 40) };
  } catch (err) {
    return { ok: false, detail: `接続失敗: ${err instanceof Error ? err.message : String(err)}` };
  }
}
