/*
 * Liquid Logo Studio core. One file, no dependencies.
 * Browser: <script src="liquid-logo.js"></script> then any <div data-liquid-logo data-src="logo.svg">.
 * Node: require() it to reach the pure helpers (mask, distance field, snippet).
 * Shader, mask maths and effect are original work, MIT licensed.
 */
/* global module */
(function (root) {
  'use strict';

  const DEFAULTS = { preset: 'chrome', tint: '#3b82f6', speed: 0.6, refraction: 0.5, softness: 0.5, light: 35, bevel: 0.5 };
  const LIMITS = { speed: [0, 2], refraction: [0, 1], softness: [0, 1], light: [0, 360], bevel: [0.1, 1] };

  // Each preset is five colour stops, dark to light, plus how much rainbow film to mix in.
  const PRESETS = {
    chrome: { stops: ['#05070c', '#2c3a52', '#8fa2bd', '#e9f0fa', '#ffffff'], irid: 0 },
    gold: { stops: ['#120a02', '#5c3a0a', '#b7791f', '#f3c64e', '#fff6cf'], irid: 0 },
    holographic: { stops: ['#0b0b1e', '#4a3b8f', '#9ec8ff', '#f4d6ff', '#ffffff'], irid: 0.75 },
    tint: { stops: null, irid: 0 },
  };

  const MASK_SIZE = 512;
  const MASK_PAD = 0.1;
  const DEPTH_PX = 40;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function clampOptions(o) {
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k];
    }
    if (!PRESETS[out.preset]) out.preset = DEFAULTS.preset;
    if (!/^#[0-9a-f]{6}$/i.test(out.tint)) out.tint = DEFAULTS.tint;
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const n = Number(out[k]);
      out[k] = Number.isFinite(n) ? clamp(n, lo, hi) : DEFAULTS[k];
    }
    return out;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
  }

  // Stops for the shader. A tint preset builds a ramp from the brand colour.
  function presetStops(opts) {
    const p = PRESETS[opts.preset];
    if (p.stops) return p.stops.map(hexToRgb);
    const c = hexToRgb(opts.tint);
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const black = [0.02, 0.02, 0.03];
    const white = [1, 1, 1];
    return [mix(c, black, 0.88), mix(c, black, 0.55), c, mix(c, white, 0.6), white];
  }

  // Reads width and height from an SVG string (width/height attributes, else viewBox).
  function parseSvgSize(text) {
    const tag = /<svg\b[^>]*>/i.exec(text);
    if (!tag) return null;
    const attr = (name) => {
      const m = new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(tag[0]);
      return m ? m[1] : null;
    };
    const num = (s) => {
      if (!s || /%/.test(s)) return null;
      const n = parseFloat(s);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const w = num(attr('width'));
    const h = num(attr('height'));
    if (w && h) return { width: w, height: h };
    const vb = attr('viewBox');
    if (vb) {
      const p = vb.trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) return { width: p[2], height: p[3] };
    }
    return null;
  }

  // Size of the mask texture for a logo of this shape: the logo fills 80% of the longest side, the rest is padding.
  function maskDimensions(srcW, srcH) {
    const long = MASK_SIZE * (1 - 2 * MASK_PAD);
    const s = long / Math.max(srcW, srcH);
    const innerW = Math.max(1, Math.round(srcW * s));
    const innerH = Math.max(1, Math.round(srcH * s));
    const pad = Math.round(MASK_SIZE * MASK_PAD);
    return { width: innerW + 2 * pad, height: innerH + 2 * pad, innerW, innerH, pad };
  }

  // Squared distance transform of one line (Felzenszwalb and Huttenlocher).
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }

  // Distance from every inside pixel to the nearest outside pixel, in pixels. Outside pixels are 0.
  function insideDistance(alpha, w, h) {
    const BIG = 1e12;
    const grid = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) grid[i] = alpha[i] >= 0.5 ? BIG : 0;
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
    }
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = alpha[i] >= 0.5 ? Math.sqrt(grid[i]) - 0.5 : 0;
    return out;
  }

  function boxBlur(src, w, h, r, passes) {
    const a = Float32Array.from(src);
    const b = new Float32Array(a.length);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let x = -r; x <= r; x++) sum += a[y * w + clamp(x, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          b[y * w + x] = sum / (2 * r + 1);
          sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -r; y <= r; y++) sum += b[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = sum / (2 * r + 1);
          sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  }

  // RGBA bytes for the shader: R is bevel depth (0 at the edge, 255 at DEPTH_PX inside), G is the logo coverage.
  function buildMask(alpha, w, h) {
    const dist = boxBlur(insideDistance(alpha, w, h), w, h, 3, 2);
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = Math.round(clamp(dist[i] / DEPTH_PX, 0, 1) * 255);
      out[i * 4 + 1] = Math.round(clamp(alpha[i], 0, 1) * 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  function alphaFromRGBA(data) {
    const a = new Float32Array(data.length / 4);
    for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] / 255;
    return a;
  }

  function averageColor(data) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return n ? rgbToHex([r / n / 255, g / n / 255, b / n / 255]) : null;
  }

  // The embed snippet. Attribute names here are the ones the auto-init reads back.
  const ATTRS = { preset: 'data-preset', tint: 'data-tint', speed: 'data-speed', refraction: 'data-refraction', softness: 'data-softness', light: 'data-light', bevel: 'data-bevel' };

  function buildSnippet(opts, cfg) {
    const o = clampOptions(opts);
    const c = Object.assign({ scriptUrl: 'liquid-logo.js', src: 'your-logo.svg', width: '320px' }, cfg);
    const attrs = ['data-liquid-logo', `data-src="${c.src}"`];
    for (const k of Object.keys(ATTRS)) {
      if (k === 'tint' && o.preset !== 'tint') continue;
      attrs.push(`${ATTRS[k]}="${o[k]}"`);
    }
    attrs.push(`style="width:${c.width}"`);
    return `<script src="${c.scriptUrl}" defer></script>\n<div ${attrs.join(' ')}></div>`;
  }

  // Reads options from a dataset-like object (element.dataset), where data-light becomes ds.light.
  function optionsFromDataset(ds) {
    const raw = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (ds[k] !== undefined) raw[k] = ds[k];
    }
    return clampOptions(raw);
  }

  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = vec2(aPos.x, -aPos.y) * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMask;
