export interface NamingTabInfo {
  title: string;
  hostname: string;
}

export interface NamingResult {
  /** short label without emoji */
  name: string;
  /** single emoji, if the provider produced one */
  emoji?: string;
}

/**
 * A naming backend. Returns null when it is unavailable or fails —
 * the caller then degrades to the next provider / heuristic fallback.
 */
export interface NamingBackend {
  readonly id: string;
  name(tabs: NamingTabInfo[], signal?: AbortSignal): Promise<NamingResult | null>;
}

export function buildPrompt(tabs: NamingTabInfo[]): string {
  const lines = tabs
    .slice(0, 12)
    .map((t) => `- ${t.title || '(untitled)'} (${t.hostname})`)
    .join('\n');
  return [
    'You name browser tab groups. Given these tabs, output a very short label (1-4 words) for the common topic or activity, plus one fitting emoji.',
    '',
    'Rules:',
    '- Reply with exactly one line: <emoji> <label>',
    '- Use the same language as the tab titles.',
    '- Be specific but concise. No quotes, no punctuation at the end.',
    '- If the tabs share a site or project, name that.',
    '',
    'Tabs:',
    lines,
  ].join('\n');
}

const EMOJI_RE = /^(\S*\p{Extended_Pictographic}\S*)\s+/u;

/** Parse a model response line of the form "<emoji> <label>", leniently. */
export function parseNamingResponse(raw: string): NamingResult | null {
  const line = raw.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return null;
  const cleaned = line.replace(/^["'`]+|["'`.,;:]+$/g, '');
  const match = cleaned.match(EMOJI_RE);
  let emoji: string | undefined;
  let rest = cleaned;
  if (match) {
    emoji = match[1];
    rest = cleaned.slice(match[0].length);
  }
  rest = rest.trim().replace(/^["'`]+|["'`.,;:]+$/g, '');
  if (!rest) return null;
  // hard cap on length so groups stay readable
  if (rest.length > 40) rest = rest.slice(0, 40).trimEnd();
  return { name: rest, emoji };
}
