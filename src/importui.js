// CleanAi — teknik çizim içe aktarma arayüzü.
// Çizimi tarar, bulduklarını çizim üstünde gösterir, düzeltmeye izin verir, planı üretir.
import { detectPlan, toPlan, DEFAULTS } from './import.js';
import { validatePlan } from './validate.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_W = 560;

export function initImporter({ onPlan, toast }) {
  const state = { image: null, det: null, overrides: new Map(), fileName: '' };

  const dlg = $('importer');
  const cv = $('impCanvas');
  const ctx = cv.getContext('2d');

  const open = () => {
    // mobilde paneller alttan açılan sayfa olduğu için aynı anda yalnız biri açık kalmalı
    for (const id of ['projects', 'editor']) document.getElementById(id)?.classList.remove('open');
    dlg.classList.add('open');
  };
  const close = () => { dlg.classList.remove('open'); };

  /* --- görüntü yükleme --- */

  async function loadFile(file) {
    if (!file) return;
    state.fileName = file.name;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('Görüntü açılamadı'));
        im.src = url;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
      state.image = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      state.bitmap = img;
      $('impFile').textContent = `${file.name} · ${c.width}×${c.height} px`;
      state.overrides.clear();
      scan();
    } catch (e) {
      toast('Çizim okunamadı: ' + e.message);
    } finally { URL.revokeObjectURL(url); }
  }

  /* --- tarama --- */

  function scan() {
    if (!state.image) return;
    const t0 = performance.now();
    try {
      state.det = detectPlan(state.image, {
        threshold: Number($('impThreshold').value),
        minLineFrac: Number($('impMinLine').value) / 1000,
      });
    } catch (e) {
      $('impSummary').innerHTML = `<span class="bad">Tarama hatası: ${e.message}</span>`;
      return;
    }
    const ms = Math.round(performance.now() - t0);
    const d = state.det;
    const doors = d.openings.filter((o) => o.type === 'door').length;
    const pb = d.openings.length - doors;
    $('impSummary').innerHTML = d.rooms.length
      ? `<b>${d.rooms.length}</b> oda · <b>${d.segs.length}</b> duvar · <b>${doors}</b> kapı · <b>${pb}</b> pass-box <span class="dim">(${ms} ms)</span>`
      : `<span class="bad">Oda bulunamadı — eşiği ya da en kısa çizgi değerini değiştir.</span>`;
    draw();
    renderList();
  }

  /* --- önizleme çizimi --- */

  function draw() {
    const d = state.det;
    if (!d || !state.bitmap) return;
    const s = PREVIEW_W / state.image.width;
    cv.width = PREVIEW_W;
    cv.height = Math.round(state.image.height * s);
    ctx.drawImage(state.bitmap, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = '#0e1418';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;

    // odalar
    ctx.lineWidth = 2;
    d.rooms.forEach((r, i) => {
      ctx.beginPath();
      r.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
      ctx.closePath();
      ctx.fillStyle = i === 0 ? 'rgba(25,198,224,.14)' : 'rgba(122,167,255,.14)';
      ctx.fill();
      ctx.strokeStyle = i === 0 ? '#19c6e0' : '#7aa7ff';
      ctx.stroke();
    });

    // duvarlar
    ctx.strokeStyle = '#e6eef2';
    ctx.lineWidth = 1.5;
    for (const sg of d.segs) {
      ctx.beginPath();
      ctx.moveTo(sg.a[0] * s, sg.a[1] * s);
      ctx.lineTo(sg.b[0] * s, sg.b[1] * s);
      ctx.stroke();
    }

    // açıklıklar
    d.openings.forEach((o, i) => {
      const type = state.overrides.get(i) ?? o.type;
      if (type === 'none') return;
      const sg = d.segs[o.seg];
      const len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]);
      const ux = (sg.b[0] - sg.a[0]) / len, uy = (sg.b[1] - sg.a[1]) / len;
      const x0 = sg.a[0] + ux * o.t0, y0 = sg.a[1] + uy * o.t0;
      const x1 = sg.a[0] + ux * o.t1, y1 = sg.a[1] + uy * o.t1;
      ctx.strokeStyle = type === 'door' ? '#2bd67b' : '#ffb020';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x0 * s, y0 * s);
      ctx.lineTo(x1 * s, y1 * s);
      ctx.stroke();
      ctx.fillStyle = '#e6eef2';
      ctx.font = '11px system-ui';
      ctx.fillText(String(i + 1), ((x0 + x1) / 2) * s + 6, ((y0 + y1) / 2) * s - 5);
    });
  }

  /* --- bulunanlar listesi --- */

  function renderList() {
    const d = state.det;
    const el = $('impList');
    if (!d) { el.innerHTML = ''; return; }
    if (!d.openings.length) {
      el.innerHTML = '<div class="dim">Kapı/pass-box simgesi bulunamadı — planı yine de oluşturup ölçü düzenleyiciden ekleyebilirsin.</div>';
      return;
    }
    el.innerHTML = '';
    d.openings.forEach((o, i) => {
      const row = document.createElement('div');
      row.className = 'irow';
      const cur = state.overrides.get(i) ?? o.type;
      const low = o.confidence < 0.6;
      row.innerHTML = `<span class="n">${i + 1}</span>
        <select data-i="${i}">
          <option value="door">Kapı</option>
          <option value="passbox">Pass-box</option>
          <option value="none">Yok say</option>
        </select>
        <span class="dim${low ? ' warn' : ''}">güven ${o.confidence}${low ? ' ⚠' : ''}</span>`;
      row.querySelector('select').value = cur;
      row.querySelector('select').addEventListener('change', (e) => {
        state.overrides.set(i, e.target.value);
        draw();
      });
      el.appendChild(row);
    });
  }

  /* --- plan üretimi --- */

  function buildPlan() {
    const d = state.det;
    if (!d) return null;
    const openings = d.openings
      .map((o, i) => ({ ...o, type: state.overrides.get(i) ?? o.type }))
      .filter((o) => o.type !== 'none');
    const name = $('impName').value.trim() || state.fileName.replace(/\.[^.]+$/, '') || 'İçe aktarılan oda';
    const plan = toPlan({ ...d, openings }, {
      widthMeters: Number($('impWidth').value),
      wallHeight: Number($('impHeight').value),
      name,
      id: 'ice-aktarilan',
    });
    const errs = validatePlan(plan);
    if (errs.length) {
      $('impSummary').innerHTML = `<span class="bad">Plan geçersiz: ${errs[0]}</span>`;
      return null;
    }
    return { plan, name };
  }

  /* --- bağlama --- */

  $('importBtn').addEventListener('click', open);
  $('impClose').addEventListener('click', close);
  $('impInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
  for (const id of ['impThreshold', 'impMinLine']) {
    $(id).addEventListener('input', () => {
      $(id + 'Val').textContent = $(id).value;
      clearTimeout(scan._t);
      scan._t = setTimeout(scan, 180);
    });
  }
  $('impWidth').addEventListener('input', () => { /* ölçek yalnız üretimde kullanılır */ });

  const drop = $('impDrop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  });

  $('impCreate').addEventListener('click', async () => {
    const built = buildPlan();
    if (!built) return;
    close();
    await onPlan(built.plan, built.name);
  });

  // örnek çizimle dene
  $('impSample').addEventListener('click', async () => {
    try {
      const r = await fetch('./samples/cizim-plan-a.png');
      const blob = await r.blob();
      await loadFile(new File([blob], 'cizim-plan-a.png', { type: 'image/png' }));
      $('impWidth').value = 7;
    } catch { toast('Örnek çizim yüklenemedi'); }
  });

  // varsayılanları yaz
  $('impThreshold').value = DEFAULTS.threshold;
  $('impThresholdVal').textContent = DEFAULTS.threshold;
  $('impMinLine').value = Math.round(DEFAULTS.minLineFrac * 1000);
  $('impMinLineVal').textContent = Math.round(DEFAULTS.minLineFrac * 1000);

  return { open, close, loadFile, scan, buildPlan, state };
}
