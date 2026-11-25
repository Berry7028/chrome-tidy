import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const base_ = resolve('chrome');
let CHROME;
for (const dir of readdirSync(base_)) {
  const p = join(base_, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(p)) CHROME = p;
}
const CDP_PORT = 9233;
const distPath = resolve('dist');

const page = (title, links = []) => `<!doctype html><html><head><title>${title}</title></head><body>${links.map(([h, tx]) => `<a href="${h}">${tx}</a> `).join('')}</body></html>`;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/a') res.end(page('Source Doc', [['/b', 'b'], ['/c', 'c']]));
  else if (req.url === '/b') res.end(page('Page B'));
  else if (req.url === '/c') res.end(page('Page C'));
  else res.end(page('home'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); rejectP(new Error('timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) { clearTimeout(timer); ws.close(); resolveP(msg.result?.result?.value); }
    };
    ws.onerror = () => { clearTimeout(timer); rejectP(new Error('ws error')); };
  });
}

const profile = mkdtempSync(join(tmpdir(), 'ct-second-'));
const chromeProc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run',
  '--load-extension=' + distPath, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${extra}`); failures++; }
}

try {
  // wait for extension sw
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      for (const t of list.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))) {
        try {
          const name = await cdpEvaluate(t.webSocketDebuggerUrl, 'chrome.runtime.getManifest().name');
          if (name?.includes('Chrome Tidy')) sw = t;
        } catch {}
      }
    } catch {}
    if (!sw) await sleep(300);
  }
  if (!sw) throw new Error('sw not found');
  console.log('sw found');

  // switch to 'second' mode
  await cdpEvaluate(sw.webSocketDebuggerUrl, `(async () => {
    const stored = await chrome.storage.sync.get('settings');
    const s = stored.settings || {};
    s.groupingTrigger = 'second';
    s.enabled = true;
    await chrome.storage.sync.set({ settings: s });
    return 'ok';
  })()`).then((r) => console.log('mode set:', r));

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const pageA = await context.newPage();
  await pageA.goto(`${base}/a`);
  await pageA.waitForLoadState('load');

  const groupCount = async () => {
    const st = await cdpEvaluate(sw.webSocketDebuggerUrl, `(async () => ({ n: (await chrome.tabGroups.query({})).length }))()`);
    return st?.n ?? -1;
  };

  console.log('second-mode: first link should NOT create a group');
  await pageA.click('a[href="/b"]', { button: 'middle' });
  await sleep(1500);
  check('no group after first link', (await groupCount()) === 0, `got ${await groupCount()}`);

  console.log('second-mode: second link SHOULD create a group');
  await pageA.bringToFront();
  await pageA.click('a[href="/c"]', { button: 'middle' });
  await sleep(1500);
  check('group exists after second link', (await groupCount()) === 1, `got ${await groupCount()}`);

  const st = await cdpEvaluate(sw.webSocketDebuggerUrl, `(async () => {
    const groups = await chrome.tabGroups.query({});
    const tabs = await chrome.tabs.query({});
    const gid = groups[0]?.id;
    return { members: tabs.filter(t => t.groupId === gid).map(t => t.url) };
  })()`);
  check('group contains source + both children', st.members.length === 3, JSON.stringify(st.members));

  await browser.close();
  console.log(failures === 0 ? 'SECOND-MODE TESTS PASSED' : failures + ' FAILED');
} catch (e) {
  console.error('err', e);
  failures++;
} finally {
  chromeProc.kill('SIGKILL');
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
