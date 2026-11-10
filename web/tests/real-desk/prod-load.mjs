import { chromium } from '@playwright/test';
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = []; let asset = null;
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); }); p.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));
p.on('response', (r) => { const m = r.url().match(/^https:\/\/office\.minimalistalliance\.com\/v\/([^/]+)\//); if (m) asset = m[1]; }); // signed out, it goes on to auth., which has its own assets
await p.goto('https://office.minimalistalliance.com/', { waitUntil: 'networkidle', timeout: 30000 });
const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160);
console.log(JSON.stringify({ bundle: asset, title: await p.title(), url: p.url().slice(0, 60), text, errs })); await b.close();
