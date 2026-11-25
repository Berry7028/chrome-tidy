export type NamingProvider = 'nano' | 'openai' | 'anthropic' | 'fallback';

export interface OpenAiConfig {
  baseUrl: string; // e.g. https://api.openai.com/v1 — OpenAI-compatible endpoint
  apiKey: string;
  model: string;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export interface Settings {
  enabled: boolean;
  /** 'first': group immediately when the first link opens (Dia-faithful). 'second': only when a 2nd link opens from the same source. */
  groupingTrigger: 'first' | 'second';
  namingProvider: NamingProvider;
  /** prepend an emoji to auto-generated group names */
  emojiPrefix: boolean;
  /** re-generate the group name as its contents change */
  evolveNames: boolean;
  /** dissolve a group when only one tab remains in it */
  dissolveSingleTabGroups: boolean;
  /** never auto-group tabs opened from these domains */
  blacklistDomains: string[];
  openai: OpenAiConfig;
  anthropic: AnthropicConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  groupingTrigger: 'first',
  namingProvider: 'nano',
  emojiPrefix: true,
  evolveNames: true,
  dissolveSingleTabGroups: true,
  blacklistDomains: [],
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
  },
  anthropic: {
    apiKey: '',
    model: 'claude-haiku-4-5',
  },
};

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const raw = (stored[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    openai: { ...DEFAULT_SETTINGS.openai, ...raw.openai },
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...raw.anthropic },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

/**
 * Per-session metadata about groups we manage.
 * Group IDs are session-scoped, so this lives in chrome.storage.session.
 */
export interface GroupMeta {
  /** marks groups created by this extension — we never auto-manage user-created groups */
  managed?: true;
  /** last title we set automatically; if the group's current title differs, the user renamed it manually */
  lastAutoTitle?: string;
  /** user renamed the group manually — stop auto-renaming */
  userRenamed?: boolean;
}

const GROUP_META_KEY = 'groupMeta';

export async function loadGroupMeta(): Promise<Record<string, GroupMeta>> {
  const stored = await chrome.storage.session.get(GROUP_META_KEY);
  return (stored[GROUP_META_KEY] ?? {}) as Record<string, GroupMeta>;
}

export async function getGroupMeta(groupId: number): Promise<GroupMeta> {
  const all = await loadGroupMeta();
  return all[String(groupId)] ?? {};
}

export async function setGroupMeta(groupId: number, meta: GroupMeta): Promise<void> {
  const all = await loadGroupMeta();
  all[String(groupId)] = meta;
  await chrome.storage.session.set({ [GROUP_META_KEY]: all });
}

export async function patchGroupMeta(groupId: number, patch: Partial<GroupMeta>): Promise<void> {
  const current = await getGroupMeta(groupId);
  await setGroupMeta(groupId, { ...current, ...patch });
}

export async function removeGroupMeta(groupId: number): Promise<void> {
  const all = await loadGroupMeta();
  delete all[String(groupId)];
  await chrome.storage.session.set({ [GROUP_META_KEY]: all });
}