uniform vec2 uTexel;
uniform float uAspect;
uniform float uTime;
uniform float uClock;
uniform float uRefraction;
uniform float uSoftness;
uniform float uBevel;
uniform float uLight;
uniform float uIrid;
uniform vec3 uStops[5];
uniform vec4 uRip[8];

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s;
}

// Height of the liquid surface at uv: bevel from the distance field, a flowing swell, and ripples.
float height(vec2 uv) {
  vec2 q = uv * vec2(uAspect, 1.0);
  vec2 warp = vec2(fbm(q * 2.2 + vec2(0.0, uTime * 0.35)), fbm(q * 2.2 + vec2(5.2, -uTime * 0.3))) - 0.5;
  vec2 u = uv + warp * 0.06 * uRefraction;
  float depth = clamp(texture(uMask, u).r / max(uBevel, 0.05), 0.0, 1.0);
  float rounded = sqrt(max(0.0, 1.0 - (1.0 - depth) * (1.0 - depth)));
  float h = mix(rounded, smoothstep(0.0, 1.0, depth), uSoftness);
  float swell = fbm(q * 2.0 + vec2(uTime * 0.4, uTime * 0.25)) - 0.5;
  h += swell * (0.25 + 0.75 * uRefraction) * smoothstep(0.0, 0.5, depth) * 0.3;
  for (int i = 0; i < 8; i++) {
    vec4 r = uRip[i];
    float age = uClock - r.z;
    if (r.w > 0.0 && age > 0.0 && age < 3.0) {
      float d = length((uv - r.xy) * vec2(uAspect, 1.0));
      float ring = sin((d - age * 0.35) * 38.0) * exp(-age * 1.5) * exp(-d * 3.5) * r.w;
      h += ring * 0.08 * smoothstep(0.0, 0.3, depth);
    }
  }
  return h;
}

// A made-up studio: a sky gradient with bands, a bright horizon line and two soft boxes, turned by the light angle.
float envLight(vec3 r) {
  float c = cos(radians(uLight)), s = sin(radians(uLight));
  r.xy = mat2(c, -s, s, c) * r.xy;
  float sky = smoothstep(-0.7, 0.9, r.y);
  float band = 0.5 + 0.5 * sin(r.y * 6.5 + r.x * 2.0);
  float horizon = exp(-pow((r.y + 0.05) * 4.5, 2.0));
  float boxA = smoothstep(0.42, 0.0, length(r.xy - vec2(0.45, 0.55)));
  float boxB = 0.7 * smoothstep(0.32, 0.0, length(r.xy - vec2(-0.6, 0.1)));
  float ground = 0.22 * smoothstep(0.0, -0.9, r.y);
  return clamp(0.10 + 0.55 * sky * (0.35 + 0.65 * band) + 0.7 * horizon + 0.7 * boxA + boxB * 0.8 + ground, 0.0, 1.4);
}

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  int i = int(min(floor(t), 3.0));
  float f = smoothstep(0.0, 1.0, t - float(i));
  return mix(uStops[i], uStops[i + 1], f);
}

