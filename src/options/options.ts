import { DEFAULT_SETTINGS, loadSettings, saveSettings, type NamingProvider, type Settings } from '../settings';
import { nanoAvailability, nanoWarmup } from '../naming/nano';
import { normalizeBaseUrl, testOpenAiConnection } from '../naming/openai';
import { testAnthropicConnection } from '../naming/anthropic';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

// ---------- nano status ----------

async function refreshNanoStatus(): Promise<void> {
  const badge = $('nano-status');
  const downloadRow = $('nano-download-row') as HTMLElement;
  const status = await nanoAvailability();
  badge.className = 'badge';
  switch (status) {
    case 'available':
      badge.textContent = '利用可能';
      badge.classList.add('ok');
      downloadRow.hidden = true;
      break;
    case 'downloadable':
      badge.textContent = '要ダウンロード';
      badge.classList.add('warn');
      downloadRow.hidden = false;
      break;
    case 'downloading':
      badge.textContent = 'ダウンロード中';
      badge.classList.add('warn');
      downloadRow.hidden = true;
      break;
    case 'unavailable':
      badge.textContent = 'この端末では利用不可';
      downloadRow.hidden = true;
      break;
    default:
      badge.textContent = '未対応のブラウザ';
      downloadRow.hidden = true;
  }
}

// ---------- form <-> settings ----------

function selectedProvider(): NamingProvider {
  const checked = document.querySelector<HTMLInputElement>('input[name="namingProvider"]:checked');
  return (checked?.value ?? 'nano') as NamingProvider;
}

function selectedTrigger(): 'first' | 'second' {
  const checked = document.querySelector<HTMLInputElement>('input[name="groupingTrigger"]:checked');
  return (checked?.value ?? 'first') as 'first' | 'second';
}

function fillForm(settings: Settings): void {
  input('enabled').checked = settings.enabled;
  input('dissolveSingleTabGroups').checked = settings.dissolveSingleTabGroups;
  input('emojiPrefix').checked = settings.emojiPrefix;
  input('evolveNames').checked = settings.evolveNames;
  input('openai-base-url').value = settings.openai.baseUrl;
  input('openai-api-key').value = settings.openai.apiKey;
  input('openai-model').value = settings.openai.model;
  input('anthropic-api-key').value = settings.anthropic.apiKey;
  input('anthropic-model').value = settings.anthropic.model;
  ($('blacklist') as HTMLTextAreaElement).value = settings.blacklistDomains.join('\n');

  const providerRadio = document.querySelector<HTMLInputElement>(`input[name="namingProvider"][value="${settings.namingProvider}"]`);
  if (providerRadio) providerRadio.checked = true;
  const triggerRadio = document.querySelector<HTMLInputElement>(`input[name="groupingTrigger"][value="${settings.groupingTrigger}"]`);
  if (triggerRadio) triggerRadio.checked = true;
}

function gatherForm(): Settings {
  const blacklistRaw = ($('blacklist') as HTMLTextAreaElement).value;
  return {
    enabled: input('enabled').checked,
    groupingTrigger: selectedTrigger(),
    namingProvider: selectedProvider(),
    emojiPrefix: input('emojiPrefix').checked,
    evolveNames: input('evolveNames').checked,
    dissolveSingleTabGroups: input('dissolveSingleTabGroups').checked,
    blacklistDomains: blacklistRaw
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
    openai: {
      baseUrl: normalizeBaseUrl(input('openai-base-url').value) || DEFAULT_SETTINGS.openai.baseUrl,
      apiKey: input('openai-api-key').value.trim(),
      model: input('openai-model').value.trim() || DEFAULT_SETTINGS.openai.model,
    },
    anthropic: {
      apiKey: input('anthropic-api-key').value.trim(),
      model: input('anthropic-model').value.trim() || DEFAULT_SETTINGS.anthropic.model,
    },
  };
}

// ---------- host permissions for cloud providers ----------

function neededOrigins(settings: Settings): string[] {
  const origins: string[] = [];
  if (settings.namingProvider === 'openai') {
    try {
      origins.push(`${new URL(normalizeBaseUrl(settings.openai.baseUrl)).origin}/*`);
    } catch {
      // invalid URL — validation message handled elsewhere
    }
  }
  if (settings.namingProvider === 'anthropic') {
    origins.push('https://api.anthropic.com/*');
  }
  return origins;
}

// ---------- save ----------

async function onSave(): Promise<void> {
  const statusEl = $('save-status');
  const settings = gatherForm();

  // cloud providers need host permission for their endpoint — request it now,
  // inside the click gesture, so the service worker can call the API
  const origins = neededOrigins(settings);
  if (origins.length > 0) {
    try {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        statusEl.textContent = 'ホスト権限が許可されませんでした。クラウドAI命名は動作しません。';
        await saveSettings(settings);
        return;
      }
    } catch (err) {
      console.warn('[chrome-tidy] permission request failed', err);
    }
  }

  await saveSettings(settings);
  statusEl.textContent = '保存しました';
  setTimeout(() => {
    statusEl.textContent = '';
  }, 2500);
}

// ---------- init ----------

function refreshConfigVisibility(): void {
  const provider = selectedProvider();
  $('openai-config').classList.toggle('config-hidden', provider !== 'openai');
  $('anthropic-config').classList.toggle('config-hidden', provider !== 'anthropic');
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  fillForm(settings);
  refreshConfigVisibility();
  void refreshNanoStatus();

  document.querySelectorAll('input[name="namingProvider"]').forEach((el) => {
    el.addEventListener('change', refreshConfigVisibility);
  });

  // --- connection test buttons ---
  document.querySelectorAll<HTMLButtonElement>('.test-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider;
      const resultEl = $(`${provider}-test-result`);
      resultEl.className = 'test-result';
      resultEl.textContent = 'テスト中…';
      btn.disabled = true;
      try {
        const form = gatherForm();
        const result =
          provider === 'openai'
            ? await testOpenAiConnection(form.openai)
            : await testAnthropicConnection(form.anthropic);
        resultEl.textContent = result.ok ? `✓ ${result.detail}` : `✗ ${result.detail}`;
        resultEl.classList.add(result.ok ? 'ok' : 'err');
      } finally {
        btn.disabled = false;
      }
    });
  });

  // --- live naming status ---
  const renderStatus = async () => {
    const stored = await chrome.storage.session.get('lastNaming');
    const log = stored['lastNaming'] as
      | { at: number; provider: string; title: string; degraded: string | null }
      | undefined;
    const el = $('naming-status');
    if (!log) {
      el.textContent = 'まだ命名は実行されていません';
      return;
    }
    const when = new Date(log.at).toLocaleTimeString('ja-JP');
    const providerLabel =
      log.provider === 'nano' ? 'Gemini Nano' : log.provider === 'fallback' ? 'ルールベース' : log.provider;
    el.textContent = `最後の命名: "${log.title}" — ${providerLabel} (${when})${log.degraded ? ' / ' + log.degraded : ''}`;
  };
  await renderStatus();
  chrome.storage.session.onChanged.addListener((changes) => {
    if ('lastNaming' in changes) void renderStatus();
  });

  $('save').addEventListener('click', () => void onSave());
  $('nano-download').addEventListener('click', async () => {
    const badge = $('nano-status');
    badge.textContent = 'ダウンロード開始…';
    const ok = await nanoWarmup();
    if (!ok) badge.textContent = 'ダウンロードを開始できませんでした';
    // poll once after a short wait — large models download in the background
    setTimeout(() => void refreshNanoStatus(), 3000);
  });
}

void init();
