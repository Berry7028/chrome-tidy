import {
  onCreatedNavigationTarget,
  onGroupRemoved,
  onGroupUpdated,
  onTabCreated,
  onTabRemoved,
} from './grouping';

// core signal: a link opened into a new tab (middle click, cmd/ctrl+click,
// target=_blank, "open in new tab") — carries both source and target tab ids
chrome.webNavigation.onCreatedNavigationTarget.addListener(onCreatedNavigationTarget);

// a new tab natively added to a managed group (children of grouped tabs) — evolve the name
chrome.tabs.onCreated.addListener(onTabCreated);

// maintenance: dissolve single-tab groups, clean up metadata
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => onTabRemoved(tabId, removeInfo));
chrome.tabGroups.onRemoved.addListener(onGroupRemoved);
chrome.tabGroups.onUpdated.addListener(onGroupUpdated);

console.log('[chrome-tidy] service worker started');
