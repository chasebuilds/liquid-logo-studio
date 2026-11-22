(function () {
  'use strict';

  const L = window.LiquidLogo;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const notice = $('notice');
  const logo = new L.LiquidLogo($('canvas'), L.DEFAULTS);
  const opts = { ...L.DEFAULTS };
  let embedSrc = 'your-logo.svg';
  let objectUrl = null;

  function say(text) {
    notice.textContent = text || '';
    notice.hidden = !text;
  }

  function flash(el, text) {
    el.textContent = text;
    setTimeout(() => { el.textContent = ''; }, 2500);
  }

  function updateSnippet() {
    $('snippet').textContent = L.buildSnippet(opts, {
      scriptUrl: new URL('liquid-logo.js', location.href).href,
      src: embedSrc,
    });
  }

  function apply(patch) {
    Object.assign(opts, patch);
    logo.setOptions(opts);
    updateSnippet();
  }

  function showValues() {
    for (const k of ['speed', 'refraction', 'softness', 'light', 'bevel']) {
      const out = document.querySelector(`output[for="${k}"]`);
      out.textContent = k === 'light' ? `${opts[k]}°` : Number(opts[k]).toFixed(2);
    }
  }

  async function loadLogo(url, svgText, label) {
    try {
      await logo.setImage(url, svgText);
    } catch {
      say(`${label} could not be read as a logo. Try a different SVG or PNG.`);
      return false;
    }
    say(logo.supported ? '' : 'This browser cannot run WebGL2, so the plain logo is shown instead.');
    if (logo.reduced) say('Your device asks for reduced motion, so the effect is a still frame.');
    const c = logo.avgColor && logo.avgColor.slice(1).match(/../g).map((h) => parseInt(h, 16));
    if (c && Math.max(...c) - Math.min(...c) > 40) { $('tint').value = logo.avgColor; apply({ tint: logo.avgColor }); }
    return true;
  }

  async function loadFile(file) {
    const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
    if (!isSvg && !isPng) { say('Please choose an SVG or PNG file.'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const text = isSvg ? await file.text() : null;
    objectUrl = URL.createObjectURL(isSvg ? new Blob([text], { type: 'image/svg+xml' }) : file);
    embedSrc = isSvg ? 'your-logo.svg' : 'your-logo.png';
    if (await loadLogo(objectUrl, text, file.name)) updateSnippet();
  }

  async function loadSample(name) {
    const url = new URL(`samples/${name}.svg`, location.href).href;
    const text = await fetch(url).then((r) => r.text());
    embedSrc = url;
    await loadLogo(url, text, name);
    updateSnippet();
  }

  for (const k of ['speed', 'refraction', 'softness', 'light', 'bevel']) {
    $(k).addEventListener('input', (e) => { apply({ [k]: Number(e.target.value) }); showValues(); });
  }
  $('tint').addEventListener('input', (e) => apply({ tint: e.target.value }));

  function pills(selector, attr, onPick) {
    const btns = document.querySelectorAll(selector);
    btns.forEach((b) => b.addEventListener('click', () => {
      btns.forEach((x) => x.classList.toggle('on', x === b));
      onPick(b.dataset[attr]);
    }));
  }
  pills('[data-preset]', 'preset', (v) => { $('tintRow').hidden = v !== 'tint'; apply({ preset: v }); });
  pills('[data-bg]', 'bg', (v) => { stage.dataset.bg = v; });
  document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => loadSample(b.dataset.sample)));
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });

  const wrap = stage.parentElement;
  let depth = 0;
  wrap.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; $('drop').hidden = false; });
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; $('drop').hidden = true;
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('exportPng').addEventListener('click', async () => {
    if (!logo.hasLogo || !logo.supported) { say('Load a logo first (WebGL2 is needed to export).'); return; }
    download(await logo.toBlob('image/png'), 'liquid-logo.png');
  });

  $('exportWebm').addEventListener('click', () => {
    const btn = $('exportWebm');
    if (!logo.hasLogo || !logo.supported) { say('Load a logo first (WebGL2 is needed to export).'); return; }
    if (typeof MediaRecorder === 'undefined') { say('This browser cannot record video. Use the PNG export.'); return; }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { say('This browser cannot record WebM. Use the PNG export.'); return; }
    const src = logo.canvas;
    const comp = document.createElement('canvas');
    comp.width = src.width; comp.height = src.height;
    const ctx = comp.getContext('2d');
    const fill = stage.dataset.bg === 'light' ? '#f4f1ec' : '#0c0d12';
    const rec = new MediaRecorder(comp.captureStream(30), { mimeType: mime, videoBitsPerSecond: 8e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      download(new Blob(chunks, { type: 'video/webm' }), 'liquid-logo.webm');
      btn.disabled = false;
      btn.textContent = 'Record WebM (5 s)';
    };
    const start = performance.now();
    btn.disabled = true;
    rec.start();
    (function frame(now) {
      const left = 5 - (now - start) / 1000;
      if (left <= 0) { rec.stop(); return; }
      btn.textContent = `Recording ${Math.ceil(left)} s`;
      logo.render();
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, comp.width, comp.height);
      ctx.drawImage(src, 0, 0);
      requestAnimationFrame(frame);
    })(start);
  });

  $('copySnippet').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('snippet').textContent);
      flash($('copyNote'), 'Copied');
    } catch {
      flash($('copyNote'), 'Select the text above and copy it');
    }
  });

  showValues();
  updateSnippet();
  loadSample('orbit');
  window.__studio = { logo, opts };
})();
