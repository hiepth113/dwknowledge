import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const START = process.env.START_URL || 'https://knowledgecenter.docuware.com/';
const ORIGIN = new URL(START).origin;
const OUT_DIR = path.resolve('./pdf-out');
const URLS_JSON = path.resolve('./urls.json');

const SCOPE_PREFIX = process.env.SCOPE_PREFIX || '/docs/';
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const PAUSE_MS = Number(process.env.PAUSE_MS || 800);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function sanitizeFileName(s){
  return (s || 'page').toLowerCase()
    .replace(/[^a-z0-9\-_. ]+/g,'-').replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,180);
}

async function collectAllDocUrls(browser){
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const q = [START];
  const visited = new Set();
  const docUrls = new Set();

  while(q.length){
    const url = q.shift();
    if(visited.has(url)) continue;
    visited.add(url);

    try{
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 });

      const links = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')).filter(Boolean));
      for(const href of links){
        try{
          const abs = new URL(href, url).toString();
          if(!abs.startsWith(ORIGIN)) continue;

          const u = new URL(abs);
          u.hash = ''; u.search = '';

          if(u.pathname.startsWith(SCOPE_PREFIX)) docUrls.add(u.toString());

          // tiếp tục duyệt để lộ thêm link (giới hạn: cùng origin)
          if(!visited.has(u.toString()) && !u.pathname.endsWith('.pdf')){
            q.push(u.toString());
          }
        }catch{}
      }
    }catch(err){
      console.warn('WARN open:', url, err?.message);
    }
  }

  await ctx.close();
  return Array.from(docUrls).sort();
}

async function exportOne(browser, url){
  const ctx = await browser.newContext({ colorScheme: 'light', javaScriptEnabled: true });
  const page = await ctx.newPage();

  try{
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    // gọn PDF: bỏ header/nav (tuỳ site), mở rộng vùng nội dung
    await page.addStyleTag({ content: `
      header, nav, .sidebar, .toc, .footer, [class*="Header"], [class*="Nav"], [class*="Sidebar"], [class*="Footer"] { display: none !important; }
      main, article, [data-docs], [class*="Content"] { width: 100% !important; max-width: 100% !important; }
      body { margin: 0 !important; }
    `});
    await page.emulateMedia({ media: 'print' }); // bố cục dạng in

    const title = await page.title().catch(()=> 'docuware-article');
    const slug = sanitizeFileName(title);

    const u = new URL(url);
    const dir = path.join(OUT_DIR, u.pathname.replace(/^\/+|\/+$/g,'').replace(/\//g,'_'));
    await fs.mkdir(dir, { recursive: true });

    const pdfPath = path.join(dir, `${slug}.pdf`);

    await page.pdf({
      path: pdfPath,
      printBackground: true,
      format: 'A4',
      margin: { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:9px;width:100%;text-align:right;padding-right:8px;color:#666;">${u.pathname}</div>`,
      footerTemplate: `<div style="font-size:9px;width:100%;padding:0 8px;color:#666;display:flex;justify-content:space-between;">
        <span class="date"></span><span>Page <span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
    });

    console.log('PDF ✓', pdfPath);
  }catch(err){
    console.error('PDF ✗', url, err?.message);
  }finally{
    await ctx.close();
  }
}

async function main(){
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // 1) Crawl hoặc dùng cache
  let urls;
  try{
    const raw = await fs.readFile(URLS_JSON, 'utf8');
    urls = JSON.parse(raw);
    console.log(`Loaded ${urls.length} URLs from urls.json`);
  }catch{
    console.log('Collecting /docs/ URLs from site ...');
    urls = await collectAllDocUrls(browser);
    console.log(`Found ${urls.length} docs URLs`);
    await fs.writeFile(URLS_JSON, JSON.stringify(urls, null, 2), 'utf8');
  }

  // 2) In PDF theo lô
  const queue = urls.slice();
  const workers = Array.from({length: CONCURRENCY}, async ()=>{
    while(queue.length){
      const url = queue.shift();
      await exportOne(browser, url);
      await sleep(PAUSE_MS);
    }
  });

  await Promise.all(workers);
  await browser.close();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
