import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildPlan, makeMaterials, blocked } from './build.js';
import { renderHMIBackground, buildHMISVG, buildTagMap, planBounds } from './hmi.js';
import { validatePlan } from './validate.js';
import { initImporter } from './importui.js';

const EYE = 1.65, RADIUS = 0.32, SPEED = 2.4, RUN = 4.2;

const app = {
  cfg: null, current: null, mode: 'walk', online: false,
  projects: [], projectId: null, saved: null, dirty: false,
  yaw: 0, pitch: 0, keys: new Set(), locked: false,
};

/* ---------- renderer / scene ---------- */

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Mobilde piksel oranını kısıyoruz: retina telefonlarda 3x render GPU'yu boğuyor.
const smallScreen = Math.min(innerWidth, innerHeight) < 820;
renderer.setPixelRatio(Math.min(devicePixelRatio, smallScreen ? 1.6 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb9c3c9);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe6e9, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 0.5);
sun.position.set(6, 12, -4);
sun.castShadow = true;
sun.shadow.mapSize.set(smallScreen ? 1024 : 2048, smallScreen ? 1024 : 2048);
scene.add(sun, sun.target);

const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.enabled = false;

const mats = makeMaterials();

// Hata ayıklama/otomatik test tutamağı: sahneyi dışarıdan ölçebilmek için.
// Salt okunur referanslar; uygulamanın davranışını etkilemez.
window.__cleanai = { app, scene, mats, get cfg() { return app.cfg; } };
const $ = (id) => document.getElementById(id);

/* ---------- API (sunucu yoksa dosyadan okumaya düşer) ---------- */

