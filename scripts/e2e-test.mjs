/**
 * End-to-end test: launches real Chrome (headless=new) with the extension,
 * drives pages via playwright-over-CDP, and inspects tab group state by
 * evaluating directly inside the extension's service worker over raw CDP.
 *
 * Usage: node scripts/e2e-test.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || (() => {
  // Chrome for Testing: npx @puppeteer/browsers install chrome@stable
  const base = resolve('chrome');
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      const p = join(base, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(p)) return p;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
})();
const distPath = resolve('dist');
const CDP_PORT = 9224;

// ---------- test site ----------
const page = (title, links = []) => `<!doctype html><html><head><title>${title}</title></head>
<body><h1>${title}</h1>${links.map(([href, text]) => `<a href="${href}">${text}</a> `).join('\n')}</body></html>`;

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/a') res.end(page('Japan Trip Planning', [['/b', 'link to b'], ['/c', 'link to c']]));
  else if (req.url === '/x') res.end(`<!doctype html><html><head><title>Blank Link Source</title></head><body><a href="/y" target="_blank" id="blank">blank link</a><a href="/z" id="normal">normal link</a></body></html>`);
  else if (req.url === '/y') res.end(page('Blank Target Page'));
  else if (req.url === '/z') res.end(page('Normal Target Page'));
  else if (req.url === '/b') res.end(page('Hotels in Kyoto', [['/d', 'link to d']]));
  else if (req.url === '/c') res.end(page('Flights to Osaka'));
  else if (req.url === '/d') res.end(page('Ryokan Guide'));
  else res.end(page('home'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// ---------- tiny CDP client ----------
function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      rejectP(new Error('cdp evaluate timeout'));
    }, 8000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (msg.result?.exceptionDetails) {
          rejectP(new Error('evaluation exception: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 300)));
        } else {
          resolveP(msg.result?.result?.value);
        }
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rejectP(new Error('ws error'));
    };
  });
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return res.json();
}

async function findExtensionSw() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await targets();
      const workers = list.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
      for (const w of workers) {
        try {
          const name = await cdpEvaluate(w.webSocketDebuggerUrl, 'chrome.runtime.getManifest().name');
          if (name && name.includes('Chrome Tidy')) return w;
        } catch {
          // worker may not answer yet
        }
      }
    } catch {
      // chrome not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('chrome-tidy service worker not found');
}

// ---------- launch chrome ----------
const profile = mkdtempSync(join(tmpdir(), 'chrome-tidy-test-'));
const chromeArgs = [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--disable-extensions-except=' + distPath,
  '--load-extension=' + distPath,
  'about:blank',
];
const chromeProc = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore'] });

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${extra}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function groupState(swUrl) {
  return cdpEvaluate(
    swUrl,
    `(async () => {
      const groups = await chrome.tabGroups.query({});
      const tabs = await chrome.tabs.query({});
      return {
        groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color })),
        tabs: tabs.map(t => ({ id: t.id, url: t.url, groupId: t.groupId })),
      };
    })()`,
  );
}

try {
  console.log('waiting for extension service worker...');
  const sw = await findExtensionSw();
  console.log('found:', sw.url);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const pageA = await context.newPage();
  await pageA.goto(`${base}/a`);
  await pageA.waitForLoadState('load');

  // --- test 1: middle-click a link -> group with source + target ---
  console.log('\ntest 1: middle-click a link creates a group with source + target');
  await pageA.click('a[href="/b"]', { button: 'middle' });
  await sleep(1500);

  let state = await groupState(sw.webSocketDebuggerUrl);
  check('exactly one group exists', state.groups.length === 1, JSON.stringify(state));
  if (state.groups.length === 1) {
    const gid = state.groups[0].id;
    const members = state.tabs.filter((t) => t.groupId === gid);
    check('group has exactly 2 tabs', members.length === 2, `got ${members.length}: ` + JSON.stringify(state.tabs));
    check(
      'group contains source /a and target /b',
      members.some((t) => t.url.endsWith('/a')) && members.some((t) => t.url.endsWith('/b')),
      JSON.stringify(members.map((t) => t.url)),
    );
  }

  // --- test 2: second link from same source joins the same group ---
  console.log('\ntest 2: second link from grouped source joins the same group');
  await pageA.bringToFront();
  await pageA.click('a[href="/c"]', { button: 'middle' });
  await sleep(1500);

  state = await groupState(sw.webSocketDebuggerUrl);
  check('still exactly one group', state.groups.length === 1, JSON.stringify(state.groups));
  if (state.groups.length === 1) {
    const members = state.tabs.filter((t) => t.groupId === state.groups[0].id);
    check('group now has 3 tabs', members.length === 3, `got ${members.length}`);
  }

  // --- test 3: the group gets a name (fallback heuristic in this env) ---
  console.log('\ntest 3: group receives an automatic name');
  await sleep(3500); // debounce window
  state = await groupState(sw.webSocketDebuggerUrl);
  const title = state.groups[0]?.title ?? '';
  check('group has a non-empty title', title.length > 0, `title="${title}"`);
  console.log(`  group title: "${title}"`);

  // --- test 3b: naming activity is recorded for the options page status ---
  console.log('\ntest 3b: naming activity is recorded');
  const namingLog = await cdpEvaluate(sw.webSocketDebuggerUrl, `(async () => (await chrome.storage.session.get('lastNaming')).lastNaming)()`);
  check('lastNaming log exists', !!namingLog, JSON.stringify(namingLog));
  check('provider is recorded', typeof namingLog?.provider === 'string', JSON.stringify(namingLog));
  console.log('  naming log:', JSON.stringify(namingLog));

  // --- test 4: link opened from a child tab inside the group stays in the group ---
  console.log('\ntest 4: link opened from a child tab joins the group too');
  const pageB = context.pages().find((p) => p.url().endsWith('/b'));
  if (pageB) {
    await pageB.bringToFront();
    await pageB.click('a[href="/d"]', { button: 'middle' });
    await sleep(1500);
    state = await groupState(sw.webSocketDebuggerUrl);
    const members = state.tabs.filter((t) => t.groupId === state.groups[0]?.id);
    check(
      'group now has 4 tabs including /d',
      members.length === 4 && members.some((t) => t.url.endsWith('/d')),
      JSON.stringify(members.map((t) => t.url)),
    );
  } else {
    check('page /b found', false, JSON.stringify(context.pages().map((p) => p.url())));
  }

  // --- test 4b: cmd+click (the canonical Dia gesture) also triggers grouping ---
  console.log('\ntest 4b: cmd+click on a link creates a group with source + target');
  await pageA.bringToFront();
  // page /a is already grouped, so use a fresh ungrouped page instead
  const pageX = await context.newPage();
  await pageX.goto(`${base}/x`);
  await pageX.waitForLoadState('load');
  await pageX.click('a#normal', { modifiers: ['Meta'] });
  await sleep(1500);
  state = await groupState(sw.webSocketDebuggerUrl);
  const pairGroup = state.groups.find((g) => {
    const members = state.tabs.filter((t) => t.groupId === g.id);
    return members.some((t) => t.url.endsWith('/x')) && members.some((t) => t.url.endsWith('/z'));
  });
  check('cmd+click created a group containing /x and /z', !!pairGroup, JSON.stringify(state.groups));
  // clean up: close the /z tab and /x page so later tests are unaffected
  const pageZ = context.pages().find((p) => p.url().endsWith('/z'));
  if (pageZ) await pageZ.close();
  await sleep(900);

  // --- test 4c: plain left click on target=_blank link also groups ---
  console.log('\ntest 4c: target=_blank plain click creates/joins a group');
  await pageX.bringToFront();
  await pageX.click('a#blank'); // plain click, no modifiers
  await sleep(1500);
  state = await groupState(sw.webSocketDebuggerUrl);
  const blankGroup = state.groups.find((g) => {
    const members = state.tabs.filter((t) => t.groupId === g.id);
    return members.some((t) => t.url.endsWith('/y'));
  });
  check('target=_blank tab joined a group', !!blankGroup, JSON.stringify(state));
  const pageY = context.pages().find((p) => p.url().endsWith('/y'));
  if (pageY) await pageY.close();
  await pageX.close();
  await sleep(900);

  // --- test 5: closing tabs down to one dissolves the group ---
  console.log('\ntest 5: group dissolves when only one tab remains');
  for (const suffix of ['/d', '/c', '/b']) {
    const p = context.pages().find((pg) => pg.url().endsWith(suffix));
    if (p) await p.close();
    await sleep(900);
  }
  state = await groupState(sw.webSocketDebuggerUrl);
  check('no groups remain', state.groups.length === 0, JSON.stringify(state.groups));
  const tabA = state.tabs.find((t) => t.url.endsWith('/a'));
  check('source tab survives ungrouped', tabA && tabA.groupId === -1, JSON.stringify(tabA));

  await browser.close();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
} catch (err) {
  console.error('test run error:', err);
  failures++;
} finally {
  chromeProc.kill('SIGKILL');
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
