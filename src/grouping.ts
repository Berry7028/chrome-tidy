import {
  getGroupMeta,
  loadSettings,
  patchGroupMeta,
  removeGroupMeta,
  setGroupMeta,
  type Settings,
} from './settings';
import { generateGroupTitle, type NamingTabInfo } from './naming';

const GROUP_ID_NONE = -1;

// ---------- small utilities ----------

function hostnameOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isHttpLike(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

function isBlacklisted(settings: Settings, url: string | undefined): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return settings.blacklistDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

async function isNormalWindow(windowId: number): Promise<boolean> {
  try {
    const win = await chrome.windows.get(windowId);
    return win.type === 'normal';
  } catch {
    return false;
  }
}

/** serialize async work per key so rapid link clicks don't race each other */
const chains = new Map<string, Promise<void>>();
function serialize(key: string, fn: () => Promise<void>): void {
  const prev = chains.get(key) ?? Promise.resolve();
  const next: Promise<void> = prev.then(fn).catch((err) => console.warn('[chrome-tidy]', err));
  const final = next.finally(() => {
    if (chains.get(key) === final) chains.delete(key);
  });
  chains.set(key, final);
}

// ---------- naming pipeline ----------

const renameTimers = new Map<number, number>();
const lastRenameAt = new Map<number, number>();

async function tabsInGroup(groupId: number, windowId: number): Promise<chrome.tabs.Tab[]> {
  const all = await chrome.tabs.query({ windowId });
  return all
    .filter((t) => t.groupId === groupId)
    .sort((a, b) => a.index - b.index);
}

async function renameGroupNow(groupId: number): Promise<void> {
  const settings = await loadSettings();
  const meta = await getGroupMeta(groupId);
  if (meta.userRenamed) return;

  let group: chrome.tabGroups.TabGroup;
  try {
    group = await chrome.tabGroups.get(groupId);
  } catch {
    return; // group is gone
  }
  const tabs = await tabsInGroup(groupId, group.windowId);
  if (tabs.length === 0) return;

  const infos: NamingTabInfo[] = tabs.map((t) => ({
    title: t.title ?? '',
    hostname: hostnameOf(t.url),
  }));

  // throttle: don't re-evolve more than once every 20s per group
  const now = Date.now();
  const last = lastRenameAt.get(groupId) ?? 0;
  if (meta.lastAutoTitle && now - last < 20_000) return;

  const outcome = await generateGroupTitle(infos, settings);
  if (!outcome.title) return;
  // write meta before applying the title: the onUpdated event can arrive
  // before the patch completes, and must not be misread as a user rename
  await patchGroupMeta(groupId, { lastAutoTitle: outcome.title });
  try {
    await chrome.tabGroups.update(groupId, { title: outcome.title });
    lastRenameAt.set(groupId, Date.now());
  } catch {
    // group disappeared while naming — fine
  }
  // record activity so the options page can show whether AI naming is really in use
  try {
    await chrome.storage.session.set({
      lastNaming: {
        at: Date.now(),
        provider: outcome.providerUsed,
        title: outcome.title,
        degraded: outcome.degraded ?? null,
      },
    });
  } catch {
    // diagnostics only — never break naming
  }
}

/** debounced rename: coalesces bursts of tab additions into one AI call */
export function scheduleRename(groupId: number, delayMs = 3000): void {
  const existing = renameTimers.get(groupId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    renameTimers.delete(groupId);
    void renameGroupNow(groupId).catch((err) => console.warn('[chrome-tidy] rename failed', err));
  }, delayMs) as unknown as number;
  renameTimers.set(groupId, timer);
}

// ---------- group creation ----------

type GroupColor = `${chrome.tabGroups.Color}`;

const PALETTE: GroupColor[] = ['blue', 'cyan', 'green', 'yellow', 'pink', 'purple', 'red', 'orange'];

function colorForGroup(groupId: number): GroupColor {
  return PALETTE[Math.abs(groupId) % PALETTE.length] ?? 'blue';
}

async function createAndNameGroup(tabIds: number[], windowId: number): Promise<number | null> {
  try {
    if (tabIds.length === 0) return null;
    const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] });
    await chrome.tabGroups.update(groupId, {
      color: colorForGroup(groupId),
      collapsed: false,
    });
    await setGroupMeta(groupId, { managed: true });
    scheduleRename(groupId, 2500);
    return groupId;
  } catch (err) {
    console.warn('[chrome-tidy] failed to create group', err);
    return null;
  }
}

// ---------- navigation target handling ----------

interface PendingFirstChild {
  tabId: number;
  at: number;
}
/** for 'second' trigger mode: the first ungrouped child per source tab (best-effort, in-memory) */
const pendingFirstChild = new Map<number, PendingFirstChild>();
const SECOND_TRIGGER_WINDOW_MS = 5 * 60 * 1000;

async function handlePinnedSource(source: chrome.tabs.Tab, target: chrome.tabs.Tab): Promise<void> {
  // pinned tabs can't join groups in Chrome, so only the children get grouped.
  // a single child alone in a group is pointless — wait until there are 2+ children.
  const all = await chrome.tabs.query({ windowId: source.windowId });
  const children = all.filter((t) => t.openerTabId === source.id && t.id !== undefined);
  const groupedChild = children.find((t) => t.groupId !== GROUP_ID_NONE && t.id !== target.id);

  if (groupedChild) {
    // a children-group already exists — just add the new child
    if (target.groupId !== groupedChild.groupId) {
      await chrome.tabs.group({ tabIds: target.id!, groupId: groupedChild.groupId });
    }
    scheduleRename(groupedChild.groupId);
    return;
  }

  const childIds = children.map((t) => t.id!).filter(Boolean);
  if (childIds.length >= 2) {
    await createAndNameGroup(childIds, source.windowId);
  }
}