const api = {
  async list() {
    try {
      const r = await fetch('./api/projects');
      if (!r.ok) throw new Error(r.status);
      app.online = true;
      return await r.json();
    } catch {
      app.online = false;
      return [
        { id: 'plan-a', name: 'Plan A — Kare oda + koridor', local: true },
        { id: 'plan-b', name: 'Plan B — L odası + soyunma/airlock', local: true },
      ];
    }
  },
  async get(id) {
    if (app.online) {
      const r = await fetch(`./api/projects/${id}`);
      if (r.ok) return await r.json();
    }
    const r = await fetch(`./data/${id}.json`);
    if (!r.ok) throw new Error(`${id} okunamadı`);
    const plan = await r.json();
    return { id, name: plan.name, plan, local: true };
  },
  async save(id, body) {
    const r = await fetch(`./api/projects/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.details ? j.error + ':\n' + j.details.join('\n') : j.error);
    return j;
  },
  async create(body) {
    const r = await fetch('./api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.details ? j.error + ':\n' + j.details.join('\n') : j.error);
    return j;
  },
  async remove(id) {
    const r = await fetch(`./api/projects/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error);
  },
  async publishHMI(id, payload) {
    const r = await fetch(`./api/projects/${id}/hmi`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  },
};

/* ---------- sahne kurulumu ---------- */

function rebuild(cfg) {
  if (app.current) {
    scene.remove(app.current.root);
    app.current.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
  app.cfg = cfg;
  app.current = buildPlan(cfg, mats);
  scene.add(app.current.root);
  setCeiling(app.ceilingOpen ?? false, true);

  const b = planBounds(cfg, 0);
  sun.target.position.set(b.minX + b.w / 2, 0, b.minZ + b.h / 2);
  resetCamera();
  buildLegend(cfg);
}

async function openProject(id) {
  const rec = await api.get(id);
  app.projectId = rec.id;
  app.saved = JSON.stringify(rec.plan);
  app.dirty = false;
  $('planName').textContent = rec.name;
  $('editName').textContent = rec.name;
  $('planJson').value = JSON.stringify(rec.plan, null, 2);
  rebuild(rec.plan);
  renderProjects();
}

function resetCamera() {
  const s = app.cfg.spawn || { x: 1, z: 1, heading: 0 };
  if (app.mode === 'walk') {
    camera.position.set(s.x, EYE, s.z);
    app.yaw = ((s.heading || 0) * Math.PI) / 180;
    app.pitch = 0;
    applyLook();
  } else {
    const b = planBounds(app.cfg, 0);
    const cx = b.minX + b.w / 2, cz = b.minZ + b.h / 2;
    orbit.target.set(cx, 1.0, cz);
    camera.position.set(cx - b.w * 0.55, Math.max(b.w, b.h) * 0.85, cz + b.h * 0.95);
    orbit.update();
  }
}

/** Maket modunda tavan plakası kalkar (üstü açık maket görünümü). */
/**
 * Tavan düzeneği (plaka + HEPA + aydınlatma + dönüş menfezleri) tek parça olarak
 * yukarı kalkar. Kapalıyken yapı bütün, açıkken iç mekân görünür; ekipman
 * havada kaldığı için hangi birimin nereye geldiği yine okunur.
 */
function setCeiling(open, instant = false) {
  app.ceilingOpen = open;
  const lift = Math.max(1.8, (app.cfg?.wallHeight ?? 2.7) * 0.95);
  app.ceilingLift = lift;
  app.ceilingTarget = open ? lift : 0;
  if (instant && app.current) {
    app.current.ceilingGroup.position.y = app.ceilingTarget;
    applyCeilingFade();
  }
  const label = open ? 'Tavanı kapat' : 'Tavanı aç';
  $('ceilBtn').textContent = label;
  $('ceilBtn').classList.toggle('on', open);
  $('mCeilBtn').textContent = open ? 'Tavan ▼' : 'Tavan ▲';
}

/**
 * Plaka kalktıkça saydamlaşır; yoksa havada asılı tavan iç mekânı yukarıdan
 * kapatıyor. Ekipman (HEPA, armatür, menfez) opak kalır, yerleşim okunur.
 */
function applyCeilingFade() {
  const g = app.current?.ceilingGroup;
  if (!g) return;
  const t = Math.min(1, g.position.y / (app.ceilingLift || 1));
  const m = mats.ceiling;
  m.opacity = 1 - 0.85 * t;
  m.transparent = t > 0.01;
  m.depthWrite = !m.transparent;
  m.needsUpdate = true;
}

/** Tavan yüksekliğini hedefe doğru yumuşakça taşır. */
function animateCeiling(dt) {
  const g = app.current?.ceilingGroup;
  if (!g) return;
  const d = app.ceilingTarget - g.position.y;
  if (Math.abs(d) < 0.001) {
    if (g.position.y !== app.ceilingTarget) { g.position.y = app.ceilingTarget; applyCeilingFade(); }
    return;
  }
  g.position.y += d * Math.min(1, dt * 4.5);
  applyCeilingFade();
}

function setMode(m) {
  app.mode = m;
  orbit.enabled = (m === 'orbit');
  setCeiling(m === 'orbit');
  if (m === 'orbit' && document.pointerLockElement) document.exitPointerLock();
  document.querySelectorAll('[data-mode]').forEach((el) =>
    el.classList.toggle('on', el.dataset.mode === m));
  $('hint').textContent = m === 'walk'
    ? 'Tıkla → fare kilidi · WASD yürü · Shift koş · C çömel · E kapı · T tavan · Esc çık'
    : 'Sol tuş döndür · sağ tuş kaydır · tekerlek yakınlaş · T tavan';
  if (m !== 'walk') { stickHide(); touch.moveId = touch.lookId = null; }
  syncMobileBar();
  if (app.cfg) resetCamera();
}

/* ---------- proje paneli ---------- */

function renderProjects() {
  $('apiState').className = 'dot ' + (app.online ? 'on' : 'off');
  $('apiState').title = app.online
    ? 'Sunucuya bağlı — değişiklikler kaydedilebilir'
    : 'Sunucu yok — salt okunur (npm start ile çalıştır)';
  const el = $('projList');
  el.innerHTML = '';
  for (const p of app.projects) {
    const b = document.createElement('button');
    b.className = 'proj' + (p.id === app.projectId ? ' on' : '');
    const meta = p.local ? 'yerel dosya'
      : `${p.area ?? '?'} m² · v${p.version} · ${new Date(p.updatedAt).toLocaleDateString('tr-TR')}`;
    b.innerHTML = `${escapeHtml(p.name)}${app.dirty && p.id === app.projectId ? ' •' : ''}<small>${meta}</small>`;
    b.addEventListener('click', () => guardDirty(() => openProject(p.id)));
    el.appendChild(b);
  }
  for (const id of ['saveBtn', 'saveAsBtn', 'delBtn', 'publishBtn']) {
    $(id).disabled = !app.online;
  }
  $('saveBtn').textContent = app.dirty ? 'Kaydet •' : 'Kaydet';
}

const escapeHtml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function guardDirty(fn) {
  if (app.dirty && !confirm('Kaydedilmemiş ölçü değişikliği var. Yine de devam edilsin mi?')) return;
  fn();
}

async function refreshProjects() {
  app.projects = await api.list();
  renderProjects();
}

/* ---------- kaydetme ---------- */

async function saveProject() {
  if (!app.online) return toast('Sunucu bağlantısı yok — kaydedilemiyor');
  try {
    const rec = await api.save(app.projectId, { plan: app.cfg });
    app.saved = JSON.stringify(app.cfg);
    app.dirty = false;
    await refreshProjects();
    toast(`Kaydedildi — ${rec.name} (v${rec.version})`);
  } catch (e) { toast('Kaydedilemedi: ' + e.message); }
}

async function saveProjectAs() {
  if (!app.online) return toast('Sunucu bağlantısı yok — kaydedilemiyor');
  const name = prompt('Yeni proje adı:', (app.cfg.name || 'Temiz oda') + ' kopya');
  if (!name) return;
  try {
    const rec = await api.create({ name, plan: { ...app.cfg, name } });
    app.dirty = false;
    await refreshProjects();
    await openProject(rec.id);
    toast(`Oluşturuldu — ${rec.name}`);
  } catch (e) { toast('Oluşturulamadı: ' + e.message); }
}

async function deleteProject() {
  if (!app.online) return;
  const p = app.projects.find((q) => q.id === app.projectId);
  if (!p || !confirm(`"${p.name}" silinsin mi? Bu geri alınamaz.`)) return;
  try {
    await api.remove(app.projectId);
    await refreshProjects();
    if (app.projects.length) await openProject(app.projects[0].id);
    toast('Proje silindi');
  } catch (e) { toast('Silinemedi: ' + e.message); }
}

/* ---------- ölçü düzenleyici ---------- */

function toggleEditor(open) {
  if (open === false) { $('editor').classList.remove('open'); return; }
  openSheet('editor');
}

function applyEdits() {
  let plan;
  try { plan = JSON.parse($('planJson').value); }
  catch (e) { $('editErr').textContent = 'JSON hatası: ' + e.message; return; }
  const errs = validatePlan(plan);
  if (errs.length) { $('editErr').textContent = errs.join('\n'); return; }
  $('editErr').textContent = '';
  rebuild(plan);
  app.dirty = JSON.stringify(plan) !== app.saved;
  renderProjects();
  toast('Ölçüler uygulandı' + (app.dirty ? ' — kaydetmeyi unutma' : ''));
}

function revertEdits() {
  const plan = JSON.parse(app.saved);
  $('planJson').value = JSON.stringify(plan, null, 2);
  $('editErr').textContent = '';
  rebuild(plan);
  app.dirty = false;
  renderProjects();
  toast('Son kayda dönüldü');
}

/* ---------- yürüyüş kontrolü ---------- */

function applyLook() {
  camera.quaternion.setFromEuler(new THREE.Euler(app.pitch, app.yaw, 0, 'YXZ'));
}

/** Dokunmatik cihaz mı? Fare kilidi yerine sanal kumanda kullanılır. */
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

canvas.addEventListener('click', () => {
  if (isTouch) return;
  if (app.mode === 'walk' && !document.pointerLockElement) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  app.locked = document.pointerLockElement === canvas;
  $('crosshair').style.display = app.locked ? 'block' : 'none';
});
document.addEventListener('mousemove', (e) => {
  if (!app.locked) return;
  app.yaw -= e.movementX * 0.0022;
  app.pitch = Math.max(-1.35, Math.min(1.35, app.pitch - e.movementY * 0.0022));
  applyLook();
});

/* ---------- dokunmatik kontrol ----------
   Ekranın solu: sanal kumanda kolu (hareket). Sağı: sürükleyerek bakış.
   İki parmak aynı anda kullanılabilir; her parmak kendi işini sürdürür. */

const touch = { moveId: null, lookId: null, origin: null, last: null };

function stickShow(x, y) {
  const s = $('stick');
  s.style.left = `${x}px`;
  s.style.top = `${y}px`;
  s.classList.add('on');
  $('stickKnob').style.transform = 'translate(0,0)';
}
function stickMove(dx, dy) {
  const max = 46;
  const d = Math.hypot(dx, dy);
  const k = d > max ? max / d : 1;
  $('stickKnob').style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  app.touchMove = { x: (dx * k) / max, z: (dy * k) / max };
}
function stickHide() {
  $('stick').classList.remove('on');
  app.touchMove = null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || app.mode !== 'walk') return;
  // Safari bazı durumlarda yakalamayı reddediyor; kontrol bundan bağımsız çalışmalı
  try { canvas.setPointerCapture(e.pointerId); } catch { /* yoksay */ }
  if (e.clientX < innerWidth * 0.45 && touch.moveId === null) {
    touch.moveId = e.pointerId;
    touch.origin = { x: e.clientX, y: e.clientY };
    stickShow(e.clientX, e.clientY);
  } else if (touch.lookId === null) {
    touch.lookId = e.pointerId;
    touch.last = { x: e.clientX, y: e.clientY };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') return;
  if (e.pointerId === touch.moveId && touch.origin) {
    stickMove(e.clientX - touch.origin.x, e.clientY - touch.origin.y);
  } else if (e.pointerId === touch.lookId && touch.last) {
    app.yaw -= (e.clientX - touch.last.x) * 0.005;
    app.pitch = Math.max(-1.35, Math.min(1.35, app.pitch - (e.clientY - touch.last.y) * 0.005));
    touch.last = { x: e.clientX, y: e.clientY };
    applyLook();
  }
});

const endTouch = (e) => {
  if (e.pointerId === touch.moveId) { touch.moveId = null; touch.origin = null; stickHide(); }
  if (e.pointerId === touch.lookId) { touch.lookId = null; touch.last = null; }
};
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  canvas.addEventListener(ev, endTouch);
}

