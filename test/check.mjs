import fs from 'fs';
import { buildHMISVG, buildTagMap, planBounds } from '../src/hmi.js';
import { blocked } from '../src/build.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; };

for (const id of ['plan-a', 'plan-b']) {
  const cfg = JSON.parse(fs.readFileSync(new URL(`../data/${id}.json`, import.meta.url)));
  console.log('\n== ' + cfg.name);

  // 1. açıklıklar duvar uzunluğunun içinde mi, çakışıyor mu?
  for (const w of cfg.walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const ops = (w.openings || []).slice().sort((a, b) => a.center - b.center);
    let prev = 0;
    for (const o of ops) {
      const t0 = o.center - o.w / 2, t1 = o.center + o.w / 2;
      ok(t0 >= -1e-6 && t1 <= len + 1e-6, `${o.id} duvar içinde (${t0.toFixed(2)}..${t1.toFixed(2)} / ${len.toFixed(2)} m)`);
      ok(t0 >= prev - 1e-6, `${o.id} önceki açıklıkla çakışmıyor`);
      ok(o.sill + o.h <= cfg.wallHeight + 1e-6, `${o.id} tavanı aşmıyor`);
      prev = t1;
    }
  }

  // 2. spawn noktası bir bölgenin içinde ve duvara girmemiş
  const reg = { cfg, walls: cfg.walls, doors: cfg.walls.flatMap(w => (w.openings||[]).filter(o=>o.type==='door').map(o=>({id:o.id,open:0}))) };
  ok(!blocked(reg, cfg.spawn.x, cfg.spawn.z, 0.32), 'spawn noktası duvar içinde değil');

  // 3. kapalı kapıdan geçilemiyor, açık kapıdan geçiliyor
  const d = cfg.walls.flatMap(w => (w.openings||[]).map(o => ({w,o}))).find(x => x.o.type === 'door');
  const { w, o } = d;
  const L = Math.hypot(w.b[0]-w.a[0], w.b[1]-w.a[1]);
  const ux = (w.b[0]-w.a[0])/L, uz = (w.b[1]-w.a[1])/L;
  const cx = w.a[0] + ux*o.center, cz = w.a[1] + uz*o.center;
  ok(blocked(reg, cx, cz, 0.32), `${o.id} kapalıyken geçilemiyor`);
  reg.doors.find(q => q.id === o.id).open = 1;
  ok(!blocked(reg, cx, cz, 0.32), `${o.id} açıkken geçilebiliyor`);

  // 4. HMI SVG üretimi + hizalama
  const b = planBounds(cfg);
  const bg = { bounds: b, width: Math.round(b.w*160), height: Math.round(b.h*160), pxPerM: 160 };
  const svg = buildHMISVG(cfg, bg);
  ok(svg.startsWith('<svg') && svg.trim().endsWith('</svg>'), 'SVG iyi biçimli başlıyor/bitiyor');
  ok(svg.includes(`viewBox="${b.minX.toFixed(3)} ${b.minZ.toFixed(3)}`), 'viewBox plan koordinatlarıyla aynı');
  const ids = [...svg.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  ok(new Set(ids).size === ids.length, `SVG id'leri benzersiz (${ids.length} adet)`);
  const tags = buildTagMap(cfg);
  const missing = tags.filter(t => !ids.includes(t.svgId));
  ok(missing.length === 0, `tag eşlemesindeki ${tags.length} id'nin hepsi SVG'de var` + (missing.length ? ' → eksik: ' + missing.map(m=>m.svgId) : ''));
  for (const l of ['zones','doors','passboxes','hepa','lights','return','sensors'])
    ok(svg.includes(`id="layer-${l}"`), `katman var: ${l}`);

  fs.mkdirSync(new URL('../hmi/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL(`../hmi/${id}-hmi-layers.svg`, import.meta.url), svg);
  fs.writeFileSync(new URL(`../hmi/${id}-hmi-tags.json`, import.meta.url),
    JSON.stringify({ plan: id, pxPerM: 160, width: bg.width, height: bg.height, bounds: b, tags }, null, 2));
}
console.log(fail ? `\n${fail} test başarısız` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
