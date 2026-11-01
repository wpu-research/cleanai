// Sunucu uçtan uca testi: proje CRUD, doğrulama, HMI yayınlama.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import net from 'node:net';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanai-test-'));
// boş port seç — sabit port başka bir geliştirme sunucusuna çarpabiliyor
const PORT = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const base = `http://127.0.0.1:${PORT}`;
let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; };

const srv = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, DATA_DIR, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'],
});
srv.on('exit', (c) => { if (c) { console.log(`  FAIL sunucu ${c} koduyla çıktı`); process.exit(1); } });
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};
const j = async (u, o) => { const r = await fetch(base + u, o); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { console.log('   ↳ JSON değil:', r.status, t.slice(0,200)); return { s: r.status, b: null }; } };
const J = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  const health = await until(async () => {
    const r = await fetch(base + '/api/health');
    return r.ok && (await r.json()).ok === true;
  });
  ok(health, `sunucu ayağa kalktı (port ${PORT})`);

  let r = await j('/api/projects');
  ok(r.s === 200 && r.b.length === 2, `başlangıç planları tohumlandı (${r.b?.length})`);
  ok(r.b.every((p) => p.area > 0), 'liste alan hesabı içeriyor');

  r = await j('/api/projects/plan-b');
  ok(r.s === 200 && r.b.plan.zones.length === 2, 'tek proje okunuyor');
  const plan = r.b.plan;

  ok((await j('/api/projects/yok-boyle')).s === 404, 'olmayan proje 404');
  ok((await j('/api/projects/..%2Fetc')).s === 404, 'yol gezinme denemesi reddedildi');

  // oluştur
  r = await j('/api/projects', J({ name: 'Müşteri A — 1. Kat', plan }));
  ok(r.s === 201 && r.b.id === 'musteri-a-1-kat', `proje oluşturuldu, id slug'landı (${r.b?.id})`);
  const id = r.b.id;

  // geçersiz plan reddedilmeli
  const bad = structuredClone(plan);
  bad.walls[3].openings[0].center = 99;
  r = await j('/api/projects', J({ name: 'Bozuk', plan: bad }));
  ok(r.s === 400 && /taşıyor/.test(r.b.details?.join(' ') || ''), 'duvar dışına taşan kapı reddedildi');
  ok((await j('/api/projects', J({ plan }))).s === 400, 'adsız proje reddedildi');

  // güncelle
  const edited = structuredClone(plan);
  edited.wallHeight = 3.0;
  r = await j(`/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: edited }) });
  ok(r.s === 200 && r.b.version === 2 && r.b.plan.wallHeight === 3.0, 'güncelleme kaydedildi, sürüm arttı');
  r = await j(`/api/projects/${id}`);
  ok(r.b.plan.wallHeight === 3.0, 'değişiklik diske yazıldı');

  // HMI yayınlama
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await j(`/api/projects/${id}/hmi`, J({ png, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', tags: [{ svgId: 'door-D1' }] }));
  ok(r.s === 200 && r.b.view === `/hmi/${id}/`, 'HMI yayınlandı, sabit adres döndü');
  let raw = await fetch(`${base}/hmi/${id}/bg.png`);
  ok(raw.ok && raw.headers.get('content-type').includes('png'), 'PNG sabit adresten servis ediliyor');
  raw = await fetch(`${base}/hmi/${id}/layers.svg`);
  ok(raw.ok && raw.headers.get('content-type').includes('svg'), 'SVG sabit adresten servis ediliyor');
  raw = await fetch(`${base}/hmi/${id}/`);
  const html = await raw.text();
  ok(raw.ok && html.includes('./bg.png') && html.includes('./layers.svg'), 'hazır HMI ekranı iki katmanı da bindiriyor');
  raw = await fetch(`${base}/hmi/plan-a/`);
  ok(raw.status === 404, 'HMI üretilmemiş projede anlaşılır 404');

  r = await j('/api/projects');
  ok(r.b.find((p) => p.id === id).hasHMI === true, 'listede HMI durumu görünüyor');

  // sil
  ok((await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' })).ok, 'proje silindi');
  ok((await j(`/api/projects/${id}`)).s === 404, 'silinen proje gitti');
  ok(!fs.existsSync(path.join(DATA_DIR, 'projects', `${id}.hmi.png`)), 'HMI dosyaları da temizlendi');

  // statik
  raw = await fetch(base + '/');
  ok(raw.ok && (await raw.text()).includes('CleanAi'), '3D arayüz servis ediliyor');
  ok((await fetch(base + '/src/build.js')).ok, 'modüller servis ediliyor');
} finally {
  srv.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
console.log(fail ? `\n${fail} test başarısız` : '\nAPI testleri geçti');
process.exit(fail ? 1 : 0);