/* ---------- mobil arayüz ---------- */

/** Alttan açılan sayfalar aynı anda yalnız biri açık kalsın. */
function openSheet(id) {
  const sheets = ['projects', 'editor', 'importer', 'top'];
  const el = $(id);
  const wasOpen = el.classList.contains('open');
  for (const s of sheets) if (s !== id) $(s).classList.remove('open');
  el.classList.toggle('open', !wasOpen);
}

function initMobile() {
  $('menuBtn').addEventListener('click', () => openSheet('top'));
  $('mProjBtn').addEventListener('click', () => openSheet('projects'));
  $('mInfoBtn').addEventListener('click', () => $('info').classList.toggle('open'));
  $('mDoorBtn').addEventListener('click', toggleNearestDoor);
  $('mCeilBtn').addEventListener('click', () => setCeiling(!app.ceilingOpen));
  $('mModeBtn').addEventListener('click', () => setMode(app.mode === 'walk' ? 'orbit' : 'walk'));
  // menüden bir şey seçilince çekmece kapansın
  $('top').addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') $('top').classList.remove('open');
  });
}

/** Mobilde alt çubuğun durumunu sahneyle eşitler. */
function syncMobileBar() {
  $('mModeBtn').textContent = app.mode === 'walk' ? 'Maket' : 'Yürü';
  $('mDoorBtn').style.display = app.mode === 'walk' ? '' : 'none';
}

