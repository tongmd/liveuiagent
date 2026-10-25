import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

test('native sheet contains long titles, badges and editable fields without clipping', async t => {
  let chrome;
  for (const candidate of [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (!candidate) continue;
    try { await fs.access(candidate); chrome = candidate; break; } catch {}
  }
  if (!chrome) return t.skip('Chrome unavailable; native sheet layout unexecuted');
  const html = await fs.readFile(new URL('../frontend/snapshot/index.html', import.meta.url), 'utf8');
  // Match the product cascade: runtime stylesheet precedes the inline snapshot styles.
  const css = await fs.readFile(new URL('../frontend/snapshot/runtime-controls.css', import.meta.url), 'utf8') + '\n' + [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const browser = await puppeteer.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage();
    for (const width of [1440, 390]) {
      await page.setViewport({width, height: 1000});
      await page.setContent(`<style>${css}</style><main class="concept-material studio-shell"><section class="app-sheet"><header>Reading</header><div class="a2ui-host"><section class="a2ui-card"><div class="a2ui-column"><section class="a2ui-statblock"><span>Books saved</span><strong>3 titles</strong></section><div class="a2ui-list"><section class="a2ui-card"><div class="a2ui-column"><div class="a2ui-row"><span class="a2ui-text title">Tomorrow, and Tomorrow, and Tomorrow</span><span class="a2ui-badge">A deliberately long shelf description</span></div><span class="a2ui-text body">${'Unbroken'.repeat(40)}</span></div></section></div><div class="a2ui-row"><label class="a2ui-field"><span>Book title</span><input class="a2ui-input" value="Tomorrow, and Tomorrow, and Tomorrow"></label><label class="a2ui-field"><span>Where spotted</span><input class="a2ui-input" value="A long editable description"></label></div></div></section></div></section></main>`);
      const metrics = await page.$eval('.app-sheet', sheet => {
        const host = sheet.querySelector('.a2ui-host');
        const bounds = sheet.getBoundingClientRect();
        const overflow = [...host.querySelectorAll('*')].filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && (r.left < bounds.left - 1 || r.right > bounds.right + 1);
        }).map(e => e.className);
        const texts = [...host.querySelectorAll('.a2ui-text,.a2ui-badge')].map(e => ({text: e.textContent, client: e.clientWidth, scroll: e.scrollWidth, whiteSpace: getComputedStyle(e).whiteSpace, overflow: getComputedStyle(e).overflow}));
        return {overflow, texts, client: host.clientWidth, scroll: host.scrollWidth};
      });
      assert.deepEqual(metrics.overflow, [], `all component bounds fit at ${width}px`);
      assert.ok(metrics.scroll <= metrics.client + 1, `sheet has no horizontal scroll at ${width}px`);
      for (const text of metrics.texts) {
        assert.notEqual(text.whiteSpace, 'nowrap', 'useful title, body and badge wrap');
        assert.ok(text.scroll <= text.client + 1, 'text is laid out within its available width');
        assert.notEqual(text.overflow, 'hidden', 'do not hide overflowing useful content');
      }
      await page.locator('input').filter(e => e.closest('label')?.textContent.includes('Book title')).fill('Edited full title');
      assert.equal(await page.$eval('input', e => e.value), 'Edited full title');
    }
  } finally { await browser.close(); }
});
