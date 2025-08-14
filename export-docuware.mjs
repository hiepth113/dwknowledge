// export-docuware.mjs
// Crawl DocuWare Knowledge Center (/docs/*) và in từng trang ra PDF

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// ======= Cấu hình qua ENV (đã có sẵn trong docker-compose.yml) =======
const START = process.env.START_URL || 'https://knowledgecenter.docuware.com/docs/';
const SCOPE_PREFIX = process.env.SCOPE_PREFIX || '/docs/';

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
const PAUSE_MS    = Math.max(0, Number(process.env.PAUSE_MS || 800));

const OUT_DIR   = path.resolve('./pdf-out');
const URLS_JSON = path.resolve('./urls.json');

// ======= Timeout, retry, selector =======
const NAV_TIMEOUT  = 60_000;
const IDLE_TIMEOUT = 30_000;
const SEL_TIMEOUT  = 20_000;
const MAX_RETRIES  = 3;

// ======= Helpers =======
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function sanitizeFileName(s){
  return (s || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9\-_. ]+/g,'-')
    .replace(/\s+/g,'-')
    .replace(/-+/g,'-')
    .slice(0,180);
}

function toAbs(href, base){
  try { return new URL(href, base).toString(); } catch { return null; }
}

function stripQueryHash(u){
  const x = new URL(u); x.hash=''; x.search=''; return x.toString();
}

function seeds(origin){
  // vài seed để “bắt nhịp” các mục lớn trong /docs/
  return Array.from(new Set([
    START,
    new URL('/docs/get-started', origin).toString(),
    new URL('/docs/mail-services', origin).toString(),
    new URL('/docs/white-paper-integration', origin).toString(),
  ]));
}

// ======= Thu link trong /docs/ =======
async function collectAllDocUrls(browser, origin){
  const ctx  = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', // override UA  [oai_citation:5‡playwright.dev](https://playwright.dev/docs/emulation?utm_source=chatgpt.com) [oai_citation:6‡zenrows.com](https://www.zenrows.com/blog/playwright-user-agent?utm_source=chatgpt.com)
    viewport: { width: 1366, height: 768 },
    locale: 'en-US'
  });
  const page = await ctx.newPage();

  const q = seeds(origin);
  const visited = new Set();
  const docUrls = new Set();

  console.log(`Collecting ${SCOPE_PREFIX} URLs from site ...`);

  while(q.length){
    const url = q.shift();
    if(visited.has(url)) continue;
    visited.add(url);

    try{
      console.log('[goto] ->', url);
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      console.log('[goto] OK', url);

      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch(()=>{}); //  [oai_citation:7‡BrowserStack](https://www.browserstack.com/guide/playwright-waitforloadstate?utm_source=chatgpt.com)
      console.log('[idle] OK', url);

      // chờ anchor /docs/ hoặc vùng nội dung xuất hiện (SPA)
      await page.waitForSelector(`a[href*="${SCOPE_PREFIX}"], main, article, [data-docs]`, { timeout: SEL_TIMEOUT }).catch(()=>{});

      // chụp ảnh debug để kiểm tra trang có render
      const dbg = path.join(OUT_DIR, `debug-${Buffer.from(url).toString('base64').slice(0,16)}.png`);
      await page.screenshot({ path: dbg, fullPage: true });

      const links = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')).filter(Boolean));
      for(const href of links){
        const abs0 = toAbs(href, url);
        if(!abs0 || !abs0.startsWith(origin)) continue;

        const abs = stripQueryHash(abs0);
        const u = new URL(abs);

        if(u.pathname.startsWith(SCOPE_PREFIX)){
          if(!docUrls.has(abs)) docUrls.add(abs);
          if(!visited.has(abs)) q.push(abs);
        }
      }

      console.log(`[collect] visited=${visited.size} docs=${docUrls.size} @ ${url}`);
    }catch(e){
      console.warn('[collect] WARN', url, e?.message);
    }
  }

  await ctx.close();
  const list = Array.from(docUrls).sort();
  console.log(`Found ${list.length} docs URLs`);
  return list;
}

// ======= In PDF một URL =======
async function exportOne(browser, url, attempt=1){
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US'
  });
  const page = await ctx.newPage();

  try{
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch(()=>{}); //  [oai_citation:8‡BrowserStack](https://www.browserstack.com/guide/playwright-waitforloadstate?utm_source=chatgpt.com)
    await page.waitForSelector('main, article, [data-docs], a[href*="/docs/"]', { timeout: SEL_TIMEOUT }).catch(()=>{});

    // Ẩn header/nav/sidebar khi in, phóng to vùng nội dung
    await page.addStyleTag({ content: `
      header, nav, .sidebar, .toc, .footer,
      [class*="Header"], [class*="Nav"], [class*="Sidebar"], [class*="Footer"] { display:none !important; }
      main, article, [data-docs], [class*="Content"] { width:100% !important; max-width:100% !important; }
      body { margin:0 !important; }
    `});

    // In theo media "print"
    await page.emulateMedia({ media: 'print' });

    // Đường dẫn/tên file
    const title = await page.title().catch(()=> 'docuware-article');
    const slug  = sanitizeFileName(title);
    const u     = new URL(url);
    const dir   = path.join(OUT_DIR, u.pathname.replace(/^\/+|\/+$/g,'').replace(/\//g,'_'));
    await fs.mkdir(dir, { recursive: true });

    const pdfPath = path.join(dir, `${slug}.pdf`);

    // Xuất PDF (Chromium headless)  [oai_citation:9‡rubydoc.info](https://www.rubydoc.info/gems/playwright-ruby-client/0.3.0/Playwright%2FPage%3Apdf?utm_source=chatgpt.com)
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      format: 'A4',
      margin: { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:9px;width:100%;text-align:right;padding-right:8px;color:#666;">${u.pathname}</div>`,
      footerTemplate: `<div style="font-size:9px;width:100%;padding:0 8px;color:#666;display:flex;justify-content:space-between;">
        <span class="date"></span>
        <span>Page <span class="pageNumber"></span>/<span class="totalPages"></span></span>
      </div>`
    });

    console.log('PDF ✓', pdfPath);
  }catch(e){
    console.error(`PDF ✗ [${attempt}/${MAX_RETRIES}]`, url, e?.message);
    if(attempt < MAX_RETRIES){
      await ctx.close();
      await sleep(1000);
      return exportOne(browser, url, attempt+1);
    }
  }finally{
    await ctx.close();
  }
}

// ======= main =======
async function main(){
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Ẩn flag automation một phần bằng args (giảm bị chặn)  [oai_citation:10‡zenrows.com](https://www.zenrows.com/blog/disable-blink-features-automationcontrolled?utm_source=chatgpt.com) [oai_citation:11‡scrapeops.io](https://scrapeops.io/playwright-web-scraping-playbook/nodejs-playwright-make-playwright-undetectable/?utm_source=chatgpt.com)
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const origin = new URL(START).origin;

  let urls;
  try{
    const raw = await fs.readFile(URLS_JSON, 'utf8');
    urls = JSON.parse(raw);
    console.log(`Loaded ${urls.length} URLs from cache.`);
  }catch{
    urls = await collectAllDocUrls(browser, origin);
    await fs.writeFile(URLS_JSON, JSON.stringify(urls, null, 2), 'utf8');
  }

  // chạy theo lô song song
  const queue = urls.slice();
  const workers = Array.from({length: CONCURRENCY}, async ()=>{
    while(queue.length){
      const url = queue.shift();
      await exportOne(browser, url);
      if (PAUSE_MS) await sleep(PAUSE_MS);
    }
  });
  await Promise.all(workers);

  await browser.close();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