async function maybeGroupPair(source: chrome.tabs.Tab, target: chrome.tabs.Tab, settings: Settings): Promise<void> {
  if (settings.groupingTrigger === 'first') {
    await createAndNameGroup([source.id!, target.id!], source.windowId);
    return;
  }

  // 'second' mode: hold off until a second link opens from the same source
  const now = Date.now();
  const pending = pendingFirstChild.get(source.id!);
  if (pending && now - pending.at < SECOND_TRIGGER_WINDOW_MS) {
    const ids: number[] = [source.id!];
    try {
      const first = await chrome.tabs.get(pending.tabId);
      if (first.groupId === GROUP_ID_NONE) ids.push(pending.tabId);
    } catch {
      // first child is gone — group source + current target only
    }
    ids.push(target.id!);
    if (ids.length >= 2) await createAndNameGroup(ids, source.windowId);
    pendingFirstChild.delete(source.id!);
  } else {
    pendingFirstChild.set(source.id!, { tabId: target.id!, at: now });
  }
}

export function onCreatedNavigationTarget(details: chrome.webNavigation.WebNavigationSourceCallbackDetails): void {
  serialize(`src:${details.sourceTabId}`, async () => {
    const settings = await loadSettings();
    if (!settings.enabled) return;

    let source: chrome.tabs.Tab;
    let target: chrome.tabs.Tab;
    try {
      [source, target] = await Promise.all([
        chrome.tabs.get(details.sourceTabId),
        chrome.tabs.get(details.tabId),
      ]);
    } catch {
      return; // either tab already gone
    }
    if (source.id === undefined || target.id === undefined) return;
    if (source.windowId !== target.windowId) return; // shift+click new window etc.
    if (!(await isNormalWindow(target.windowId))) return; // grouping unsupported in popups/apps

    const targetUrl = target.url || details.url;
    if (!isHttpLike(targetUrl)) return;
    if (isBlacklisted(settings, source.url)) return;
    if (isBlacklisted(settings, targetUrl)) return;

    if (source.groupId !== GROUP_ID_NONE) {
      // Chrome normally adds children to the opener's group natively, but not
      // always (e.g. some target=_blank flows) — ensure membership ourselves.
      if (target.groupId !== source.groupId) {
        try {
          await chrome.tabs.group({ tabIds: target.id, groupId: source.groupId });
        } catch {
          return;
        }
      }
      if (settings.evolveNames) scheduleRename(source.groupId);
      return;
    }

    if (target.groupId !== GROUP_ID_NONE) return; // already grouped somehow

    if (source.pinned) {
      await handlePinnedSource(source, target);
      return;
    }

    await maybeGroupPair(source, target, settings);
  });
}

// ---------- group lifecycle maintenance ----------

export function onTabCreated(tab: chrome.tabs.Tab): void {
  // tabs Chrome natively placed into a group (children of grouped tabs) —
  // if we manage that group, the contents changed so the name may need evolving
  if (tab.groupId === GROUP_ID_NONE) return;
  serialize(`grp:${tab.groupId}`, async () => {
    const settings = await loadSettings();
    if (!settings.evolveNames) return;
    const meta = await getGroupMeta(tab.groupId);
    if (!meta.managed) return; // only manage groups we created
    if (meta.userRenamed) return;
    scheduleRename(tab.groupId);
  });
}

async function dissolveCheck(windowId: number): Promise<void> {
  const settings = await loadSettings();
  if (!settings.dissolveSingleTabGroups) return;
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  for (const group of groups) {
    const members = tabs.filter((t) => t.groupId === group.id && t.id !== undefined);
    if (members.length === 1) {
      const meta = await getGroupMeta(group.id);
      // only auto-dissolve groups we created — never touch user-made groups
      if (!meta.managed) continue;
      try {
        await chrome.tabs.ungroup(members[0]!.id!);
      } catch {
        // ignore — tab may be gone
      }
    }
  }
}

export function onTabRemoved(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }): void {
  if (removeInfo.isWindowClosing) return;
  // let Chrome settle group membership first
  setTimeout(() => {
    serialize(`win:${removeInfo.windowId}`, () => dissolveCheck(removeInfo.windowId));
  }, 600);
}

export function onGroupRemoved(group: chrome.tabGroups.TabGroup): void {
  void removeGroupMeta(group.id);
  lastRenameAt.delete(group.id);
  const timer = renameTimers.get(group.id);
  if (timer !== undefined) clearTimeout(timer);
  renameTimers.delete(group.id);
}

export function onGroupUpdated(group: chrome.tabGroups.TabGroup): void {
  serialize(`meta:${group.id}`, async () => {
    const meta = await getGroupMeta(group.id);
    if (!meta.managed) return; // not ours
    const current = group.title ?? '';
    if (!meta.lastAutoTitle && current !== '') {
      // we have never named this group, yet it has a title — must be the user's
      await patchGroupMeta(group.id, { userRenamed: true });
      return;
    }
    if (meta.lastAutoTitle && current !== meta.lastAutoTitle) {
      if (current === '') {
        // user cleared the title — treat as a reset, resume auto naming
        await patchGroupMeta(group.id, { userRenamed: false, lastAutoTitle: undefined });
        scheduleRename(group.id, 1000);
      } else {
        // user renamed manually — respect it from now on
        await patchGroupMeta(group.id, { userRenamed: true });
      }
    }
  });
}
