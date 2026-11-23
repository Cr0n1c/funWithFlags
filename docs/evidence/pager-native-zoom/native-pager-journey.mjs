#!/usr/bin/env node
// Single-process headed-Chromium journey: all browser, xdotool and screenshot
// actions stay inside this process. Zoom is changed only with Chromium's native
// page-zoom keyboard command; native menu snapshots are saved for evidence.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(resolve(import.meta.dirname,
  '../../../artifacts/fun-with-flags/package.json'));
const { chromium } = require('playwright');
const baseURL = process.argv[2];
if (!baseURL) throw new Error('Pass the preview base URL as the only argument.');
const out = resolve(import.meta.dirname);
await mkdir(out, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });
const screenshot = (name) => run('import', ['-window', 'root', resolve(out, name)]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const user = {
  account_id: '7', home: '/home/jane-doe-7', username: 'synthetic-user',
  email: 'synthetic@example.test', full_name: 'Synthetic User',
  first_name: 'Synthetic', last_name: 'User', department_parent: 'Test',
  department_leaf: 'Synthetic', level: 'L1', groups: [], is_admin: false,
  score: 0, solves: 0,
};
const challenges = Array.from({ length: 80 }, (_, i) => ({
  ticket: `ZOOM-${i + 1}`,
  summary: `Synthetic desktop pager row ${i + 1} ${'wide '.repeat(30)}RIGHT-EDGE`,
  points: 12345, url: `https://example.test/ZOOM-${i + 1}`,
}));
const apiPaths = [];
const commandPosts = [];
let browser;
let context;
let winId;
let baseWindow;
const report = {
  browser: '', osZoomEvidence: [], snapshots: [], journeys: [], failures: [], apiPaths,
};
function recordFailure(check, expected, actual) {
  report.failures.push({ check, expected, actual });
}

function measure() {
  return page.evaluate(() => ({
    innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio,
    rootFont: getComputedStyle(document.documentElement).fontSize,
    pagerFont: document.querySelector('.terminal-pager__content')
      ? getComputedStyle(document.querySelector('.terminal-pager__content')).fontSize : null,
  }));
}
let page;

async function osSize(width, height) {
  run('xdotool', ['windowsize', winId, String(width), String(height)]);
  await page.waitForFunction(
    ({ w, h }) => Math.abs(window.outerWidth - w) < 5 && Math.abs(window.outerHeight - h) < 5,
    { w: width, h: height }, { timeout: 5000 },
  ).catch(() => {});
  await delay(300);
}
async function nativeZoomIn(count, label) {
  for (let i = 0; i < count; i++) {
    run('xdotool', ['key', '--clearmodifiers', 'ctrl+plus']);
    await page.waitForFunction(
      (old) => devicePixelRatio > old,
      await page.evaluate(() => devicePixelRatio),
      { timeout: 3000 },
    ).catch(() => {});
    await delay(120);
  }
  await openNativeMenu(`${label}-zoom-menu.png`);
  const m = await measure();
  report.osZoomEvidence.push({ label, ...m });
  return m;
}
async function nativeReset100() {
  run('xdotool', ['key', '--clearmodifiers', 'ctrl+0']);
  await page.waitForFunction(() => Math.abs(devicePixelRatio - 1) < 0.05, null, { timeout: 5000 })
    .catch(() => {});
}
async function openNativeMenu(filename) {
  run('xdotool', ['key', '--clearmodifiers', 'alt+f']);
  await delay(350);
  screenshot(filename);
  report.snapshots.push(filename);
  run('xdotool', ['key', 'Escape']);
  await delay(200);
  run('xdotool', ['windowactivate', '--sync', winId]);
}
async function ready() {
  await page.locator('#terminal-input-wrapper').waitFor({ timeout: 45_000 });
  await page.waitForFunction(() => {
    const i = document.querySelector('#terminal-input');
    return i?.getAttribute('contenteditable') === 'true'
      && i?.getAttribute('data-command-busy') !== 'true';
  }, null, { timeout: 45_000 });
}
async function capabilitySnapshot(label) {
  const value = await page.evaluate(() => {
    const found = [];
    const stylesheets = [];
    const styleElements = [];
    let allCssText = '';
    const visit = (rules, media = []) => {
      for (const rule of rules) {
        if (rule.cssRules) {
          const next = rule.conditionText ? [...media, rule.conditionText] : media;
          visit(rule.cssRules, next);
        } else if (rule.selectorText) {
          const body = rule.style?.cssText || '';
          if (rule.selectorText.includes('.switch-mount')
              || rule.selectorText.includes('.degauss-mount')
              || rule.selectorText.includes('.terminal-pager')) {
            found.push({ selector: rule.selectorText, body, media });
          }
        }
      }
    };
    for (const sheet of document.styleSheets) {
      stylesheets.push(sheet.href ? new URL(sheet.href).pathname : '<inline>');
      try {
        const rules = sheet.cssRules;
        visit(rules);
        stylesheets[stylesheets.length - 1] += ` (${rules.length} top-level rules)`;
        allCssText += Array.from(rules, (rule) => rule.cssText).join('\n');
      } catch (e) {
        stylesheets[stylesheets.length - 1] += ` (cssRules error: ${e.name})`;
      }
    }
    for (const style of document.querySelectorAll('style')) {
      const text = style.textContent || '';
      allCssText += `\n${text}`;
      styleElements.push({
        id: style.id, type: style.type, length: text.length,
        hasHardwareSelectors: text.includes('.switch-mount') && text.includes('.degauss-mount'),
        hasHoverMedia: text.includes('(hover: hover)'),
        hasShortHeightMedia: text.includes('(max-height: 600px)'),
        hasHardwareVisibilityRule: /(?:\.switch-mount|\.degauss-mount)[^{]*\{[^}]*visibility\s*:\s*hidden/.test(text),
        hasFixedPagerRule: /terminal-pager[^{}]*\{[^}]*position\s*:\s*fixed/.test(text),
        matchingSourceExcerpt: (() => {
          const i = text.indexOf('.switch-mount');
          return i >= 0 ? text.slice(Math.max(0, i - 100), i + 360) : null;
        })(),
      });
    }
    const mounted = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return { visibility: s.visibility, display: s.display, position: s.position,
        zIndex: s.zIndex, rect: r.toJSON() };
    };
    return {
      media: {
        hover: matchMedia('(hover: hover)').matches,
        pointerFine: matchMedia('(pointer: fine)').matches,
        anyHover: matchMedia('(any-hover: hover)').matches,
        anyPointerFine: matchMedia('(any-pointer: fine)').matches,
      },
      maxTouchPoints: navigator.maxTouchPoints,
      stylesheets,
      styleElements,
      sourceRuleTokens: {
        hasHardwareSelectors: allCssText.includes('.switch-mount')
          && allCssText.includes('.degauss-mount'),
        hasHoverMedia: allCssText.includes('(hover: hover)'),
        hasShortHeightMedia: allCssText.includes('(max-height: 600px)'),
        hasVisibilityHidden: allCssText.includes('visibility: hidden'),
        hasFixedPager: allCssText.includes('position: fixed'),
      },
      loadedRules: found,
      hardware: {
        switchMount: mounted('.switch-mount'),
        degaussMount: mounted('.degauss-mount'),
      },
      pager: (() => {
        const el = document.querySelector('.terminal-pager:not(.terminal-pager--finished)');
        if (!el) return null;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return { position: s.position, inset: s.inset, zIndex: s.zIndex, rect: r.toJSON() };
      })(),
      shortDesktopRulePresent: styleElements.some((s) => s.hasHardwareSelectors
        && s.hasHoverMedia && s.hasShortHeightMedia && s.hasFixedPagerRule),
      hoverHardwareRulePresent: styleElements.some((s) => s.hasHardwareSelectors
        && s.hasHoverMedia && s.hasHardwareVisibilityRule),
    };
  });
  report.capabilities ??= {};
  report.capabilities[label] = value;
  return value;
}
async function runCommand(text, expected) {
  const input = page.locator('#terminal-input');
  const output = page.locator('#terminal-output');
  await page.waitForFunction(() => {
    const i = document.querySelector('#terminal-input');
    return i?.getAttribute('contenteditable') === 'true'
      && i?.getAttribute('data-command-busy') !== 'true';
  }, null, { timeout: 20_000 });
  const prior = Number(await input.getAttribute('data-command-completions') || 0);
  const children = await output.locator(':scope > *').count();
  await input.evaluate((el) => el.focus());
  await page.keyboard.insertText(text);
  if (await input.innerText() !== text) throw new Error(`Command input mismatch: ${text}`);
  await page.keyboard.press('Enter');
  if (text === 'challenges blue') {
    await page.locator('.terminal-pager__status').last().waitFor({ timeout: 20_000 });
  } else {
    await page.waitForFunction(
      ({ prior }) => Number(document.querySelector('#terminal-input')?.getAttribute(
        'data-command-completions') || 0) === prior + 1,
      { prior }, { timeout: 20_000 },
    );
    const added = await output.locator(':scope > *').count() - children;
    if (added !== 1) throw new Error(`Expected one output line for ${text}; got ${added}`);
    const textOut = await output.innerText();
    if (!textOut.includes(expected)) throw new Error(`Missing expected command output: ${expected}`);
  }
}
async function statusCheck(label) {
  const pager = page.locator('.terminal-pager').last();
  const status = pager.locator('.terminal-pager__status');
  const viewport = pager.locator('.terminal-pager__viewport');
  const content = pager.locator('.terminal-pager__content');
  const text = (await status.textContent()).replace(/\s+/g, ' ').trim();
  if (text !== '--More-- Enter: next row Space: next page Q/Esc: quit') {
    recordFailure(`${label}: status text`, '--More-- Enter: next row Space: next page Q/Esc: quit', text);
  }
  const exposure = await status.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const covered = [];
    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < (node.textContent?.length || 0); i++) {
        if (!node.textContent[i].trim()) continue;
        const r = document.createRange();
        r.setStart(node, i); r.setEnd(node, i + 1);
        for (const b of r.getClientRects()) {
          const x = b.left + b.width / 2, y = b.top + b.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (b.left < 0 || b.right > innerWidth || b.top < 0 || b.bottom > innerHeight
              || !el.contains(hit)) covered.push({
            glyph: node.textContent[i], rect: b.toJSON(),
            hit: hit?.className?.toString() || hit?.tagName || null,
          });
        }
      }
    }
    return { visible: covered.length === 0, covered };
  });
  const g = await viewport.evaluate((v) => {
    const c = v.querySelector('.terminal-pager__content');
    return {
      height: v.clientHeight, width: v.clientWidth, scrollWidth: v.scrollWidth,
      line: parseFloat(getComputedStyle(c).lineHeight),
      contentFont: getComputedStyle(c).fontSize,
      statusBox: v.parentElement.querySelector('.terminal-pager__status').getBoundingClientRect().toJSON(),
    };
  });
  if (!exposure.visible) recordFailure(`${label}: status glyph hit-test`,
    'all instruction glyphs onscreen and hit-testable', exposure.covered);
  if (g.height < g.line) recordFailure(`${label}: full row`,
    `viewport height >= line height ${g.line}`, g.height);
  const caps = await capabilitySnapshot(label);
  report.journeys.push({ label, text, exposure, ...g, capabilities: caps, ...(await measure()) });
  return { pager, status, viewport, content, g };
}
async function liveResize(label) {
  const geometry = await page.evaluate(() => ({
    width: window.outerWidth, height: window.outerHeight,
  }));
  const target = { width: geometry.width - 80, height: geometry.height - 60 };
  await osSize(target.width, target.height);
  const live = await measure();
  report.journeys.push({ label: `${label}-live-os-resize`, window: target, ...live });
  return () => osSize(baseWindow.width, baseWindow.height);
}
async function tableScroll(label, viewport, status) {
  const before = await status.boundingBox();
  const sw = await viewport.evaluate((el) => el.scrollWidth);
  const cw = await viewport.evaluate((el) => el.clientWidth);
  if (sw <= cw) recordFailure(`${label}: horizontal overflow`, 'scrollWidth > clientWidth', { sw, cw });
  await viewport.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  const right = await viewport.evaluate((el) => {
    const clip = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      for (const match of n.textContent.matchAll(/12345/g)) {
        const r = document.createRange(); r.setStart(n, match.index); r.setEnd(n, match.index + 5);
        const b = r.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
        if (y > clip.top && y < clip.bottom && b.left >= clip.left && b.right <= clip.right
            && el.contains(document.elementFromPoint(x, y))) return true;
      }
    }
    return false;
  });
  if (!right) recordFailure(`${label}: rightmost column`, '12345 fully visible at far right', right);
  const middle = await status.boundingBox();
  const atRight = await viewport.evaluate((el) => el.scrollLeft);
  await viewport.evaluate((el) => { el.scrollLeft = 0; });
  const atLeft = await viewport.evaluate((el) => el.scrollLeft);
  const after = await status.boundingBox();
  if (!before || !middle || !after || Math.abs(before.x - middle.x) > 1
      || Math.abs(before.y - middle.y) > 1 || Math.abs(before.x - after.x) > 1
      || Math.abs(before.y - after.y) > 1) recordFailure(`${label}: stationary status`,
    'status bounding box unchanged across horizontal scroll', { before, middle, after });
  report.journeys.push({
    label: `${label}: horizontal table scroll`, scrollWidth: sw, clientWidth: cw,
    rightScrollLeft: atRight, resetScrollLeft: atLeft, rightmost12345Visible: right,
    statusBefore: before, statusAtRight: middle, statusAfterReset: after,
  });
}
async function exitAndCommand(exit, label) {
  const input = page.locator('#terminal-input');
  const output = page.locator('#terminal-output');
  if (exit === 'end') {
    for (let i = 0; i < 100 && await page.locator('.terminal-pager__status').count(); i++) {
      await page.keyboard.press('Space');
    }
  } else {
    await page.keyboard.press(exit);
  }
  await page.waitForFunction(() => !document.querySelector('.terminal-pager__status'), null,
    { timeout: 20_000 });
  await page.waitForFunction(() => {
    const i = document.querySelector('#terminal-input');
    return i?.getAttribute('contenteditable') === 'true'
      && i?.getAttribute('data-command-busy') !== 'true';
  }, null, { timeout: 20_000 });
  const hardware = await page.getByRole('button', { name: 'Degauss', exact: true }).isVisible();
  if (await input.getAttribute('contenteditable') !== 'true' || !hardware) {
    recordFailure(`${label}: prompt/hardware restore`, 'editable prompt and visible Degauss', {
      contenteditable: await input.getAttribute('contenteditable'), hardware,
    });
  }
  if (!(await page.evaluate(() => document.activeElement === document.querySelector('#terminal-input')))) {
    recordFailure(`${label}: focus restore`, 'terminal input remains focused', false);
  }
  const text = `echo zoom-${exit.toLowerCase()} | tr a-z A-Z`;
  const prior = Number(await input.getAttribute('data-command-completions') || 0);
  const children = await output.locator(':scope > *').count();
  await page.keyboard.insertText(text); // deliberately no click/focus after exit
  if (await input.innerText() !== text) recordFailure(`${label}: immediate prompt input`, text, await input.innerText());
  const prefixVisible = await page.locator('#input-prefix').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth
      && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  const promptTextExposure = await input.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const hidden = [];
    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < (node.textContent?.length || 0); i++) {
        if (!node.textContent[i].trim()) continue;
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
        for (const rect of r.getClientRects()) {
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight
              || !el.contains(document.elementFromPoint(x, y))) hidden.push({
            glyph: node.textContent[i], rect: rect.toJSON(),
          });
        }
      }
    }
    return { visible: hidden.length === 0, hidden };
  });
  const prefixBox = await page.locator('#input-prefix').boundingBox();
  if (!prefixVisible) recordFailure(`${label}: prefix visibility`, 'visible and hit-testable', false);
  if (!promptTextExposure.visible) recordFailure(`${label}: typed prompt glyphs`,
    'all typed command glyphs onscreen and hit-testable', promptTextExposure.hidden);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    ({ prior }) => Number(document.querySelector('#terminal-input')?.getAttribute(
      'data-command-completions') || 0) === prior + 1,
    { prior }, { timeout: 20_000 },
  );
  const added = await output.locator(':scope > *').count() - children;
  const all = await output.innerText();
  if (added !== 1 || !all.includes(`ZOOM-${exit.toUpperCase()}`)) {
    recordFailure(`${label}: exactly-once command execution`, 1, { added, hasExpectedOutput: all.includes(`ZOOM-${exit.toUpperCase()}`) });
  }
  report.journeys.push({
    label: `${label}-exit-command`, input: text, prefixVisible, added, hardware,
    completionDelta: Number(await input.getAttribute('data-command-completions') || 0) - prior,
    outputTail: all.slice(-200), prefixBox, promptTextExposure,
  });
}
async function guarded(label, action) {
  try { return await action(); }
  catch (error) {
    recordFailure(label, 'operation completes', String(error?.message || error));
    return null;
  }
}
async function checkAdvance(scale, viewport, content, line) {
  const offset = () => content.evaluate((el) =>
    -new DOMMatrixReadOnly(getComputedStyle(el).transform).m42);
  const start = await offset();
  await page.keyboard.press('Enter');
  const afterEnter = await offset();
  const enterDelta = afterEnter - start;
  if (Math.abs(enterDelta - line) > 1) recordFailure(`${scale}: Enter advancement`,
    `${line}px (one row)`, enterDelta);
  await page.keyboard.press('Space');
  const afterSpace = await offset();
  const spaceDelta = afterSpace - afterEnter;
  // PageCursor advances pageRows, not viewport.clientHeight; update() sets
  // viewport.style.height to exactly pageRows * lineHeight.
  const expectedPageDelta = parseFloat(await viewport.evaluate((el) => el.style.height));
  report.journeys.push({ label: `${scale}: advancement`, lineHeight: line,
    enterDelta, spaceDelta, expectedPageDelta, rowsAdvanced: spaceDelta / line,
    viewportClientHeight: await viewport.evaluate((el) => el.clientHeight) });
  if (Math.abs(spaceDelta - expectedPageDelta) > 1) recordFailure(`${scale}: Space advancement`,
    `${expectedPageDelta}px = PageCursor.pageRows × ${line}px`, spaceDelta);
}

