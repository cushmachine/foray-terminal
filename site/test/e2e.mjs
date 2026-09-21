#!/usr/bin/env node
/**
 * End-to-end checks for the foray-terminal.com worker, run against the real
 * workerd runtime via `wrangler dev --local`.
 *
 *     cd site && node test/e2e.mjs
 *
 * Two passes:
 *
 *   1. Against a fixture upstream on localhost, so every way GitHub can fail
 *      (404, an HTML page with a 200, an empty file, a body with no shebang,
 *      a transfer cut off mid-stream, a dead connection) can be provoked and
 *      the response checked. The one property under test: nothing but the
 *      real installer ever comes back with a 200.
 *   2. Against the real raw.githubusercontent.com URL, so the happy path is
 *      exercised for real. Needs network; skipped with --no-network.
 *
 * The failure cases run before the success case on purpose: a validated
 * script is cached for 5 minutes, and a cache hit would mask them.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DEV_PORT = 8788;
// Wiped before every pass, so each one starts on a cold cache. Inside site/,
// where .gitignore already covers .wrangler/.
const PERSIST_DIR = new URL('../.wrangler/state-e2e', import.meta.url).pathname;
const NETWORK = !process.argv.includes('--no-network');
// The browser pass is opt-in: it is the only thing here that needs
// Playwright and a Chromium. Everything else runs on node alone.
const BROWSER = process.argv.includes('--browser');

const REAL_SCRIPT = '#!/usr/bin/env bash\n# fixture installer\necho "installed"\n';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A raw HTTP request, so Host, method and path are all ours to set. */
function request(path, { method = 'GET', host = 'foray-terminal.com' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: DEV_PORT, path, method, headers: { host } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // `raw` is kept as well as `body`: the hero image is binary, and
          // decoding it as utf8 would not survive a round trip.
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buf.toString('utf8'),
            bytes: buf.length,
            raw: buf,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/* ---------------------------------------------------------------- fixture */

let mode = 'ok';
let upstreamHits = 0;

const fixture = http.createServer((req, res) => {
  if (req.url.startsWith('/__mode/')) {
    mode = req.url.slice('/__mode/'.length);
    upstreamHits = 0;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mode=' + mode);
    return;
  }
  if (req.url === '/__hits') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(String(upstreamHits));
    return;
  }
  upstreamHits++;
  switch (mode) {
    case 'notfound':
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404: Not Found');
      return;
    case 'ratelimited':
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('rate limited');
      return;
    case 'html200':
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>Something went wrong</body></html>');
      return;
    case 'html200_plaintype':
      // The nastiest case: an HTML error page served as text/plain with a 200.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('<!DOCTYPE html>\n<html><body>500 oops</body></html>');
      return;
    case 'empty':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('');
      return;
    case 'noshebang':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('rm -rf /  # not our script, no shebang\n');
      return;
    case 'truncated':
      // Promise more than we send, then kill the socket mid-body.
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': String(REAL_SCRIPT.length + 5000),
      });
      res.write(REAL_SCRIPT.slice(0, 20));
      setTimeout(() => res.socket.destroy(), 50);
      return;
    case 'dead':
      req.socket.destroy();
      return;
    case 'hang':
      // Accept the connection and never answer: the worker's own timeout is
      // what has to end this.
      return;
    default:
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(REAL_SCRIPT);
  }
});

function fixturePort() {
  return fixture.address().port;
}

