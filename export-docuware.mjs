// export-docuware.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const START = process.env.START_URL || 'https://knowledgecenter.docuware.com/docs/';
const ORIGIN = new URL(START).origin;
const SCOPE_PREFIX = process.env.SCOPE_PREFIX || '/docs/';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
const PAUSE_MS = Math.max(0, Number(process.env.PAUSE_MS || 800));

const OUT_DIR = path.resolve('./pdf-out');
const URLS_JSON = path.resolve('./urls.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitizeFileName(s) {
  return (s || 'page').toLowerCase()
    .replace(/[^a-z0-9\-_. ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180);
}

function absUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

async function collectUrls(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const queue = [START];
  const visited = new Set();
  const docUrls = new Set();

  console.log('Start collecting /docs/ URLs...');
  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      await page.waitForSelector(`a[href*="${SCOPE_PREFIX}"]`, { timeout: 10000 }).catch(() => {});

      const links = await page.$$eval('a[href]', els => els.map(e => e.href));
      for (const href of links) {
        const abs = absUrl(href, url);
        if (!abs || !abs.startsWith(ORIGIN)) continue;

        const clean = abs.split('#')[0].split('?')[0];
        if (clean.startsWith(START) && !visited.has(clean)) {
          docUrls.add(clean);
          queue.push(clean);
        }
      }
      console.log(`Collecting... visited=${visited.size}, foundURLs=${docUrls.size}`);
    } catch (err) {
      console.warn('Error collecting:', url, err.message);
    }
  }

  await ctx.close();
  console.log(`Collected ${docUrls.size} URLs.`);
  return Array.from(docUrls).sort();
}

async function exportPdf(browser, url) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await page.waitForSelector('main, article, [data-docs]', { timeout: 10000 }).catch(() => {});

    await page.addStyleTag({
      content: `
        header, nav, .sidebar, .footer, .toc { display: none !important; }
        main, article, [data-docs] { width: 100% !important; max-width: 100% !important; }
        body { margin: 0 !important; }
      `
    });
    await page.emulateMedia({ media: 'print' });

    const title = await page.title().catch(() => 'article');
    const slug = sanitizeFileName(title);
    const outDir = path.join(OUT_DIR, new URL(url).pathname.replace(/\//g, '_'));
    await fs.mkdir(outDir, { recursive: true });

    const pdfPath = path.join(outDir, `${slug}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:9px; text-align:right;">${url}</div>`,
      footerTemplate: `<div style="font-size:9px; display:flex; justify-content:space-between;">
        <span class="date"></span><span>Page <span class="pageNumber"></span>/<span class="totalPages"></span></span>
      </div>`
    });
    console.log('PDF ✓', pdfPath);
  } catch (err) {
    console.error('PDF ✗', url, err.message);
  } finally {
    await ctx.close();
  }
}

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  let urls;
  try {
    const existing = await fs.readFile(URLS_JSON, 'utf8');
    urls = JSON.parse(existing);
    console.log(`Loaded ${urls.length} URLs from cache.`);
  } catch {
    urls = await collectUrls(browser);
    await fs.writeFile(URLS_JSON, JSON.stringify(urls, null, 2));
  }

  const queue = urls.slice();
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push((async () => {
      while (queue.length) {
        const url = queue.shift();
        await exportPdf(browser, url);
        await sleep(PAUSE_MS);
      }
    })());
  }
  await Promise.all(workers);

  await browser.close();
  console.log('All done.');
})();
