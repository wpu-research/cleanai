// CleanAi — proje kayıt sunucusu.
// Projeler dosya tabanlı tutulur (Railway'de kalıcı disk: DATA_DIR=/data).
import express from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePlan } from './src/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'storage');
const PROJ_DIR = path.join(DATA_DIR, 'projects');
const PORT = process.env.PORT || 5177;

await fs.mkdir(PROJ_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '24mb' }));

/* ---------- yardımcılar ---------- */

const slug = (s) => (s || 'proje').toString().toLowerCase()
  .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
  .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'proje';

const projFile = (id) => path.join(PROJ_DIR, `${id}.json`);
const assetFile = (id, name) => path.join(PROJ_DIR, `${id}.${name}`);

function safeId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '')) return null;
  return id;
}

async function readProject(id) {
  try { return JSON.parse(await fs.readFile(projFile(id), 'utf8')); }
  catch { return null; }
}

/* ---------- ilk açılışta hazır planları tohumla ---------- */

async function seed() {
  const existing = (await fs.readdir(PROJ_DIR)).filter((f) => f.endsWith('.json') && !f.includes('.hmi.'));
  if (existing.length) return;
  for (const base of ['plan-a', 'plan-b']) {
    const plan = JSON.parse(await fs.readFile(path.join(__dirname, 'data', `${base}.json`), 'utf8'));
    const now = new Date().toISOString();
    const rec = {
      id: base, name: plan.name, note: 'Teknik çizimden türetilen başlangıç planı',
      plan, createdAt: now, updatedAt: now, version: 1,
    };
    await fs.writeFile(projFile(base), JSON.stringify(rec, null, 2));
  }
  console.log('[cleanai] başlangıç planları oluşturuldu');
}
await seed();

/* ---------- API ---------- */

app.get('/api/health', (_q, r) => r.json({ ok: true, dataDir: DATA_DIR }));

app.get('/api/projects', async (_q, r) => {
  const files = (await fs.readdir(PROJ_DIR)).filter((f) => f.endsWith('.json') && !f.includes('.hmi.'));
  const list = [];
  for (const f of files) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(PROJ_DIR, f), 'utf8'));
      const zones = p.plan?.zones || [];
      list.push({
        id: p.id, name: p.name, note: p.note || '', version: p.version || 1,
        createdAt: p.createdAt, updatedAt: p.updatedAt,
        zoneCount: zones.length,
        area: +zones.reduce((a, z) => a + polyArea(z.polygon), 0).toFixed(1),
        hasHMI: fssync.existsSync(assetFile(p.id, 'hmi.png')),
      });
    } catch { /* bozuk dosyayı atla */ }
  }
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  r.json(list);
});

function polyArea(poly = []) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a / 2);
}

app.get('/api/projects/:id', async (q, r) => {
  const id = safeId(q.params.id);
  const p = id && await readProject(id);
  if (!p) return r.status(404).json({ error: 'Proje bulunamadı' });
  r.json(p);
});

