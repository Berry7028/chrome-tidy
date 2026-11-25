import type { OpenAiConfig } from '../settings';
import { buildPrompt, parseNamingResponse, type NamingBackend, type NamingResult, type NamingTabInfo } from './types';

/** users often paste endpoints without the scheme — normalize so nothing silently breaks */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function hasHostPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(normalizeBaseUrl(url)).origin;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
  sample?: string;
}

/** probe the endpoint with a tiny request — used by the options page test button */
export async function testOpenAiConnection(config: OpenAiConfig): Promise<ConnectionTestResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!config.apiKey) return { ok: false, detail: 'APIキーが未入力です' };
  if (!baseUrl) return { ok: false, detail: 'Base URLが未入力です' };
  if (!(await hasHostPermission(baseUrl))) {
    return { ok: false, detail: 'ホスト権限がありません。一度「保存」して権限を許可してください' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_tokens: 100,
        temperature: 0,
      }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, detail: '応答は返りましたが本文が空でした(推論モデルの場合max_tokens不足の可能性)' };
    return { ok: true, detail: '接続成功', sample: content.slice(0, 40) };
  } catch (err) {
    return { ok: false, detail: `接続失敗: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function makeOpenAiBackend(getConfig: () => Promise<OpenAiConfig>): NamingBackend {
  return {
    id: 'openai',
    async name(tabs: NamingTabInfo[], signal?: AbortSignal): Promise<NamingResult | null> {
      const config = await getConfig();
      if (!config.apiKey || !config.baseUrl) return null;
      const baseUrl = normalizeBaseUrl(config.baseUrl);
      if (!(await hasHostPermission(baseUrl))) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      signal?.addEventListener('abort', () => controller.abort());
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              {
                role: 'system',
                content:
                  'You are a concise naming assistant inside a browser extension. Always reply with a single short line and nothing else.',
              },
              { role: 'user', content: buildPrompt(tabs) },
            ],
            max_tokens: 300,
            temperature: 0.3,
          }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) return null;
        return parseNamingResponse(content);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
