// Loads the studio in headless Chromium, checks the shader compiles and draws pixels,
// that options change the picture, that the embed snippet works on a bare page, and
// that reduced motion gives a still frame. With --shot it also writes docs/preview.png.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const check = (ok, msg) => { if (!ok) errors.push(`FAIL ${msg}`); else console.log(`ok  ${msg}`); };

// Counts opaque pixels and a checksum of the canvas, via a 2D copy.
const probe = (page, sel) => page.evaluate((s) => {
  const c = document.querySelector(s);
  const t = document.createElement('canvas');
  t.width = c.width; t.height = c.height;
  const x = t.getContext('2d');
  x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, t.width, t.height).data;
  let opaque = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 200) { opaque++; sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 1000003; } }
  return { opaque, sum, total: d.length / 4 };
}, sel);

const page = await browser.newPage({ viewport: { width: 1280, height: 1020 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(base);
await page.waitForFunction(() => window.__studio?.logo.hasLogo, null, { timeout: 20000 });
check(await page.evaluate(() => window.__studio.logo.supported), 'WebGL2 available and shader compiled');
const a = await probe(page, '#canvas');
check(a.opaque > a.total * 0.05 && a.opaque < a.total * 0.9, `logo drawn (${a.opaque} of ${a.total} pixels opaque)`);

await page.click('[data-preset="gold"]');
await page.waitForTimeout(150);
const b = await probe(page, '#canvas');
check(b.sum !== a.sum, 'switching preset changes the picture');
check((await page.textContent('#snippet')).includes('data-preset="gold"'), 'snippet follows the controls');

for (const s of ['peaks', 'wave']) {
  await page.click(`[data-sample="${s}"]`);
  await page.waitForTimeout(400);
  const p = await probe(page, '#canvas');
  check(p.opaque > p.total * 0.05, `sample ${s} renders`);
}

const box = await page.locator('#canvas').boundingBox();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
check(await page.evaluate(() => window.__studio.logo.ripples.length) > 0, 'pointer move creates ripples');

const png = await page.evaluate(async () => (await window.__studio.logo.toBlob('image/png')).size);
check(png > 1000, `PNG export produces ${png} bytes`);

// Embed on a bare page that uses only the snippet.
const bare = await browser.newPage({ viewport: { width: 600, height: 500 } });
bare.on('pageerror', (e) => errors.push(`embed pageerror: ${e.message}`));
await bare.route('**/embed-test.html', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><title>t</title><body style="background:#111"><script src="${base}/liquid-logo.js" defer></script>` +
    `<div data-liquid-logo data-src="${base}/samples/orbit.svg" data-preset="holographic" style="width:300px"></div></body>`,
}));
await bare.goto(`${base}/embed-test.html`);
await bare.waitForFunction(() => document.querySelector('[data-liquid-logo]')?.__liquidLogo?.hasLogo, null, { timeout: 20000 });
const e = await probe(bare, '[data-liquid-logo] canvas');
check(e.opaque > e.total * 0.05, 'embed snippet renders on a bare page');
await bare.close();

// Reduced motion: still frame, no animation loop.
const calm = await browser.newPage({ viewport: { width: 600, height: 500 }, reducedMotion: 'reduce' });
await calm.goto(base);
await calm.waitForFunction(() => window.__studio?.logo.hasLogo, null, { timeout: 20000 });
check(await calm.evaluate(() => window.__studio.logo.reduced && !window.__studio.logo.animating), 'reduced motion: no animation loop');
const r1 = await probe(calm, '#canvas');
await calm.waitForTimeout(500);
const r2 = await probe(calm, '#canvas');
check(r1.sum === r2.sum && r1.opaque > 0, 'reduced motion: frame stays still');
await calm.close();

// No WebGL2: the plain logo image is shown instead.
const plain = await browser.newPage({ viewport: { width: 600, height: 500 } });
await plain.addInitScript(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return type === 'webgl2' ? null : orig.call(this, type, ...rest); };
});
await plain.goto(base);
await plain.waitForFunction(() => window.__studio?.logo.fallbackImg, null, { timeout: 20000 });
check(await plain.evaluate(() => !window.__studio.logo.supported && !!document.querySelector('.stage img')), 'no WebGL2: plain logo image shown');
await plain.close();

if (process.argv.includes('--shot')) {
  await page.click('[data-preset="chrome"]');
  await page.click('[data-sample="orbit"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(root, 'docs', 'preview.png') });
  console.log('wrote docs/preview.png');
}

await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('browser checks passed');