async function setMode(name) {
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: fixturePort(), path: '/__mode/' + name },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------ dev server */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True while something is listening on the dev port. */
async function portBusy() {
  try {
    await request('/__ping');
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` against a fresh `wrangler dev --local`, on a cold cache.
 * `hostname` is the host the worker sees in request.url (local-upstream).
 */
async function withWorker({ hostname = 'foray-terminal.com', vars = [] }, run) {
  rmSync(PERSIST_DIR, { recursive: true, force: true });
  for (let i = 0; i < 20 && (await portBusy()); i++) await sleep(500);

  const args = [
    '--no-install', 'wrangler', 'dev', '--local',
    '--ip', '127.0.0.1',
    '--port', String(DEV_PORT),
    '--local-upstream', hostname,
    '--persist-to', PERSIST_DIR,
    '--log-level', 'error',
    ...vars.flatMap((v) => ['--var', v]),
  ];
  // Detached so the whole process group (npx -> wrangler -> workerd) can be
  // killed; otherwise the old runtime keeps the port and the next pass
  // silently talks to it.
  const child = spawn('npx', args, {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(1000);
      try {
        // Any answer means it is listening (/ is a 301 on the www host).
        up = (await request('/')).status > 0;
      } catch {
        /* not listening yet */
      }
    }
    if (!up) {
      failures++;
      console.log('  FAIL wrangler dev never came up. Log:\n' + log);
      return;
    }
    await run();
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    for (let i = 0; i < 30 && (await portBusy()); i++) await sleep(500);
  }
}

/* ------------------------------------------------------------- the tests */

async function routingChecks() {
  console.log('\nrouting');
  const home = await request('/');
  check('GET / is 200 HTML', home.status === 200 && /^text\/html/.test(home.headers['content-type']), `${home.status} ${home.headers['content-type']}`);
  check('GET / carries the exact tagline', home.body.includes('Start vibecoding on your laptop. Keep going on your phone.'));
  check('GET / has no external subresource', !/(src|href)="https?:\/\/(?!github\.com|tailscale\.com|brew\.sh)/.test(home.body.replace(/<a [^>]*>/g, '')));
  check('GET / sets a CSP', typeof home.headers['content-security-policy'] === 'string');

  const headHome = await request('/', { method: 'HEAD' });
  check('HEAD / is 200 with no body', headHome.status === 200 && headHome.bytes === 0, `${headHome.status}, ${headHome.bytes} bytes`);

  const missing = await request('/nope');
  check('GET /nope is 404 text/plain', missing.status === 404 && /^text\/plain/.test(missing.headers['content-type']), `${missing.status} ${missing.headers['content-type']}`);

  const headMissing = await request('/nope', { method: 'HEAD' });
  check('HEAD /nope is 404 with no body', headMissing.status === 404 && headMissing.bytes === 0);

  const posted = await request('/install.sh', { method: 'POST' });
  check('POST /install.sh is 405 with Allow', posted.status === 405 && posted.headers.allow === 'GET, HEAD', `${posted.status} allow=${posted.headers.allow}`);

  const postedMissing = await request('/nope', { method: 'POST' });
  check('POST /nope is 404, not 405', postedMissing.status === 404, String(postedMissing.status));
}

/**
 * The screenshot routes: the right bytes, the right type, cached hard. Both
 * images answer to the same contract, so they are checked by the same loop —
 * a third screenshot inherits every one of these checks by joining the list.
 */
async function screenshotChecks() {
  console.log('\nscreenshots');
  const sha = (b) => createHash('sha256').update(b).digest('hex');

  for (const name of ['hero.webp', 'phone.webp']) {
    const file = readFileSync(new URL(`../src/${name}`, import.meta.url));

    const res = await request(`/${name}`);
    check(`GET /${name} is 200`, res.status === 200, String(res.status));
    check(`/${name} content-type is image/webp`, res.headers['content-type'] === 'image/webp', res.headers['content-type']);
    check(
      `the body is src/${name}, byte for byte`,
      res.bytes === file.length && sha(res.raw) === sha(file),
      `${res.bytes} bytes served vs ${file.length} on disk`,
    );

    const cache = res.headers['cache-control'] || '';
    const maxAge = Number((cache.match(/(?:^|[\s,])max-age=(\d+)/) || [])[1] || 0);
    check(`/${name} cache-control is immutable and long-lived`, cache.includes('immutable') && maxAge >= 2592000, cache);

    const head = await request(`/${name}`, { method: 'HEAD' });
    check(`HEAD /${name} is 200 with no body`, head.status === 200 && head.bytes === 0, `${head.status}, ${head.bytes} bytes`);

    const posted = await request(`/${name}`, { method: 'POST' });
    check(`POST /${name} is 405 with Allow`, posted.status === 405 && posted.headers.allow === 'GET, HEAD', `${posted.status} allow=${posted.headers.allow}`);
  }

  // The CSP had to widen by one source to let those images load, and by one
  // only: both are same-origin, so 'self' covers the pair.
  const csp = (await request('/')).headers['content-security-policy'] || '';
  check('GET / sets a CSP that allows same-origin images', csp.includes("img-src 'self' data:"), csp);
  check('GET / still blocks everything else by default', csp.includes("default-src 'none'"), csp);
}

/** Runs against a worker whose hostname is www.foray-terminal.com. */
async function wwwChecks() {
  console.log('\nwww -> apex');
  const script = await request('/install.sh');
  check('www /install.sh is a 301 to the apex, path kept', script.status === 301 && script.headers.location === 'https://foray-terminal.com/install.sh', `${script.status} ${script.headers.location}`);
  const home = await request('/');
  check('www / is a 301 to the apex', home.status === 301 && home.headers.location === 'https://foray-terminal.com/', `${home.status} ${home.headers.location}`);
  check('the redirect fetched nothing upstream', upstreamHits === 0, String(upstreamHits));
}

async function failureChecks() {
  console.log('\nupstream failures (nothing here may be a 200)');
  const cases = [
    ['notfound', 'GitHub 404'],
    ['ratelimited', 'GitHub 429'],
    ['html200', 'HTML page with a 200 and text/html'],
    ['html200_plaintype', 'HTML page with a 200 and text/plain'],
    ['empty', 'empty 200'],
    ['noshebang', '200 with no shebang'],
    ['truncated', 'transfer cut off mid-body'],
    ['dead', 'connection dropped'],
  ];
  for (const [name, label] of cases) {
    await setMode(name);
    const res = await request('/install.sh');
    check(`${label} -> 502`, res.status === 502, `got ${res.status}`);
    check(`${label} -> text/plain`, /^text\/plain/.test(res.headers['content-type'] || ''), res.headers['content-type']);
    check(`${label} -> body is inert in a shell`, isInertInShell(res.body), JSON.stringify(res.body.slice(0, 120)));
    check(`${label} -> not cached`, (res.headers['cache-control'] || '').includes('no-store'), res.headers['cache-control']);

    const head = await request('/install.sh', { method: 'HEAD' });
    check(`${label} -> HEAD also 502, empty`, head.status === 502 && head.bytes === 0, `${head.status}, ${head.bytes} bytes`);
  }

  // A GitHub that accepts the connection and never answers must not hold the
  // caller open; the worker's 10s timeout ends it.
  await setMode('hang');
  const started = Date.now();
  const hung = await request('/install.sh');
  const seconds = (Date.now() - started) / 1000;
  check('upstream that hangs -> 502', hung.status === 502, `got ${hung.status}`);
  check('upstream that hangs -> gives up inside 20s', seconds < 20, `${seconds.toFixed(1)}s`);
  check('upstream that hangs -> body is inert in a shell', isInertInShell(hung.body));
}

/**
 * Every line is a comment except a final `exit 1`: if a caller drops `curl -f`
 * and pipes this into bash anyway, bash runs no command and exits non-zero.
 */
function isInertInShell(body) {
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;
  const last = lines.pop();
  return lines.every((l) => l.startsWith('#')) && last === 'exit 1';
}

async function successChecks() {
  console.log('\nhappy path (fixture upstream)');
  await setMode('ok');
  const res = await request('/install.sh');
  check('GET /install.sh is 200', res.status === 200, String(res.status));
  check('content-type is text/x-shellscript', (res.headers['content-type'] || '').startsWith('text/x-shellscript'), res.headers['content-type']);
  check('content-type is never text/html', !/html/i.test(res.headers['content-type'] || ''));
  check('body is the whole script, byte for byte', res.body === REAL_SCRIPT, JSON.stringify(res.body.slice(0, 80)));
  check('cache-control has the 300s edge TTL', (res.headers['cache-control'] || '').includes('s-maxage=300'), res.headers['cache-control']);
  check('nosniff is set', res.headers['x-content-type-options'] === 'nosniff');

  const head = await request('/install.sh', { method: 'HEAD' });
  check('HEAD /install.sh is 200, no body, same content-type', head.status === 200 && head.bytes === 0 && (head.headers['content-type'] || '').startsWith('text/x-shellscript'), `${head.status}, ${head.bytes} bytes, ${head.headers['content-type']}`);

  // A second GET should be served from the edge cache, not from upstream.
  const before = upstreamHits;
  const again = await request('/install.sh');
  check('second GET still serves the script', again.status === 200 && again.body === REAL_SCRIPT);
  check('second GET did not hit upstream (cached)', upstreamHits === before, `upstream hits went ${before} -> ${upstreamHits}`);
}

async function realGitHubChecks() {
  console.log('\nhappy path (real raw.githubusercontent.com)');
  const res = await request('/install.sh');
  check('GET /install.sh is 200', res.status === 200, String(res.status));
  check('it is the real installer', res.body.startsWith('#!/usr/bin/env bash') && res.body.includes('Foray installer'), JSON.stringify(res.body.slice(0, 60)));
  check('content-type is text/x-shellscript', (res.headers['content-type'] || '').startsWith('text/x-shellscript'), res.headers['content-type']);
  check('body is more than 10 KB (whole file)', res.bytes > 10000, `${res.bytes} bytes`);
}

/**
 * The landing page, read off disk: no JavaScript, nothing fetched from
 * anywhere, and the copy that has to be exact is exact.
 */
/**
 * The copy buttons, in a real browser, behind the real CSP header.
 *
 * Opt-in with --browser: it needs Playwright and a Chromium, which nothing
 * else here does. It is the only pass that can see the two failures a header
 * cannot show on its own — Chromium refusing the script over a stale hash
 * (silent, bar one console line, and the buttons simply never appear), and a
 * button that copies something other than what the block shows.
 */
async function browserChecks() {
  console.log('\nlanding page (real browser, real CSP)');
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('  skip playwright is not installed; run with it to check the buttons');
    return;
  }
  const BASE = `http://127.0.0.1:${DEV_PORT}`;
  const COMMANDS = [
    'curl -fsSL https://foray-terminal.com/install.sh | bash',
    'Install Foray on this box. Instructions at foray-terminal.com/install.sh',
  ];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await context.newPage();
    const noise = [];
    page.on('console', (m) => noise.push(m.text()));
    page.on('pageerror', (e) => noise.push(`pageerror: ${e}`));
    await page.goto(BASE + '/', { waitUntil: 'load' });

    // The script ran: the buttons it reveals are on screen.
    const buttons = page.locator('button.copy');
    check('the two copy buttons are visible once the script has run', (await buttons.count()) === 2 && (await buttons.nth(0).isVisible()) && (await buttons.nth(1).isVisible()), `${await buttons.count()} buttons`);
    const violations = noise.filter((t) => /content security policy|refused to (execute|load)/i.test(t));
    check('the browser reported no CSP violation', violations.length === 0, violations.join(' | '));
    check('the page logged nothing at all', noise.length === 0, noise.join(' | '));

    for (let i = 0; i < COMMANDS.length; i++) {
      await page.evaluate(() => navigator.clipboard.writeText('not copied yet'));
      await buttons.nth(i).click();
      const pasted = await page.evaluate(() => navigator.clipboard.readText());
      check(`button ${i + 1} puts the command on the clipboard, exactly`, pasted === COMMANDS[i], JSON.stringify(pasted));
      const said = page.locator('.said').nth(i);
      check(`button ${i + 1} says Copied`, (await said.textContent()) === 'Copied' && (await buttons.nth(i).evaluate((b) => b.classList.contains('done'))));
      await sleep(2400);
      check(`button ${i + 1} reverts after about two seconds`, (await said.textContent()) === '' && !(await buttons.nth(i).evaluate((b) => b.classList.contains('done'))));
    }

    // A copy that fails must never look like one that worked. Two ways it
    // fails: the promise rejects (no permission), or navigator.clipboard is
    // not there at all (an insecure context), which throws where it stands.
    for (const [label, stub] of [
      ['a refused clipboard', () => ({ writeText: () => Promise.reject(new Error('denied')) })],
      ['a missing clipboard', () => undefined],
    ]) {
      const broken = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const bp = await broken.newPage();
      await bp.addInitScript(`Object.defineProperty(navigator, 'clipboard', { get: ${stub} })`);
      await bp.goto(BASE + '/', { waitUntil: 'load' });
      await bp.locator('button.copy').first().click();
      check(`${label} falls back to selecting the command`, (await bp.evaluate(() => getSelection().toString().trim())) === COMMANDS[0], JSON.stringify(await bp.evaluate(() => getSelection().toString())));
      check(`${label} shows no Copied state`, (await bp.locator('.said').first().textContent()) === '' && !(await bp.locator('button.copy').first().evaluate((b) => b.classList.contains('done'))));
      await broken.close();
    }

    // Layout: no overlap of a button with its command, no sideways scroll.
    for (const width of [360, 1280]) {
      for (const colorScheme of ['light', 'dark']) {
        const c = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
        const p2 = await c.newPage();
        await p2.goto(BASE + '/', { waitUntil: 'load' });
        const geometry = await p2.evaluate(() => {
          const worst = [];
          for (const pre of document.querySelectorAll('pre')) {
            const b = pre.querySelector('button.copy').getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(pre.querySelector('code'));
            let over = 0;
            for (const r of range.getClientRects()) {
              const dx = Math.min(b.right, r.right) - Math.max(b.left, r.left);
              const dy = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
              if (dx > 0 && dy > 0) over = Math.max(over, dx);
            }
            worst.push(Math.round(over));
          }
          const d = document.documentElement;
          return { worst, scroll: d.scrollWidth - d.clientWidth };
        });
        check(`${width}px ${colorScheme}: no button overlaps its command`, geometry.worst.every((o) => o <= 0), `overlap ${geometry.worst.join(', ')}px`);
        check(`${width}px ${colorScheme}: the page does not scroll sideways`, geometry.scroll <= 0, `${geometry.scroll}px over`);
        await c.close();
      }
    }

    // What a visitor with JavaScript off gets: no button, and a click on the
    // block still selects the whole command, as it did before there was one.
    const off = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
    const dead = await off.newPage();
    await dead.goto(BASE + '/', { waitUntil: 'load' });
    check('with JavaScript off, no copy button is visible', !(await dead.locator('button.copy').first().isVisible()));
    await off.close();

    // Same page, script refused instead of absent — which is what a stale CSP
    // hash would do. Page script is dead; Playwright's own evaluation is not,
    // so the selection can still be read back.
    const stale = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const sp = await stale.newPage();
    await sp.route(BASE + '/', async (route) => {
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), 'content-security-policy': "default-src 'none'; script-src 'sha256-stale'; style-src 'unsafe-inline'; img-src 'self' data:" },
      });
    });
    await sp.goto(BASE + '/', { waitUntil: 'load' });
    check('a stale hash leaves no button on the page', !(await sp.locator('button.copy').first().isVisible()));
    check('with no script, the block is still one selection', await sp.evaluate(() => getComputedStyle(document.querySelector('pre')).webkitUserSelect === 'all'));
    await sp.locator('pre code').first().click();
    const selected = await sp.evaluate(() => getSelection().toString().trim());
    check('with no script, a click on the block still selects the whole command', selected === COMMANDS[0], JSON.stringify(selected));
    await stale.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

