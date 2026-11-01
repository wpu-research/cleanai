// Teknik çizim içe aktarma testi — gerçek çizimler (samples/) üzerinde çalışır.
import { decodePNG } from './png.mjs';
import { detectPlan, toPlan, binarize, simplifyPolygon } from '../src/import.js';
import { validatePlan } from '../src/validate.js';
import { inwardSign } from '../src/build.js';

/** Pass-box kabini duvarın oda tarafına mı taşıyor? */
function passboxesFaceInside(plan) {
  const inPoly = (poly, x, z) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const out = [];
  for (const w of plan.walls) {
    for (const o of (w.openings || []).filter((q) => q.type === 'passbox')) {
      const sgn = inwardSign(plan, w);
      const ang = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]);
      const fx = w.a[0] + Math.cos(ang) * o.center - Math.sin(ang) * sgn * 0.3;
      const fz = w.a[1] + Math.sin(ang) * o.center + Math.cos(ang) * sgn * 0.3;
      const zone = plan.zones.find((z) => z.id === w.zone);
      out.push({ id: o.id, zone: zone?.name, inside: zone ? inPoly(zone.polygon, fx, fz) : false });
    }
  }
  return out;
}

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const url = (p) => new URL(p, import.meta.url);

/* --- Plan A: ince çizgili temiz CAD çıktısı, tam isabet beklenir --- */

console.log('\n== Plan A çizimi (kare oda + koridor)');
{
  const img = decodePNG(url('../samples/cizim-plan-a.png'));
  ok(img.width === 978 && img.height === 694, `çizim çözüldü (${img.width}×${img.height})`);

  const det = detectPlan(img);
  ok(det.rooms.length === 2, `2 oda bulundu (${det.rooms.length})`);
  ok(det.segs.length === 5, `5 duvar bulundu — dış 4 + bölme (${det.segs.length})`);
  ok(det.rooms.every((r) => r.polygon.length === 4), 'her iki oda da dörtgen');

  const doors = det.openings.filter((o) => o.type === 'door');
  const pbs = det.openings.filter((o) => o.type === 'passbox');
  ok(doors.length === 2, `2 kapı bulundu (${doors.length})`);
  ok(pbs.length === 2, `2 pass-box bulundu (${pbs.length})`);
  ok(doors.every((d) => d.confidence >= 0.9), 'kapı yayları yüksek güvenle tanındı');

  // büyük oda küçüğünden geniş olmalı (temiz oda vs koridor)
  const [big, small] = det.rooms;
  ok(big.areaPx > small.areaPx * 1.5, 'temiz oda koridordan belirgin büyük');

  const plan = toPlan(det, { widthMeters: 7.0, wallHeight: 2.7, name: 'Plan A testi' });
  ok(validatePlan(plan).length === 0, 'üretilen plan doğrulamadan geçti');
  ok(plan.zones.length === 2, 'planda 2 bölge');

  const allOps = plan.walls.flatMap((w) => w.openings);
  ok(allOps.length === 4, `planda 4 açıklık (${allOps.length})`);
  ok(allOps.every((o) => o.w >= 0.6 && o.w <= 1.3), 'açıklık genişlikleri makul aralıkta');
  ok(allOps.filter((o) => o.type === 'door').every((o) => o.h === 2.1 && o.sill === 0),
    'kapılar 2.10 m, eşiksiz');
  ok(allOps.filter((o) => o.type === 'passbox').every((o) => o.sill === 0.9),
    'pass-box\'lar 0.90 m yüksekliğe oturdu');

  // Ölçek: verilen genişlik duvarların DIŞ yüzleri arası; bölge poligonları ise
  // duvar ekseninde olduğu için bir duvar kalınlığı kadar küçük olmalı.
  const span = (pl) => {
    const xs = pl.zones.flatMap((z) => z.polygon.map((p) => p[0]));
    return Math.max(...xs) - Math.min(...xs);
  };
  ok(near(span(plan), 7.0 - plan.wallThickness, 0.12),
    `eksen genişliği dış ölçü eksi duvar kalınlığı (${span(plan).toFixed(2)} ≈ ${(7 - plan.wallThickness).toFixed(2)})`);

  const area = plan.zones.reduce((a, z) => {
    let s = 0;
    for (let i = 0; i < z.polygon.length; i++) {
      const [x1, y1] = z.polygon[i], [x2, y2] = z.polygon[(i + 1) % z.polygon.length];
      s += x1 * y2 - x2 * y1;
    }
    return a + Math.abs(s / 2);
  }, 0);
  ok(area > 30 && area < 55, `toplam alan makul (${area.toFixed(1)} m²)`);

  ok(plan.ceiling.hepa.length > 0 && plan.ceiling.lights.length > 0, 'tavan ekipmanı üretildi');
  ok(plan.sensors.length === plan.zones.length, 'her bölgeye bir ΔP sensörü');
  ok(plan.walls.every((w) => w.zone), 'her duvar bir bölgeye bağlandı');

  const facing = passboxesFaceInside(plan);
  ok(facing.length === 2, `2 pass-box yön denetimine girdi (${facing.length})`);
  ok(facing.every((f) => f.inside),
    'pass-box kabinleri oda içine bakıyor: ' + facing.map((f) => `${f.id}→${f.zone}`).join(', '));

  // farklı ölçek verildiğinde her şey orantılı büyümeli
  const big2 = toPlan(det, { widthMeters: 14.0 });
  ok(near(span(big2), span(plan) * 2, 0.1),
    `ölçek iki katına çıkınca oda da iki katı (${span(plan).toFixed(2)} → ${span(big2).toFixed(2)})`);
  ok(validatePlan(big2).length === 0, 'ölçek değişince de plan geçerli');
}

