import { buildPrompt, parseNamingResponse, type NamingBackend, type NamingResult, type NamingTabInfo } from './types';

// Minimal typings for Chrome's built-in Prompt API (Gemini Nano), not yet in @types/chrome.
interface LanguageModelSession {
  prompt(input: string): Promise<string>;
  destroy(): void;
}
interface LanguageModelStatic {
  availability(): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  create(options?: {
    initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    topK?: number;
  }): Promise<LanguageModelSession>;
}

function getLanguageModel(): LanguageModelStatic | null {
  const lm = (globalThis as Record<string, unknown>)['LanguageModel'];
  return lm ? (lm as LanguageModelStatic) : null;
}

let cachedSession: LanguageModelSession | null = null;
let creating: Promise<LanguageModelSession | null> | null = null;

async function getSession(): Promise<LanguageModelSession | null> {
  if (cachedSession) return cachedSession;
  if (creating) return creating;
  creating = (async () => {
    const lm = getLanguageModel();
    if (!lm) return null;
    try {
      const availability = await lm.availability();
      if (availability !== 'available') return null;
      cachedSession = await lm.create({
        initialPrompts: [
          {
            role: 'system',
            content:
              'You are a concise naming assistant inside a browser extension. Always reply with a single short line and nothing else.',
          },
        ],
        temperature: 0.3,
      });
      return cachedSession;
    } catch {
      return null;
    } finally {
      creating = null;
    }
  })();
  return creating;
}

export const nanoBackend: NamingBackend = {
  id: 'nano',
  async name(tabs: NamingTabInfo[], signal?: AbortSignal): Promise<NamingResult | null> {
    const session = await getSession();
    if (!session) return null;
    if (signal?.aborted) return null;
    try {
      const raw = await Promise.race([
        session.prompt(buildPrompt(tabs)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nano timeout')), 15000)),
      ]);
      return parseNamingResponse(raw);
    } catch {
      // session may be broken (e.g. model restarted) — drop it so the next call recreates one
      if (cachedSession) {
        try {
          cachedSession.destroy();
        } catch {
          /* ignore */
        }
        cachedSession = null;
      }
      return null;
    }
  },
};

/** Exposed for the options page: check whether Gemini Nano can be used right now. */
export async function nanoAvailability(): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported'> {
  const lm = getLanguageModel();
  if (!lm) return 'unsupported';
  try {
    return await lm.availability();
  } catch {
    return 'unsupported';
  }
}

/** Exposed for the options page: trigger the model download from a user gesture. */
export async function nanoWarmup(): Promise<boolean> {
  const lm = getLanguageModel();
  if (!lm) return false;
  try {
    const session = await lm.create();
    session.destroy();
    return true;
  } catch {
    return false;
  }
}