/**
 * The landing page's one inline script, and the CSP that lets it run.
 *
 * script-src is a single sha256 over the exact bytes of that script, so the
 * two are welded together: edit the script without recomputing the hash in
 * src/index.js, or edit the hash without the script, and the browser refuses
 * to run it — the copy buttons simply never appear, and nothing says so but
 * one console message. This check recomputes the hash from landing.html and
 * compares it with the header the worker really served, so neither side can
 * move alone. Mutate either one and "the CSP hash is the sha256 of the inline
 * script" below goes red.
 */
async function scriptPolicyChecks() {
  console.log('\nlanding page (inline script + CSP)');
  const home = await request('/');
  const csp = home.headers['content-security-policy'] || '';
  const scriptSrc = (csp.match(/(?:^|;)\s*script-src\s+([^;]*)/) || [, ''])[1].trim();

  check('the served CSP has a script-src', scriptSrc !== '', csp);
  check(
    'script-src is one sha256 hash and nothing else',
    /^'sha256-[A-Za-z0-9+/]{43}='$/.test(scriptSrc),
    scriptSrc,
  );
  check(
    'script-src allows no unsafe-inline, no unsafe-eval, no host source',
    scriptSrc !== '' && !/unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic|[*]|https?:|data:|blob:|'self'/i.test(scriptSrc),
    scriptSrc,
  );
  check("default-src is still 'none'", /default-src 'none'/.test(csp), csp);
  const UNCHANGED = [
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
  check(
    'every other directive is exactly as it was',
    UNCHANGED.every((d) => csp.includes(d)),
    csp,
  );

  // The coupling itself: hash the real bytes of the script element's text
  // content, base64, and compare with what the worker sent.
  const html = readFileSync(new URL('../src/landing.html', import.meta.url), 'utf8');
  const inline = (html.match(/<script>([\s\S]*?)<\/script>/) || [, null])[1];
  const computed =
    inline === null ? null : `'sha256-${createHash('sha256').update(inline, 'utf8').digest('base64')}'`;
  check(
    'the CSP hash is the sha256 of the inline script',
    computed !== null && scriptSrc === computed,
    `served ${scriptSrc || '(none)'}, computed ${computed || '(no inline script found)'}`,
  );
  check(
    'the page the worker serves carries that same script, byte for byte',
    inline !== null && home.body.includes(`<script>${inline}</script>`),
  );

  // Before the script runs, there is nothing to press.
  const servedButtons = [...home.body.matchAll(/<button\b[^>]*>/gi)].map((m) => m[0]);
  check(
    'the copy buttons are hidden in the HTML the worker serves',
    servedButtons.length === 2 && servedButtons.every((b) => /\shidden[\s>]/.test(b)),
    servedButtons.join(' '),
  );
}

/** One rule's body from the stylesheet, by exact selector. '' when absent. */
function cssRule(css, selector) {
  const at = css.indexOf(`\n  ${selector} {`);
  return at === -1 ? '' : css.slice(at, css.indexOf('}', at) + 1);
}

function landingPageChecks() {
  console.log('\nlanding page (static)');
  const html = readFileSync(new URL('../src/landing.html', import.meta.url), 'utf8');
  const body = html.slice(html.indexOf('<body'));
  // Prose here wraps across source lines, so copy checks run against a
  // whitespace-collapsed copy: a check must not depend on where a line breaks.
  const flat = html.replace(/\s+/g, ' ');
  const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  // Everything that could pull in a resource: src=, and href= outside <a>.
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const resourceHrefs = hrefs.filter((h) => !links.includes(h));
  const srcs = [...html.matchAll(/\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const srcsets = [...html.matchAll(/\bsrcset="([^"]+)"/g)].map((m) => m[1]);
  // Everything an <img>/<source> could pull in, whichever attribute names it.
  const imageRefs = [...srcs, ...srcsets];
  // The page with every comment gone — HTML and CSS both — so a check about
  // what the page *does* is never satisfied or tripped by prose about it: the
  // comments here name the very tags these checks look for.
  const code = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const codeBody = code.slice(code.indexOf('<body'));

  // This read "no <script> anywhere" until the copy buttons arrived. The page
  // has exactly one script now and it is inline, hashed into the CSP; the
  // check is narrowed rather than dropped, so a second script, an external
  // one, or an attribute that would load or defer anything still fails.
  const scriptAttrs = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
  const scriptCloses = (html.match(/<\/script>/gi) || []).length;
  check('there is exactly one <script>', scriptAttrs.length === 1 && scriptCloses === 1, `${scriptAttrs.length} open, ${scriptCloses} close`);
  check(
    'the one <script> is inline: no src, no attributes at all',
    scriptAttrs.length === 1 && scriptAttrs[0] === '' && !/<script[^>]*\bsrc=/i.test(html),
    `<script${scriptAttrs[0] || ''}>`,
  );
  const inlineScript = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];
  check('the inline script has a body', inlineScript.trim().length > 0, `${inlineScript.length} chars`);
  // It is the page's only script and the hash in the CSP is over its exact
  // bytes, so it stays first-party and offline: no network, no storage.
  check(
    'the script calls nothing out, and stores nothing',
    !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|import\s*\(|new Worker/.test(inlineScript),
  );
  check('no inline event handlers', !/\son[a-z]+\s*=\s*"/i.test(body));
  // The page's subresources are the two screenshots and nothing else, each
  // root-relative and same-origin. This used to read "no src= at all", then
  // "the only src= is the hero image"; it is narrowed rather than dropped,
  // because its job is to stop a third-party resource creeping onto the page.
  check(
    'the only images are the two screenshots',
    imageRefs.length === 2 && new Set(imageRefs).size === 2 &&
      imageRefs.includes('/hero.webp') && imageRefs.includes('/phone.webp'),
    imageRefs.join(', '),
  );
  check(
    'no src= or srcset= names a scheme or another origin',
    imageRefs.length > 0 &&
      imageRefs.every((v) => v.startsWith('/') && !v.includes('//') && !/^[a-z][a-z0-9+.-]*:/i.test(v)),
    imageRefs.join(', '),
  );
  // One <picture>: the phone shot on a narrow viewport, the desktop shot
  // otherwise and as the fallback. Both carry their intrinsic size — the
  // aspect ratios are 1.69:1 and 0.48:1, so a missing one is a page that
  // jumps. The <source> needs its media query too, or it matches everything.
  const sourceTag = (codeBody.match(/<source\b[^>]*>/) || [''])[0];
  check('the phone screenshot is a <source> in a <picture>', /<picture>/.test(codeBody) && /\bsrcset="\/phone\.webp"/.test(sourceTag), sourceTag);
  check(
    'the <source> declares media, srcset, width and height',
    /\bmedia="[^"]+"/.test(sourceTag) && /\bsrcset="[^"]+"/.test(sourceTag) &&
      /\bwidth="\d+"/.test(sourceTag) && /\bheight="\d+"/.test(sourceTag),
    sourceTag,
  );
  // The fallback <img> is the desktop shot, unchanged: every browser that
  // matches no <source>, and every one that has never heard of <picture>,
  // lands here.
  const heroTag = (codeBody.match(/<img\b[^>]*src="\/hero\.webp"[^>]*>/) || [''])[0];
  check('the hero image is on the page', heroTag !== '');
  check('the hero image declares width and height', /\bwidth="\d+"/.test(heroTag) && /\bheight="\d+"/.test(heroTag), heroTag);
  check('the hero image has non-empty alt text', /\balt="[^"]+"/.test(heroTag), heroTag);
  check('the hero image sits in the hero, above the argument', codeBody.indexOf('<img') < codeBody.indexOf('There is a better way to vibecode.'));
  // The breakpoint is written twice — once in the <source>, once in the CSS
  // that shrinks --shot-w for the tall image — and the two must be the same
  // string. Drift and one screenshot gets the other's box: a 660px-wide phone
  // shot, or a desktop shot squeezed into 22rem.
  const sourceBreak = (sourceTag.match(/\bmedia="\(([^)]*)\)"/) || [])[1];
  const cssBreak = (code.match(/@media\s*\(([^)]*)\)\s*\{\s*\.shot\s*\{\s*--shot-w:/) || [])[1];
  check(
    'the <source> breakpoint and the --shot-w breakpoint are the same string',
    sourceBreak !== undefined && sourceBreak === cssBreak,
    `source "${sourceBreak}" vs css "${cssBreak}"`,
  );
  // <picture> is the whole point: the browser fetches only the source it
  // matched. Two <img> tags with one hidden would download both pictures on
  // every visit, phone included, which is the bug this shape avoids.
  const imgTags = codeBody.match(/<img\b/g) || [];
  check('there is exactly one <img> on the page', imgTags.length === 1, `${imgTags.length} <img> tags`);
  check('no image is hidden with display: none', !/display:\s*none/i.test(code), (code.match(/[^;{}]*display:\s*none[^;}]*/i) || []).join(''));

  check('no stylesheet or font link', !/rel="(stylesheet|preconnect|preload)"/i.test(html));
  check('the only non-link href is the data: favicon', resourceHrefs.every((h) => h.startsWith('data:image/svg+xml')), resourceHrefs.join(', '));
  check('no @import or url(http...) in the CSS', !/@import|url\(\s*['"]?https?:/i.test(html));
  // Same-page anchors (the hero's "Try it") go nowhere off the page. Every
  // other destination is named here one by one: the page does link to rivals
  // now, but only to the ones we shipped, and a new host has to be added
  // deliberately rather than slipping through a catch-all.
  const ALLOWED_HOSTS = [
    'github.com',
    'claude.ai',
    'code.claude.com',
    'termius.com',
    'blink.sh',
    'vibetunnel.sh',
    'ghostty.org',
    // The owner's own handle, linked from the byline under the intro.
    'x.com',
  ];
  const hostPattern = new RegExp(`^https://(${ALLOWED_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(/|$)`);
  const outbound = links.filter((h) => !h.startsWith('#'));
  check('every outbound link is on the named host list', outbound.every((h) => hostPattern.test(h)), outbound.filter((h) => !hostPattern.test(h)).join(', '));
  check('the hero lines are there', html.includes('Start vibecoding on your') && html.includes('Keep going on your'));
  check('the word spinners are matched pairs', (html.match(/class="roll"/g) || []).length === 2 && /12s/.test(html));
  check('the one-liner is the one from the README', html.includes('curl -fsSL https://foray-terminal.com/install.sh | bash'));
  check('nothing is piped into sh', !/\|\s*sh\b/.test(body.replace(/<code>\| bash<\/code>/g, '')));
  check('the licence is named', html.includes('AGPL-3.0'));
  // Every animation has to have a still frame for people who ask for one.
  check('@keyframes come with a reduced-motion escape', !/@keyframes/.test(html) || /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(html));
  // The alternatives are linked on purpose: the "Don't use Foray if" boxes
  // send people to the thing that actually fits them. A named rival with no
  // href is the bug now.
  const rivals = ['Happy', 'Termius', 'VibeTunnel', 'cmux', 'Ghostty'];
  const unlinked = rivals.filter((n) => !hrefs.some((h) => h.toLowerCase().includes(n.toLowerCase())));
  check('every named rival is linked', unlinked.length === 0, unlinked.join(', '));
  // Omnara was dropped from the comparison on purpose; it does not come back
  // by accident, in a link or in prose.
  check('Omnara is gone from the page', !/omnara/i.test(html));
  // The caption under the handoff animation is gone; nothing may bring it back.
  check('the old handoff caption is gone', !html.includes('One session. Any device.'));
  // The hero drawing was cut: the hero is the two spinner lines and the
  // button, and nothing may quietly put the laptop and phone back.
  check('the hero illustration is gone', !/class="illo/.test(html) && !html.includes('api-migration'));
  const deadAnimations = ['reshape', 'wide', 'narrow', 'drift'];
  const ghosts = deadAnimations.filter((n) => new RegExp(`@keyframes\\s+${n}\\b`).test(html));
  check('no keyframes left from the deleted device animation', ghosts.length === 0, ghosts.join(', '));
  // The argument for Foray is prose now, and it is about the reader rather
  // than about us: the old "The Foray way" heading does not come back.
  check('the section heading is there', html.includes('There is a better way to vibecode.'));
  check('the old "The Foray way" heading is gone', !html.includes('The Foray way'));
  check('the intro copy is there', flat.includes('So I created foray: a vibecoding server with a fast, ergonomic UI'));
  // The intro is deliberately five separate blocks: one wall-of-text paragraph
  // is the thing this replaced, and it must not quietly become one again. The
  // byline lives outside .intro, so it is never one of the five.
  const introBlock = flat.match(/<div class="intro">(.*?)<\/div>/);
  const introParagraphs = introBlock ? (introBlock[1].match(/<p>/g) || []).length : 0;
  check(
    'the intro is five separate paragraphs, not one block',
    introParagraphs === 5 && !/byline/.test(introBlock ? introBlock[1] : 'byline'),
    `${introParagraphs} paragraphs`,
  );
  // One person built this and the intro says so in his own voice. A "we" here
  // is a company that does not exist. Scoped to the intro: the rest of the page
  // is about the reader, and may say what it likes.
  const introText = (introBlock ? introBlock[1] : '').replace(/<[^>]*>/g, ' ');
  const plural = introText.match(/\b(we|our)\b/gi) || [];
  check('the intro speaks in the first person singular', introBlock !== null && plural.length === 0, plural.join(', '));
  // And it is signed. The name is a link to the owner's handle and the rest of
  // the line is plain text; the signature sits between the intro and the
  // diagrams, not adrift somewhere further down the page.
  const bylineTag = (codeBody.match(/<p class="byline">[\s\S]*?<\/p>/) || [''])[0];
  check('the intro is signed', /creator of Foray/.test(bylineTag), bylineTag);
  check(
    'the byline links Charles, and only Charles, to the owner\'s handle',
    /<a href="https:\/\/x\.com\/_wonderstorms">Charles<\/a>/.test(bylineTag) &&
      (bylineTag.match(/<a\b/g) || []).length === 1,
    bylineTag,
  );
  check(
    'the byline follows the intro and precedes the diagrams',
    bylineTag !== '' &&
      codeBody.indexOf('<div class="intro">') < codeBody.indexOf('<p class="byline">') &&
      codeBody.indexOf('<p class="byline">') < codeBody.indexOf('<div class="diagrams">'),
  );
  // The trailing dots on the "Don't use Foray if..." heading are the sentence:
  // each box below it finishes it. Three periods, as typed.
  check('the don\'t-use heading trails off', html.includes('Don&rsquo;t use Foray if...</h2>'));
  // Both diagrams end in the same three devices; everything above them is the
  // argument. On the left that is GitHub, spelled out.
  check('the diagram names GitHub', /class="box hub">GitHub</.test(body));
  check('no bare "git" label is left in a diagram', !/>git</.test(body));
  check('the old "Your computer" label is gone', !/>Your computer</.test(body));

  // The two diagrams, taken apart: each one runs from its own div down to the
  // list of marks under it. These are claims about what the drawings *are*, so
  // they are read off the comment-stripped copy — the prose above each diagram
  // describes the very tags being asserted here.
  const usual = codeBody.slice(codeBody.indexOf('<div class="dgram">'), codeBody.indexOf('<ul class="marks bad"'));
  const foray = codeBody.slice(codeBody.indexOf('<div class="dgram foray">'), codeBody.indexOf('<ul class="marks good"'));
  // Connectors are one source line each: a div of spans.
  const conns = (d) => d.match(/<div class="conn[^"]*">[^\n]*?<\/div>/g) || [];
  const heads = (c) => (c.match(/class="head\b/g) || []).length;
  check('both diagrams are on the page', usual.includes('GitHub') && foray.includes('foray'));
  check(
    'both diagrams end in the same three devices',
    (usual.match(/<div class="box dev">/g) || []).length === 3 &&
      (foray.match(/<div class="box dev">/g) || []).length === 3,
  );
  // The usual setup is push *and* pull, so every device connector carries a
  // head at each end. One head, pointing at GitHub, is what this replaced: it
  // drew the traffic as one-way, which is not the friction the bullets name.
  const usualConns = conns(usual);
  check(
    'the usual-setup device connectors are bidirectional',
    usualConns.length === 3 &&
      usualConns.every((c) => heads(c) === 2 && /class="head up"/.test(c) && /class="head down"/.test(c)),
    usualConns.join(' | '),
  );
  // The Foray diagram is three tiers: the machine in a box of its own, one
  // arrow down into Foray because Foray runs *on* it, and then plain lines.
  check(
    'the Foray diagram names the machine in a box of its own',
    /<div class="box host">Your local Mac or cloud VM<\/div>/.test(foray),
    foray.slice(0, 140),
  );
  check(
    'the machine is no longer a label wrapped round the Foray box',
    !/class="[^"]*\bunit\b/.test(code) && !/class="who"/.test(code),
  );
  const drop = conns(foray).filter((c) => /class="conn drop"/.test(c));
  check(
    'one directional arrow runs from the machine down into the Foray box',
    drop.length === 1 && heads(drop[0]) === 1 && /class="head down"/.test(drop[0]) &&
      foray.indexOf('class="box host"') < foray.indexOf('class="conn drop"') &&
      foray.indexOf('class="conn drop"') < foray.indexOf('class="box brand"'),
    drop.join(' | '),
  );
  // The devices are not pushing or pulling anything: they are simply joined to
  // the server, so those three connectors are lines and nothing else.
  const wires = conns(foray).filter((c) => !/class="conn drop"/.test(c));
  check(
    'the Foray diagram joins its devices with plain lines, no arrowheads',
    wires.length === 3 && wires.every((c) => /class="stem"/.test(c) && heads(c) === 0),
    wires.join(' | '),
  );
  check(
    'the Foray box still carries the lowercase wordmark and its chevron',
    /class="box brand"/.test(foray) && /class="wordmark mini"/.test(foray) &&
      /<svg class="mark"[\s\S]*?<\/svg>foray/.test(foray),
  );

  // Colour is the whole contrast between the pair: the usual setup in the
  // neutral ink, the Foray way in one green system — the lines, the arrow and
  // the device boxes. Both are custom properties, so both colour schemes get
  // their own value and neither is hard-coded here.
  const css = code.slice(code.indexOf('<style>'), code.indexOf('</style>'));
  check(
    'every connector takes its colour from the diagram it sits in',
    /\.stem\s*\{[^}]*border-left:[^;]*var\(--wire\)/.test(css) &&
      /\.head\.up\s*\{[^}]*border-bottom:[^;]*var\(--wire\)/.test(css) &&
      /\.head\.down\s*\{[^}]*border-top:[^;]*var\(--wire\)/.test(css),
  );
  check('the usual setup is wired in the neutral ink', /\.dgram\s*\{\s*--wire:\s*var\(--line-strong\)/.test(css));
  check('the Foray diagram is wired in the accent', /\.dgram\.foray\s*\{\s*--wire:\s*var\(--accent\)/.test(css));
  check(
    'the Foray diagram\'s device boxes take the accent border',
    /\.dgram\.foray\s+\.dev\s*\{[^}]*border-color:\s*var\(--accent\)/.test(css),
  );
  // Nothing else in the diagrams may pick the accent up: every rule that wires
  // or borders with it is scoped to the Foray diagram or to the branded box
  // inside it, and the usual-setup markup carries neither class.
  const accentSelectors = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => /(--wire|border-color):\s*var\(--accent\)/.test(m[2]))
    .map((m) => m[1].trim().replace(/\s+/g, ' '));
  check(
    'the accent reaches the Foray diagram and nothing beside it',
    accentSelectors.length >= 3 && accentSelectors.every((s) => /^\.dgram\.foray\b|^\.brand\b/.test(s)),
    accentSelectors.join(' | '),
  );
  check(
    'the usual-setup diagram carries neither the Foray nor the brand class',
    usual.startsWith('<div class="dgram">') && !/foray|brand|accent/.test(usual),
  );
  check(
    'the accent has a value in both colour schemes',
    /:root\s*\{[\s\S]*?--accent:\s*#[0-9a-f]{6}/i.test(css) &&
      /prefers-color-scheme:\s*dark[\s\S]*?--accent:\s*#[0-9a-f]{6}/i.test(css),
  );
  // The Foray diagram gained a tier, so it is taller — and the two lists under
  // the diagrams still have to start on the same line. The sections' three
  // rows are the grid's own rows, so the diagram row is measured from the
  // taller drawing and the shorter one bottom-aligns inside it: its slack
  // falls above the GitHub box rather than as a hole under it.
  check(
    'the two diagrams share their rows, so the lists start level',
    /\.diagrams\s*>\s*section\s*\{[^}]*grid-template-rows:\s*subgrid[^}]*grid-row:\s*span 3/.test(css) &&
      /\.dgram\s*\{[^}]*justify-content:\s*flex-end/.test(css),
  );
  // Subgrid is how it is measured; a browser without it still gets a floor to
  // reserve, and the floor is the Foray diagram's own measured height.
  check(
    'a browser without subgrid still reserves the taller diagram',
    /@supports not \(grid-template-rows: subgrid\)\s*\{\s*\.dgram\s*\{[^}]*min-height:/.test(css),
  );
  // The copy glyph used to be an affordance and nothing more, so no <button>
  // and no pointer cursor were allowed anywhere. Both checks are narrowed to
  // the two controls that now really do something, so nothing else on the
  // page may look clickable and then fail to be.
  const buttonTags = [...codeBody.matchAll(/<button\b[^>]*>/gi)].map((m) => m[0]);
  check(
    'the only buttons on the page are the two copy buttons',
    buttonTags.length === 2 && buttonTags.every((t) => /\bclass="copy"/.test(t)),
    buttonTags.join(' '),
  );
  check(
    'each copy button is type="button" and carries a label',
    buttonTags.length === 2 &&
      buttonTags.every((t) => /\btype="button"/.test(t) && /\baria-label="[^"]+"/.test(t)),
    buttonTags.join(' '),
  );
  // Hidden in the markup, revealed by the script: with script blocked there is
  // no button to press, and a click on the block still selects the command.
  check(
    'the copy buttons ship hidden, and the script is what reveals them',
    buttonTags.length === 2 && buttonTags.every((t) => /\shidden[\s>]/.test(t)) &&
      /\bhidden\s*=\s*false/.test(inlineScript),
    buttonTags.join(' '),
  );
  check(
    'the block still selects whole on a click, script or no script',
    /pre\s*\{[^}]*user-select:\s*all/.test(css) && !/pointer-events:\s*none/.test(cssRule(css, '.copy')),
    cssRule(css, '.copy'),
  );
  // A pointer cursor is allowed on exactly one selector: the copy button.
  const pointerSelectors = [...css.matchAll(/([^{}]*)\{[^{}]*cursor:\s*pointer[^{}]*\}/g)]
    .map((m) => m[1].trim().split('\n').pop().trim());
  check(
    'a pointer cursor appears only on the copy buttons',
    pointerSelectors.length === 1 && pointerSelectors[0] === '.copy',
    pointerSelectors.join(' | ') || 'nothing declares one',
  );
  check('no inline cursor: pointer outside the stylesheet', !/cursor:\s*pointer/i.test(codeBody));
  check('the install block says how to copy it', /<pre[^>]*title="Click to select, then copy"/.test(body));
  // What the buttons copy is the block's own text — the script reads the
  // <code> element and holds no command string of its own — and the two
  // blocks show exactly these two commands. So there is nothing to drift.
  const INSTALL_COMMANDS = [
    'curl -fsSL https://foray-terminal.com/install.sh | bash',
    'Install Foray on this box. Instructions at foray-terminal.com/install.sh',
  ];
  const preBlocks = [...codeBody.matchAll(/<pre\b[^>]*>[\s\S]*?<\/pre>/g)].map((m) => m[0]);
  const shownCommands = preBlocks.map((p) => (p.match(/<code>([\s\S]*?)<\/code>/) || [, ''])[1]);
  check(
    'the two blocks show exactly the two commands',
    shownCommands.length === 2 && shownCommands[0] === INSTALL_COMMANDS[0] &&
      shownCommands[1] === INSTALL_COMMANDS[1],
    shownCommands.join(' | '),
  );
  check(
    'every block that shows a command also has a copy button',
    preBlocks.length === 2 && preBlocks.every((p) => /<button\b[^>]*class="copy"/.test(p)),
    `${preBlocks.length} blocks`,
  );
  check(
    'the script copies the block\'s own text, not a second copy of the command',
    /code\.textContent/.test(inlineScript) &&
      !INSTALL_COMMANDS.some((c) => inlineScript.includes(c)) &&
      !/curl |install\.sh/.test(inlineScript),
  );
  // The copied state is announced, not just drawn: a glyph that changes colour
  // says nothing to a screen reader.
  check(
    'the copied state lands in a polite live region',
    (codeBody.match(/aria-live="polite"/g) || []).length === 2 &&
      /role="status"/.test(codeBody) && /said\.textContent = 'Copied'/.test(inlineScript),
  );
  check(
    'the copied state reverts on a timer, and only on a real copy',
    /setTimeout\(/.test(inlineScript) && /2000\)/.test(inlineScript) &&
      /\.then\(copied, select\)/.test(inlineScript),
  );
  // Features is a plain list between Install and the don't-use boxes: one bold
  // lead phrase per line, no boxes, no icons, no grid.
  check('the Features heading is there', /<h2>Features<\/h2>/.test(body));
  const FEATURE_LEADS = [
    'Sessions that outlive the tab.',
    'Dictate instead of typing.',
    'Keys a phone keyboard lacks.',
    'Past Claude Code sessions in the sidebar.',
    'A file tree and Markdown editor.',
    'Images from camera roll, clipboard or drag.',
    'Add to Home Screen.',
  ];
  const missingLeads = FEATURE_LEADS.filter((f) => !flat.includes(`<b>${f}</b>`));
  check('every feature lead phrase is there', missingLeads.length === 0, missingLeads.join(' | '));
  check(
    'Features sits between Install and the don\'t-use boxes',
    body.indexOf('<h2 id="install">') < body.indexOf('<h2>Features</h2>') &&
      body.indexOf('<h2>Features</h2>') < body.indexOf('Don&rsquo;t use Foray if'),
  );
  check('the repo is linked', links.includes('https://github.com/cushmachine/foray-terminal'));
  check('install.sh is linked for reading', links.includes('https://github.com/cushmachine/foray-terminal/blob/main/install.sh'));
  check('SECURITY.md is linked', links.includes('https://github.com/cushmachine/foray-terminal/blob/main/SECURITY.md'));
  check('it has a lang, a title and a viewport', /<html lang="en">/.test(html) && /<title>/.test(html) && /name="viewport"/.test(html));
  check('it is dark-mode aware', html.includes('prefers-color-scheme: dark'));
  for (const tag of ['html', 'head', 'body', 'main', 'header', 'style', 'footer']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    check(`<${tag}> is balanced`, open === close && open > 0, `${open} open, ${close} close`);
  }
}

/* -------------------------------------------------------------- the run */

landingPageChecks();

await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
console.log(`\nfixture upstream on 127.0.0.1:${fixturePort()}`);

const fixtureVar = () => [`INSTALL_UPSTREAM_URL:http://127.0.0.1:${fixturePort()}/install.sh`];

try {
  // Failures first: a validated script is cached for 5 minutes, and a cache
  // hit would hide every one of them.
  await withWorker({ vars: fixtureVar() }, async () => {
    await failureChecks();
    await successChecks();
    await routingChecks();
    await screenshotChecks();
    await scriptPolicyChecks();
    if (BROWSER) await browserChecks();
    else console.log('\nskipping the browser pass (pass --browser to run it)');
  });

  await withWorker({ hostname: 'www.foray-terminal.com', vars: fixtureVar() }, async () => {
    await setMode('ok');
    await wwwChecks();
  });

  if (NETWORK) {
    await withWorker({}, realGitHubChecks);
  } else {
    console.log('\nskipping the real-GitHub pass (--no-network)');
  }
} finally {
  fixture.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