/* --- Plan B: kalın dolu duvarlı çizim; her koşulda geçerli plan üretmeli --- */

console.log('\n== Plan B çizimi (L oda + soyunma)');
{
  const img = decodePNG(url('../samples/cizim-plan-b.png'));
  const det = detectPlan(img);
  ok(det.rooms.length === 2, `2 oda bulundu (${det.rooms.length})`);
  const big = det.rooms[0].polygon;
  ok(big.length >= 6, `büyük oda L biçiminde algılandı (${big.length} köşe)`);

  const plan = toPlan(det, { widthMeters: 12.0, name: 'Plan B testi' });
  ok(validatePlan(plan).length === 0, 'üretilen plan doğrulamadan geçti');
  ok(plan.walls.flatMap((w) => w.openings).length >= 1, 'en az bir açıklık çıkarıldı');
  const facingB = passboxesFaceInside(plan);
  ok(facingB.every((f) => f.inside),
    `pass-box kabinleri oda içine bakıyor (${facingB.length} adet)`);
}

/* --- dayanıklılık: bozuk/zor girdilerde çökmemeli --- */

console.log('\n== Dayanıklılık');
{
  const blank = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(255) };
  const det = detectPlan(blank);
  ok(det.rooms.length === 0, 'boş sayfada oda bulunmuyor, çökmüyor');

  const noisy = { width: 120, height: 120, data: new Uint8ClampedArray(120 * 120 * 4) };
  for (let i = 0; i < noisy.data.length; i += 4) {
    const v = Math.random() * 255;
    noisy.data[i] = noisy.data[i + 1] = noisy.data[i + 2] = v;
    noisy.data[i + 3] = 255;
  }
  ok(detectPlan(noisy).rooms !== undefined, 'gürültülü görüntüde çökmüyor');

  const bin = binarize({ width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) });
  ok(bin.ink[0] === 1 && bin.ink[1] === 0, 'eşikleme koyu/açık ayrımını doğru yapıyor');

  const sq = simplifyPolygon([[0, 0], [10, 0], [10, 2], [11, 2], [11, 10], [0, 10]], 3);
  ok(sq.length <= 5, `küçük çıkıntı sadeleştirildi (${sq.length} köşe)`);
}

console.log(fail ? `\n${fail} test başarısız` : '\nİçe aktarma testleri geçti');
process.exit(fail ? 1 : 0);
