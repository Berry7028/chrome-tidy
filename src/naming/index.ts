import { loadSettings, type Settings } from '../settings';
import { nanoBackend } from './nano';
import { makeOpenAiBackend } from './openai';
import { makeAnthropicBackend } from './anthropic';
import { fallbackBackend } from './fallback';
import type { NamingTabInfo } from './types';

export type { NamingTabInfo } from './types';

function backendFor(settings: Settings) {
  switch (settings.namingProvider) {
    case 'openai':
      return makeOpenAiBackend(async () => (await loadSettings()).openai);
    case 'anthropic':
      return makeAnthropicBackend(async () => (await loadSettings()).anthropic);
    case 'nano':
      return nanoBackend;
    case 'fallback':
      return fallbackBackend;
  }
}

export interface NamingOutcome {
  title: string;
  /** which backend actually produced the title — differs from the configured one when it failed */
  providerUsed: string;
  /** why the configured backend failed, if it did */
  degraded?: string;
}

/**
 * Generate a group title for the given tabs.
 * The first tab should be the source tab of the group, as it carries the most context.
 * Falls back to heuristics when the configured AI backend is unavailable.
 */
export async function generateGroupTitle(
  tabs: NamingTabInfo[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<NamingOutcome> {
  const backend = backendFor(settings);
  let result = null;
  let degraded: string | undefined;

  if (backend !== fallbackBackend) {
    result = await backend.name(tabs, signal);
    if (!result) {
      degraded = `${backend.id} unavailable or failed — fell back to rules`;
      result = await fallbackBackend.name(tabs);
    }
  } else {
    result = await backend.name(tabs);
  }

  if (!result) return { title: '', providerUsed: backend.id, degraded };
  const useEmoji = settings.emojiPrefix && result.emoji;
  return {
    title: useEmoji ? `${result.emoji} ${result.name}` : result.name,
    providerUsed: degraded ? fallbackBackend.id : backend.id,
    degraded,
  };
}
