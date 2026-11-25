import type { NamingBackend, NamingResult, NamingTabInfo } from './types';

/** Heuristic naming used when no AI backend is available. Never fails. */
export const fallbackBackend: NamingBackend = {
  id: 'fallback',
  async name(tabs: NamingTabInfo[]): Promise<NamingResult | null> {
    const first = tabs[0];
    if (!first) return { name: 'Group' };

    let candidate = first.title.trim();
    if (candidate) {
      // titles often look like "Page specific part | Site Name" — keep the specific part
      const segments = candidate.split(/\s+[|·—–]\s+|\s+-\s+/).filter(Boolean);
      if (segments.length > 1) {
        // prefer the first segment, unless it is very short and generic
        candidate = segments[0] ?? candidate;
      }
      if (candidate.length > 32) candidate = `${candidate.slice(0, 32).trimEnd()}…`;
      return { name: candidate };
    }
    if (first.hostname) return { name: first.hostname.replace(/^www\./, '') };
    return { name: 'Group' };
  },
};
