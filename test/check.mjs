import fs from 'fs';
import { buildHMISVG, buildTagMap, planBounds } from '../src/hmi.js';
import { blocked, inwardSign } from '../src/build.js';

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

  // 3b. pass-box'ların kullanım yüzü oda içine bakıyor mu?
  const inPoly = (poly, x, z) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  let pbCount = 0;
  for (const wl of cfg.walls) {
    const pbs = (wl.openings || []).filter((o) => o.type === 'passbox');
    if (!pbs.length) continue;
    const sgn = inwardSign(cfg, wl);
    const ang = Math.atan2(wl.b[1] - wl.a[1], wl.b[0] - wl.a[0]);
    const ux = Math.cos(ang), uz = Math.sin(ang);
    const nx = -Math.sin(ang) * sgn, nz = Math.cos(ang) * sgn;
    const zone = cfg.zones.find((z) => z.id === wl.zone);
    for (const o of pbs) {
      pbCount++;
      // kabinin ön yüzü: açıklık merkezinden oda yönünde yarım kabin boyu
      const fx = wl.a[0] + ux * o.center + nx * 0.3;
      const fz = wl.a[1] + uz * o.center + nz * 0.3;
      ok(inPoly(zone.polygon, fx, fz), `${o.id} kabini ${zone.name} içine taşıyor`);
      // arka yüz oda dışında kalmalı
      const bx = wl.a[0] + ux * o.center - nx * 0.3;
      const bz = wl.a[1] + uz * o.center - nz * 0.3;
      ok(!inPoly(zone.polygon, bx, bz), `${o.id} dış yüzü odanın dışında`);
    }
  }
  ok(pbCount > 0, `pass-box yönü denetlendi (${pbCount} adet)`);

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
