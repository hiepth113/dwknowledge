// export-docuware.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const START = process.env.START_URL || 'https://knowledgecenter.docuware.com/docs/';
const SCOPE_PREFIX = process.env.SCOPE_PREFIX || '/docs/';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
const PAUSE_MS = Math.max(0, Number(process.env.PAUSE_MS || 800));

const OUT_DIR = path.resolve('./pdf-out');
const URLS_JSON = path.resolve('./urls.json');

const NAV_TIMEOUT = 60000;
const IDLE_TIMEOUT = 30000;
const SEL_TIMEOUT = 20000;
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitizeFileName(s) {
  return (s || 'page').toLowerCase()
    .replace(/[^a-z0-9\-_. ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180);
}
function toAbs(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}
function stripQueryHash(u) {
  const x = new URL(u); x.hash = ''; x.search = ''; return x.toString();
}
function seeds(origin) {
  return Array.from(new Set([
    START,
    new URL('/docs/get-started', origin).toString(),
    new URL('/docs/mail-services', origin).toString(),
    new URL('/docs/white-paper-integration', origin).toString(),
  ]));
}

async function collectAllDocUrls(browser, origin) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  const q = seeds(origin);
  const visited = new Set();
  const docUrls = new Set();

  console.log(`Collecting ${SCOPE_PREFIX} URLs from site ...`);

  while (q.length) {
    const url = q.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      console.log('[goto] ->', url);
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      console.log('[goto] OK', url);

      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch(() => {});
      console.log('[idle] OK', url);

      await page.waitForSelector(`a[href*="${SCOPE_PREFIX}"], main, article, [data-docs]`, { timeout: SEL_TIMEOUT }).catch(() => {});

      const dbg = path.join(OUT_DIR, `debug-${Buffer.from(url).toString('base64').slice(0,16)}.png`);
      await page.screenshot({ path: dbg, fullPage: true });

      const links = await page.$$eval('a[href]', els => els.map(e => e.getAttribute('href')).filter(Boolean));
      for (const href of links) {
        const abs0 = toAbs(href, url);
        if (!abs0 || !abs0.startsWith(origin)) continue;
        const clean = stripQueryHash(abs0);
        const u = new URL(clean);
        if (u.pathname.startsWith(SCOPE_PREFIX)) {
          if (!docUrls.has(clean)) docUrls.add(clean);
          if (!visited.has(clean)) q.push(clean);
        }
      }

      console.log(`[collect] visited=${visited.size} docs=${docUrls.size} @ ${url}`);
    } catch (e) {
      console.warn('[collect] WARN', url, e.message);
    }
  }

  await ctx.close();
  const list = Array.from(docUrls).sort();
  console.log(`Found ${list.length} docs URLs`);
  return list;
}

async function exportOne(browser, url, attempt = 1) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch(() => {});
    await page.waitForSelector('main, article, [data-docs], a[href*="/docs/"]', { timeout: SEL_TIMEOUT }).catch(() => {});

    await page.addStyleTag({ content: `
      header, nav, .sidebar, .toc, .footer, [class*="Header"], [class*="Nav"], [class*="Sidebar"], [class*="Footer"] {
        display: none !important;
      }
      main, article, [data-docs], [class*="Content"] {
        width: 100% !important; max-width: 100% !important;
      }
      body { margin: 0 !important; }
    `});
    await page.emulateMedia({ media: 'print' });

    const title = await page.title().catch(() => 'docuware-article');
    const slug = sanitizeFileName(title);
    const u = new URL(url);
    const dir = path.join(OUT_DIR, u.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '_'));
    await fs.mkdir(dir, { recursive: true });

    const pdfPath = path.join(dir, `${slug}.pdf`);
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      format: 'A4',
      margin: { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:9px;width:100%;text-align:right;padding-right:8px;color:#666;">${u.pathname}</div>`,
      footerTemplate: `<div style="font-size:9px;width:100%;padding:0 8px;color:#666;display:flex;justify-content:space-between;"><span class="date"></span><span>Page <span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`
    });

    console.log('PDF ✓', pdfPath);
  } catch (e) {
    console.error(`PDF ✗ [${attempt}/${MAX_RETRIES}]`, url, e.message);
    if (attempt < MAX_RETRIES) {
      await ctx.close();
      await sleep(1000);
      return exportOne(browser, url, attempt + 1);
    }
  } finally {
    await ctx.close();
  }
}

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const origin = new URL(START).origin;

  let urls;
  try {
    const raw = await fs.readFile(URLS_JSON, 'utf8');
    urls = JSON.parse(raw);
    console.log(`Loaded ${urls.length} URLs from cache.`);
  } catch {
    urls = await collectAllDocUrls(browser, origin);
    await fs.writeFile(URLS_JSON, JSON.stringify(urls, null, 2), 'utf8');
  }

  const queue = urls.slice();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const url = queue.shift();
      await exportOne(browser, url);
      if (PAUSE_MS) await sleep(PAUSE_MS);
    }
  });

  await Promise.all(workers);
  await browser.close();
  console.log('Done.');
})();