try {
  run('xrandr', ['--output', 'VNC-0', '--mode', '1920x1200']);
  browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1280,980', '--disable-background-networking'],
  });
  report.browser = `Chromium ${browser.version()}`;
  context = await browser.newContext({ viewport: null, serviceWorkers: 'block' });
  await context.route('**/api/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    apiPaths.push(`${req.method()} ${p}`);
    const json = (body, status = 200, headers = {}) => route.fulfill({
      status, contentType: 'application/json', headers, body: JSON.stringify(body),
    });
    if (p === '/api/auth/me') return json(user);
    if (p === '/api/auth/home-roster') return json({
      owner: { account_id: user.account_id, home: user.home }, entries: [{ home: user.home }],
    });
    if (p === '/api/challenges/blue') return json(challenges, 200, { 'X-Blue-Sync-State': 'ready' });
    if (p === '/api/challenges/notifications') return json({
      gold: [], red: [], gold_cursor: 0, red_cursor: 0, red_available: true,
      gold_more: false, red_more: false,
    });
    if (p === '/api/cli/commands') return json({ commands: [] });
    if (p === '/api/activity/command' && req.method() === 'POST') {
      try { commandPosts.push(req.postDataJSON().command); } catch {}
      return route.fulfill({ status: 204 });
    }
    return json({ detail: 'Synthetic offline fixture: no live API access' }, 404);
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  page = await context.newPage();
  page.on('pageerror', (e) => console.log(`PAGE_ERROR ${e.name}: ${e.message}`));
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const window = await page.evaluate(() => ({ outerWidth, outerHeight }));
  const handles = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'chromium-browser'],
    { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  if (!handles.length) throw new Error('No visible native Chromium window found in X11.');
  winId = handles.at(-1);
  run('xdotool', ['windowactivate', '--sync', winId]);
  await ready();
  // Set the actual outer window so the document content starts at exactly the
  // requested 1280×900 CSS viewport. This uses OS window resize, never
  // Playwright setViewportSize or injected CSS.
  let m = await measure();
  for (let i = 0; i < 3 && (m.innerWidth !== 1280 || m.innerHeight !== 900); i++) {
    const current = await page.evaluate(() => ({ outerWidth, outerHeight }));
    await osSize(current.outerWidth + 1280 - m.innerWidth,
      current.outerHeight + 900 - m.innerHeight);
    m = await measure();
  }
  if (m.innerWidth !== 1280 || m.innerHeight !== 900 || m.dpr !== 1) {
    throw new Error(`Could not establish 1280×900 CSS baseline at DPR 1: ${JSON.stringify(m)}`);
  }
  baseWindow = await page.evaluate(() => ({ width: outerWidth, height: outerHeight }));
  report.baseline = { ...m, outerWindow: baseWindow };
  await capabilitySnapshot('100%-baseline');
  screenshot('baseline-100.png');

  // First open pager at 100%, then apply actual browser zoom while it is live.
  await runCommand('challenges blue');
  await page.locator('.terminal-pager__status').last().waitFor();
  m = await nativeZoomIn(5, '200-percent');
  if (m.innerWidth !== 640 || m.innerHeight !== 450) {
    recordFailure('200% measured viewport', '640×450 CSS px', m);
  }
  screenshot('pager-200-open.png');
  let s = await statusCheck('200% open-at-zoom');
   const restore200 = await liveResize('200-percent');
   try { s = await statusCheck('200% during live OS resize'); }
   finally { await restore200(); }
  await checkAdvance('200%', s.viewport, s.content, s.g.line);
  await guarded('200% status after advancement', () => statusCheck('200% after Enter/Space'));
  await guarded('200% horizontal table scroll', () => tableScroll('200%', s.viewport, s.status));
  await guarded('200% Q and immediate command', () => exitAndCommand('q', '200%-Q'));
  await runCommand('challenges blue');
  s = await statusCheck('200% reopened for Escape');
  await guarded('200% Escape and immediate command', () => exitAndCommand('Escape', '200%-Escape'));
  await runCommand('challenges blue');
  s = await statusCheck('200% reopened for natural end');
  await guarded('200% natural completion and immediate command', () => exitAndCommand('end', '200%-natural-end'));

  // Reopen at native 200%, then change to native 400% while the pager is open.
  await runCommand('challenges blue');
  m = await nativeZoomIn(3, '400-percent');
  if (m.innerWidth !== 320 || m.innerHeight !== 225) {
    recordFailure('400% measured viewport', '320×225 CSS px', m);
  }
  screenshot('pager-400-open.png');
  s = await statusCheck('400% open-at-zoom');
   const restore400 = await liveResize('400-percent');
   try { s = await statusCheck('400% during live OS resize'); }
   finally { await restore400(); }
  await checkAdvance('400%', s.viewport, s.content, s.g.line);
  await guarded('400% status after advancement', () => statusCheck('400% after Enter/Space'));
  await guarded('400% horizontal table scroll', () => tableScroll('400%', s.viewport, s.status));
  await guarded('400% Q and immediate command', () => exitAndCommand('q', '400%-Q'));
  await runCommand('challenges blue');
  s = await statusCheck('400% reopened for Escape');
  await guarded('400% Escape and immediate command', () => exitAndCommand('Escape', '400%-Escape'));
  await runCommand('challenges blue');
  s = await statusCheck('400% reopened for natural end');
  await guarded('400% natural completion and immediate command', () => exitAndCommand('end', '400%-natural-end'));

  await nativeReset100();
  await osSize(baseWindow.width, baseWindow.height);
  report.reset100 = await measure();
  screenshot('ordinary-layout-100.png');
  if (report.reset100.innerWidth !== 1280 || report.reset100.innerHeight !== 900
      || report.reset100.dpr !== 1) recordFailure('reset 100% layout',
    '1280×900 CSS px at DPR 1', report.reset100);
  await capabilitySnapshot('100%-reset');
  report.unexpectedApi = apiPaths.filter((x) =>
    !/GET \/(api\/auth\/me|api\/auth\/home-roster|api\/challenges\/blue|api\/challenges\/notifications|api\/cli\/commands)$/
      .test(x) && !/POST \/api\/activity\/command$/.test(x));
  if (report.unexpectedApi.length) recordFailure('offline synthetic API boundary',
    'no unknown API paths', report.unexpectedApi);
  report.commandPostCount = commandPosts.length;
  report.commandPosts = commandPosts;
  report.textOnlyZoom = 'Not supported by Chromium page-zoom menu (menu exposes page zoom only).';
  report.completed = true;
} catch (error) {
  report.completed = false;
  report.error = String(error?.stack || error);
} finally {
  try { await writeFile(resolve(out, 'measurements.json'), `${JSON.stringify(report, null, 2)}\n`); }
  catch (error) { console.error(`Could not write measurements.json: ${error.message}`); }
  console.log(JSON.stringify(report, null, 2));
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  // Return the test host display to its initial size even if this journey fails.
  try { run('xrandr', ['--output', 'VNC-0', '--mode', '800x600']); } catch {}
}
if (!report.completed) process.exitCode = 1;