void main() {
  vec2 uv = vUv;
  vec4 m = texture(uMask, uv);
  float alpha = smoothstep(0.35, 0.65, m.g);
  if (alpha <= 0.002) { outColor = vec4(0.0); return; }

  vec2 e = uTexel * (1.5 + 3.0 * uSoftness);
  float hx = height(uv + vec2(e.x, 0.0)) - height(uv - vec2(e.x, 0.0));
  float hy = height(uv + vec2(0.0, e.y)) - height(uv - vec2(0.0, e.y));
  float k = 5.5 + 7.0 * uRefraction;
  vec3 n = normalize(vec3(-hx * k, -hy * k, 2.0 * e.x * 60.0 / (0.5 + uBevel)));
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);

  float L = envLight(r);
  vec3 col = ramp(L);
  float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.0);
  vec3 film = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + L * 0.7 + n.x * 0.6 + n.y * 0.4));
  col = mix(col, film * (0.6 + 0.5 * L), uIrid);
  col += fres * 0.18;
  vec3 ldir = normalize(vec3(cos(radians(uLight)) * 0.6, sin(radians(uLight)) * 0.6, 0.8));
  col += pow(max(dot(reflect(-ldir, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0) * 0.5;
  outColor = vec4(col * alpha, alpha);
}`;

  function reducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function webgl2Supported() {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch { return false; }
  }

  // Draw an image (SVG or PNG) into a padded canvas and return its pixels.
  function rasterize(img) {
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    const dim = maskDimensions(sw, sh);
    const cv = document.createElement('canvas');
    cv.width = dim.width; cv.height = dim.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, dim.pad, dim.pad, dim.innerW, dim.innerH);
    return { dim, data: ctx.getImageData(0, 0, dim.width, dim.height).data };
  }

  function loadImage(src, svgText) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load the logo image'));
      if (svgText) {
        // Firefox reports 0 size for SVGs that only have a viewBox, so give the image an explicit size.
        const size = parseSvgSize(svgText);
        if (size) { img.width = size.width; img.height = size.height; }
      }
      img.src = src;
    });
  }

  class LiquidLogo {
    constructor(canvas, options) {
      this.canvas = canvas;
      this.opts = clampOptions(options);
      this.fallbackImg = null;
      this.time = 0;
      this.clock = 0;
      this.ripples = [];
      this.running = false;
      this.visible = !document.hidden;
      this.inView = true;
      this.hasLogo = false;
      this.reduced = reducedMotion();
      this.gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
      this.supported = !!this.gl;
      if (this.supported) this.#initGL();
      this.#bindEvents();
    }

    #initGL() {
      const gl = this.gl;
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      this.prog = prog;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      for (const n of ['uMask', 'uTexel', 'uAspect', 'uTime', 'uClock', 'uRefraction', 'uSoftness', 'uBevel', 'uLight', 'uIrid', 'uStops', 'uRip']) {
        this.u[n] = gl.getUniformLocation(prog, n);
      }
      this.tex = gl.createTexture();
    }

    #bindEvents() {
      const c = this.canvas;
      let last = null;
      const point = (e) => {
        const r = c.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      };
      c.addEventListener('pointermove', (e) => {
        if (this.reduced || !this.hasLogo) return;
        const p = point(e);
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) { this.addRipple(p[0], p[1], 0.55); last = p; }
      });
      c.addEventListener('pointerdown', (e) => {
        if (this.reduced || !this.hasLogo) return;
        const p = point(e);
        this.addRipple(p[0], p[1], 1);
      });
      this.onVisibility = () => { this.visible = !document.hidden; this.#schedule(); };
      document.addEventListener('visibilitychange', this.onVisibility);
      if (typeof IntersectionObserver === 'function') {
        this.io = new IntersectionObserver((entries) => {
          this.inView = entries[entries.length - 1].isIntersecting;
          this.#schedule();
        });
        this.io.observe(c);
      }
    }

    addRipple(x, y, amp) {
      this.ripples.push({ x, y, t: this.clock, amp });
      if (this.ripples.length > 8) this.ripples.shift();
    }

    async setImage(src, svgText) {
      const img = await loadImage(src, svgText);
      const { dim, data } = rasterize(img);
      this.dim = dim;
      this.avgColor = averageColor(data);
      this.canvas.style.aspectRatio = `${dim.width} / ${dim.height}`;
      if (!this.supported) { this.#showFallback(src); return; }
      const mask = buildMask(alphaFromRGBA(data), dim.width, dim.height);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dim.width, dim.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.hasLogo = true;
      this.render();
      this.#schedule();
    }

    // No WebGL2: show the original logo as a plain image so the page is never empty.
    #showFallback(src) {
      if (!this.fallbackImg) {
        this.fallbackImg = document.createElement('img');
        this.fallbackImg.alt = this.canvas.getAttribute('aria-label') || 'Logo';
        this.fallbackImg.style.cssText = 'width:100%;height:auto;display:block';
        this.canvas.after(this.fallbackImg);
        this.canvas.style.display = 'none';
      }
      this.fallbackImg.src = src;
    }

    setOptions(o) {
      this.opts = clampOptions({ ...this.opts, ...o });
      if (this.hasLogo) { this.render(); this.#schedule(); }
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(r.width * dpr));
      const h = this.dim ? Math.max(2, Math.round(w * this.dim.height / this.dim.width)) : Math.max(2, Math.round(r.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
    }

    render() {
      if (!this.supported || !this.hasLogo) return;
      const gl = this.gl, u = this.u, o = this.opts;
      this.resize();
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(u.uMask, 0);
      gl.uniform2f(u.uTexel, 1 / this.dim.width, 1 / this.dim.height);
      gl.uniform1f(u.uAspect, this.dim.width / this.dim.height);
      gl.uniform1f(u.uTime, this.reduced ? 3.2 : this.time);
      gl.uniform1f(u.uClock, this.clock);
      gl.uniform1f(u.uRefraction, o.refraction);
      gl.uniform1f(u.uSoftness, o.softness);
      gl.uniform1f(u.uBevel, o.bevel);
      gl.uniform1f(u.uLight, o.light);
      gl.uniform1f(u.uIrid, PRESETS[o.preset].irid);
      gl.uniform3fv(u.uStops, new Float32Array(presetStops(o).flat()));
      const rip = new Float32Array(32);
      this.ripples.forEach((r, i) => { rip.set([r.x, r.y, r.t, r.amp], i * 4); });
      gl.uniform4fv(u.uRip, rip);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Animation runs only when allowed: motion not reduced, tab visible, element on screen.
    get animating() { return this.hasLogo && this.supported && !this.reduced && this.visible && this.inView && this.opts.speed > 0; }

    #schedule() {
      if (this.running || !this.animating) return;
      this.running = true;
      let prev = performance.now();
      const tick = (now) => {
        if (!this.animating) { this.running = false; return; }
        const dt = Math.min(0.05, (now - prev) / 1000);
        prev = now;
        this.time += dt * this.opts.speed;
        this.clock += dt;
        this.render();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }

    toBlob(type) {
      this.render();
      return new Promise((resolve) => this.canvas.toBlob(resolve, type || 'image/png'));
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      this.running = false;
      document.removeEventListener('visibilitychange', this.onVisibility);
      if (this.io) this.io.disconnect();
    }
  }

  // Auto-init: every [data-liquid-logo] element gets a canvas and the effect.
  async function mount(el) {
    if (el.__liquidLogo) return el.__liquidLogo;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:auto;display:block';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', el.getAttribute('aria-label') || 'Logo');
    el.appendChild(canvas);
    const inst = new LiquidLogo(canvas, optionsFromDataset(el.dataset));
    el.__liquidLogo = inst;
    const src = el.dataset.src;
    if (src) {
      try {
        const text = /\.svg(\?|#|$)/i.test(src) ? await fetch(src).then((r) => r.text()) : null;
        await inst.setImage(src, text);
      } catch {
        const img = document.createElement('img');
        img.src = src;
        img.alt = canvas.getAttribute('aria-label');
        img.style.cssText = 'width:100%;height:auto;display:block';
        canvas.replaceWith(img);
      }
    }
    return inst;
  }

  function init(scope) {
    const els = (scope || document).querySelectorAll('[data-liquid-logo]');
    return Promise.all(Array.from(els, mount));
  }

  const api = {
    DEFAULTS, LIMITS, PRESETS, ATTRS, MASK_SIZE, DEPTH_PX,
    clampOptions, hexToRgb, rgbToHex, presetStops, parseSvgSize, maskDimensions,
    insideDistance, boxBlur, buildMask, alphaFromRGBA, averageColor, buildSnippet, optionsFromDataset,
    FRAG, VERT, LiquidLogo, mount, init, webgl2Supported, loadImage, rasterize,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.LiquidLogo = api;
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
      else init();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