app.post('/api/projects', async (q, r) => {
  const { name, plan, note } = q.body || {};
  if (!name) return r.status(400).json({ error: 'Proje adı gerekli' });
  const errs = validatePlan(plan);
  if (errs.length) return r.status(400).json({ error: 'Plan geçersiz', details: errs });

  let id = slug(name);
  if (await readProject(id)) id = `${id}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const rec = { id, name, note: note || '', plan, createdAt: now, updatedAt: now, version: 1 };
  await fs.writeFile(projFile(id), JSON.stringify(rec, null, 2));
  r.status(201).json(rec);
});

app.put('/api/projects/:id', async (q, r) => {
  const id = safeId(q.params.id);
  const cur = id && await readProject(id);
  if (!cur) return r.status(404).json({ error: 'Proje bulunamadı' });
  const { name, plan, note } = q.body || {};
  if (plan) {
    const errs = validatePlan(plan);
    if (errs.length) return r.status(400).json({ error: 'Plan geçersiz', details: errs });
  }
  const rec = {
    ...cur,
    name: name ?? cur.name,
    note: note ?? cur.note,
    plan: plan ?? cur.plan,
    updatedAt: new Date().toISOString(),
    version: (cur.version || 1) + 1,
  };
  await fs.writeFile(projFile(id), JSON.stringify(rec, null, 2));
  r.json(rec);
});

app.delete('/api/projects/:id', async (q, r) => {
  const id = safeId(q.params.id);
  if (!id || !await readProject(id)) return r.status(404).json({ error: 'Proje bulunamadı' });
  await fs.unlink(projFile(id));
  for (const a of ['hmi.png', 'hmi.svg', 'hmi.tags.json']) {
    await fs.unlink(assetFile(id, a)).catch(() => {});
  }
  r.json({ ok: true });
});

/* ---------- HMI çıktısı: PLC'nin çekeceği sabit adres ---------- */

app.post('/api/projects/:id/hmi', async (q, r) => {
  const id = safeId(q.params.id);
  if (!id || !await readProject(id)) return r.status(404).json({ error: 'Proje bulunamadı' });
  const { png, svg, tags } = q.body || {};
  if (!png || !svg) return r.status(400).json({ error: 'png ve svg gerekli' });
  const b64 = String(png).replace(/^data:image\/png;base64,/, '');
  await fs.writeFile(assetFile(id, 'hmi.png'), Buffer.from(b64, 'base64'));
  await fs.writeFile(assetFile(id, 'hmi.svg'), svg);
  await fs.writeFile(assetFile(id, 'hmi.tags.json'), JSON.stringify(tags ?? [], null, 2));
  r.json({
    ok: true,
    png: `/hmi/${id}/bg.png`,
    svg: `/hmi/${id}/layers.svg`,
    tags: `/hmi/${id}/tags.json`,
    view: `/hmi/${id}/`,
  });
});

const ASSETS = {
  'bg.png': ['hmi.png', 'image/png'],
  'layers.svg': ['hmi.svg', 'image/svg+xml'],
  'tags.json': ['hmi.tags.json', 'application/json'],
};

app.get('/hmi/:id/:asset', async (q, r, next) => {
  const id = safeId(q.params.id);
  const a = ASSETS[q.params.asset];
  if (!id || !a) return next();
  const f = assetFile(id, a[0]);
  if (!fssync.existsSync(f)) return r.status(404).send('HMI çıktısı henüz üretilmedi');
  r.type(a[1]);
  r.setHeader('Cache-Control', 'no-cache');
  fssync.createReadStream(f).pipe(r);
});

/** PLC tarayıcısının doğrudan açabileceği, katmanlar bindirilmiş hazır ekran. */
app.get('/hmi/:id/', async (q, r) => {
  const id = safeId(q.params.id);
  const p = id && await readProject(id);
  if (!p) return r.status(404).send('Proje bulunamadı');
  if (!fssync.existsSync(assetFile(id, 'hmi.png'))) {
    return r.status(404).send('Bu proje için HMI çıktısı henüz üretilmedi (3D ekranda "HMI kaydet").');
  }
  r.type('html').send(`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.name} — HMI</title>
<style>html,body{margin:0;height:100%;background:#0e1418;display:grid;place-items:center}
.wrap{position:relative;max-width:100vw;max-height:100vh}
img,object{display:block;width:100%;height:auto}
object{position:absolute;inset:0;pointer-events:none}</style></head>
<body><div class="wrap">
<img src="./bg.png" alt="${p.name}">
<object data="./layers.svg" type="image/svg+xml"></object>
</div></body></html>`);
});

/* ---------- statik ---------- */

app.use(express.static(__dirname, {
  index: 'index.html',
  setHeaders: (res, f) => {
    if (f.endsWith('.json') || f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.listen(PORT, () => console.log(`[cleanai] http://localhost:${PORT} — veri: ${DATA_DIR}`));
