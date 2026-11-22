const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../liquid-logo.js');

const root = path.resolve(__dirname, '..');

test('parseSvgSize reads width and height', () => {
  assert.deepStrictEqual(L.parseSvgSize('<svg xmlns="x" width="400" height="300"><path/></svg>'), { width: 400, height: 300 });
});

test('parseSvgSize falls back to viewBox', () => {
  assert.deepStrictEqual(L.parseSvgSize('<svg viewBox="0 0 24 12.5"></svg>'), { width: 24, height: 12.5 });
  assert.deepStrictEqual(L.parseSvgSize("<svg viewBox='0,0,10,10' width='100%'></svg>"), { width: 10, height: 10 });
});

test('parseSvgSize returns null when there is no usable size', () => {
  assert.strictEqual(L.parseSvgSize('<svg></svg>'), null);
  assert.strictEqual(L.parseSvgSize('not an svg'), null);
});

test('every sample logo has a size', () => {
  const files = fs.readdirSync(path.join(root, 'samples')).filter((f) => f.endsWith('.svg'));
  assert.strictEqual(files.length, 3);
  for (const f of files) assert.ok(L.parseSvgSize(fs.readFileSync(path.join(root, 'samples', f), 'utf8')), f);
});

test('maskDimensions keeps aspect and pads the edges', () => {
  const d = L.maskDimensions(400, 200);
  assert.strictEqual(d.width, d.innerW + 2 * d.pad);
  assert.ok(Math.abs(d.innerW / d.innerH - 2) < 0.02);
  assert.ok(d.width <= L.MASK_SIZE);
});

// A filled square inside a larger empty field.
function square(w, h, x0, y0, x1, y1) {
  const a = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 1;
  return a;
}

test('insideDistance is 0 outside and grows toward the middle', () => {
  const w = 40, h = 40;
  const d = L.insideDistance(square(w, h, 10, 10, 30, 30), w, h);
  assert.strictEqual(d[0], 0);
  assert.ok(d[20 * w + 10] < 1.5, 'edge pixel is near zero');
  assert.ok(Math.abs(d[20 * w + 20] - 9.5) < 1, 'centre is about half the width from the edge');
  assert.ok(d[20 * w + 20] > d[20 * w + 12]);
});

test('insideDistance matches brute force on a circle', () => {
  const w = 33, h = 33;
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = Math.hypot(x - 16, y - 16) < 12 ? 1 : 0;
  const d = L.insideDistance(a, w, h);
  for (const [x, y] of [[16, 16], [10, 16], [16, 8], [20, 22]]) {
    let best = Infinity;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (a[yy * w + xx] < 0.5) best = Math.min(best, Math.hypot(x - xx, y - yy));
    assert.ok(Math.abs(d[y * w + x] - (best - 0.5)) < 1e-4, `pixel ${x},${y}`);
  }
});

test('buildMask packs depth in R and coverage in G', () => {
  const w = 120, h = 120;
  const m = L.buildMask(square(w, h, 20, 20, 100, 100), w, h);
  assert.strictEqual(m.length, w * h * 4);
  const at = (x, y) => m.slice((y * w + x) * 4, (y * w + x) * 4 + 4);
  assert.deepStrictEqual(Array.from(at(2, 2)).slice(0, 2), [0, 0]);
  assert.strictEqual(at(60, 60)[1], 255);
  assert.ok(at(60, 60)[0] > at(24, 60)[0], 'deeper inside is higher');
  assert.ok(at(60, 60)[0] >= 200, 'centre is near full depth');
});

test('alphaFromRGBA and averageColor read pixels', () => {
  const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0]);
  assert.deepStrictEqual(Array.from(L.alphaFromRGBA(px)), [1, 1, 0]);
  assert.strictEqual(L.averageColor(px), '#800080');
  assert.strictEqual(L.averageColor(new Uint8ClampedArray([1, 2, 3, 0])), null);
});

test('clampOptions fills defaults and clamps bad input', () => {
  assert.deepStrictEqual(L.clampOptions({}), L.DEFAULTS);
  const o = L.clampOptions({ speed: 9, light: -5, refraction: 'abc', preset: 'nope', tint: 'blue' });
  assert.strictEqual(o.speed, 2);
  assert.strictEqual(o.light, 0);
  assert.strictEqual(o.refraction, L.DEFAULTS.refraction);
  assert.strictEqual(o.preset, 'chrome');
  assert.strictEqual(o.tint, L.DEFAULTS.tint);
});

test('presetStops gives five rgb stops for every preset', () => {
  for (const preset of Object.keys(L.PRESETS)) {
    const s = L.presetStops(L.clampOptions({ preset }));
    assert.strictEqual(s.length, 5);
    for (const c of s) assert.ok(c.length === 3 && c.every((v) => v >= 0 && v <= 1));
  }
  assert.deepStrictEqual(L.presetStops(L.clampOptions({ preset: 'tint', tint: '#ff0000' }))[2], [1, 0, 0]);
});

test('hexToRgb and rgbToHex round trip', () => {
  assert.strictEqual(L.rgbToHex(L.hexToRgb('#3b82f6')), '#3b82f6');
});

test('buildSnippet makes one script and one element', () => {
  const s = L.buildSnippet({ preset: 'gold', speed: 1.2 }, { scriptUrl: 'https://example.test/liquid-logo.js', src: '/logo.svg' });
  assert.strictEqual((s.match(/<script /g) || []).length, 1);
  assert.strictEqual((s.match(/<div /g) || []).length, 1);
  assert.ok(s.includes('src="https://example.test/liquid-logo.js"'));
  assert.ok(s.includes('data-src="/logo.svg"'));
  assert.ok(s.includes('data-preset="gold"'));
  assert.ok(!s.includes('data-tint'), 'tint is only written for the tint preset');
});

test('snippet attributes read back to the same options', () => {
  const opts = L.clampOptions({ preset: 'tint', tint: '#aa5500', speed: 1.1, refraction: 0.3, softness: 0.8, light: 200, bevel: 0.4 });
  const s = L.buildSnippet(opts);
  const ds = {};
  for (const [k, attr] of Object.entries(L.ATTRS)) {
    const m = new RegExp(`${attr}="([^"]*)"`).exec(s);
    if (m) ds[k] = m[1];
  }
  assert.deepStrictEqual(L.optionsFromDataset(ds), opts);
});

test('shader declares every uniform the renderer sets', () => {
  for (const n of ['uMask', 'uTexel', 'uAspect', 'uTime', 'uClock', 'uRefraction', 'uSoftness', 'uBevel', 'uLight', 'uIrid', 'uStops', 'uRip']) {
    assert.ok(new RegExp(`uniform [A-Za-z0-9]+ ${n}\\b`).test(L.FRAG), n);
  }
});

test('no em dashes anywhere in the repo', () => {
  const skip = new Set(['node_modules', '.git', 'docs']);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (skip.has(e.name)) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const dash = String.fromCharCode(0x2014);
  const bad = walk(root).filter((f) => !f.endsWith('package-lock.json') && fs.readFileSync(f, 'utf8').includes(dash));
  assert.deepStrictEqual(bad, []);
});