const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); saveProject(); return; }
  if (typing()) return;
  app.keys.add(e.code);
  if (e.code === 'KeyV') setMode(app.mode === 'walk' ? 'orbit' : 'walk');
  if (e.code === 'KeyE') toggleNearestDoor();
  if (e.code === 'KeyT') setCeiling(!app.ceilingOpen);
  if (e.code === 'KeyH') exportHMI();
  if (e.code === 'KeyR') resetCamera();
});
addEventListener('keyup', (e) => app.keys.delete(e.code));
addEventListener('beforeunload', (e) => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });

function toggleNearestDoor() {
  if (!app.current) return;
  let best = null, bd = 2.2;
  const p = new THREE.Vector3();
  for (const d of app.current.registry.doors) {
    d.hinge.getWorldPosition(p);
    const dist = p.distanceTo(camera.position);
    if (dist < bd) { bd = dist; best = d; }
  }
  if (best) best.target = best.target > 0.5 ? 0 : 1;
}

/* ---------- HMI ---------- */

function makeHMI() {
  const px = Number($('hmiRes').value) || 160;
  const bg = renderHMIBackground(renderer, scene, app.current.root, app.cfg, px);
  return { bg, svg: buildHMISVG(app.cfg, bg), tags: buildTagMap(app.cfg) };
}

function download(name, data, type) {
  const blob = (data instanceof Blob) ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportHMI() {
  if (!app.current) return;
  const { bg, svg, tags } = makeHMI();
  const id = app.projectId;
  fetch(bg.dataURL).then((r) => r.blob()).then((b) => download(`${id}-hmi-bg.png`, b, 'image/png'));
  download(`${id}-hmi-layers.svg`, svg, 'image/svg+xml');
  download(`${id}-hmi-tags.json`, JSON.stringify({
    plan: id, pxPerM: bg.pxPerM, width: bg.width, height: bg.height, bounds: bg.bounds, tags,
  }, null, 2), 'application/json');
  toast(`İndirildi — ${bg.width}×${bg.height} px, ${tags.length} etiket`);
}

async function publishHMI() {
  if (!app.online) return toast('Sunucu bağlantısı yok');
  try {
    const { bg, svg, tags } = makeHMI();
    const res = await api.publishHMI(app.projectId, { png: bg.dataURL, svg, tags });
    const url = new URL(res.view, location.href).href;
    await refreshProjects();
    toast(`HMI yayınlandı: ${url}`);
    console.log('[cleanai] HMI adresleri:', {
      ekran: url,
      png: new URL(res.png, location.href).href,
      svg: new URL(res.svg, location.href).href,
      tags: new URL(res.tags, location.href).href,
    });
  } catch (e) { toast('Yayınlanamadı: ' + e.message); }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ---------- lejant ---------- */

function buildLegend(cfg) {
  const b = planBounds(cfg, 0);
  const rows = cfg.zones.map((z) => {
    let a = 0;
    const p = z.polygon;
    for (let i = 0; i < p.length; i++) {
      const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % p.length];
      a += x1 * z2 - x2 * z1;
    }
    return `<div class="row"><b>${escapeHtml(z.name)}</b><span>${z.class || ''} · ${Math.abs(a / 2).toFixed(1)} m² · +${z.pressurePa ?? 0} Pa</span></div>`;
  });
  rows.push(`<div class="row"><b>Dış ölçü</b><span>${b.w.toFixed(2)} × ${b.h.toFixed(2)} m · h=${cfg.wallHeight} m</span></div>`);
  $('legend').innerHTML = rows.join('');
}

/* ---------- döngü ---------- */

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);

  animateCeiling(dt);

  if (app.current) {
    for (const d of app.current.registry.doors) {
      if (Math.abs(d.open - d.target) > 0.001) {
        d.open += Math.sign(d.target - d.open) * Math.min(dt * 2.2, Math.abs(d.target - d.open));
        d.hinge.rotation.y = -d.open * Math.PI * 0.52;
      }
    }
  }

  if (app.mode === 'walk' && app.current) {
    const sp = (app.keys.has('ShiftLeft') || app.keys.has('ShiftRight')) ? RUN : SPEED;
    let fx = 0, fz = 0;
    if (app.keys.has('KeyW')) fz -= 1;
    if (app.keys.has('KeyS')) fz += 1;
    if (app.keys.has('KeyA')) fx -= 1;
    if (app.keys.has('KeyD')) fx += 1;
    if (app.touchMove) { fx += app.touchMove.x; fz += app.touchMove.z; }
    // kumanda kolu yarım itildiğinde yarım hız: uzunluğu 1'e kırpıyoruz, bölmüyoruz
    const l = Math.max(1, Math.hypot(fx, fz));
    const sin = Math.sin(app.yaw), cos = Math.cos(app.yaw);
    // kamera yaw=0'da -Z'ye bakar; ileri = (-sin, -cos), sağ = (cos, -sin)
    const dx = ((fx / l) * cos + (fz / l) * sin) * sp * dt;
    const dz = ((-fx / l) * sin + (fz / l) * cos) * sp * dt;

    const p = camera.position, reg = app.current.registry;
    if (!blocked(reg, p.x + dx, p.z, RADIUS)) p.x += dx;
    if (!blocked(reg, p.x, p.z + dz, RADIUS)) p.z += dz;
    const targetY = app.keys.has('KeyC') ? 1.15 : EYE;
    p.y += (targetY - p.y) * Math.min(1, dt * 8);
  } else {
    orbit.update();
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

/* ---------- bağlama ---------- */

document.querySelectorAll('[data-mode]').forEach((el) =>
  el.addEventListener('click', () => setMode(el.dataset.mode)));
$('exportBtn').addEventListener('click', exportHMI);
$('publishBtn').addEventListener('click', publishHMI);
$('ceilBtn').addEventListener('click', () => setCeiling(!app.ceilingOpen));
$('editBtn').addEventListener('click', () => toggleEditor());
$('editClose').addEventListener('click', () => toggleEditor(false));
$('applyBtn').addEventListener('click', applyEdits);
$('revertBtn').addEventListener('click', revertEdits);
$('saveBtn').addEventListener('click', saveProject);
$('saveAsBtn').addEventListener('click', saveProjectAs);
$('delBtn').addEventListener('click', deleteProject);

initImporter({
  toast,
  onPlan: async (plan, name) => {
    if (!app.online) return toast('Sunucu bağlantısı yok — proje kaydedilemez');
    try {
      const rec = await api.create({ name, plan });
      await refreshProjects();
      await openProject(rec.id);
      toast(`Oda oluşturuldu ve kaydedildi — ${rec.name}`);
    } catch (e) { toast('Kaydedilemedi: ' + e.message); }
  },
});

initMobile();

// adres çubuğu gizlenince/ekran döndürülünce tuvali yeniden boyutlandır
addEventListener('orientationchange', () => setTimeout(resize, 250));
visualViewport?.addEventListener('resize', resize);

(async () => {
  try {
    await refreshProjects();
    await openProject(app.projects[0]?.id || 'plan-b');
    setMode('walk');
    resize();
    tick();
  } catch (err) {
    $('hint').textContent = 'Hata: ' + err.message + ' — sayfayı sunucu üzerinden aç (npm start).';
    console.error(err);
  }
})();
