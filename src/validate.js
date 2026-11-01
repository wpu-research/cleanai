// CleanAi — plan doğrulama. Saf JS: hem tarayıcı, hem sunucu, hem test kullanır.
// Hata listesi döner; boş dizi = geçerli.

export function validatePlan(plan) {
  const e = [];
  if (!plan || typeof plan !== 'object') return ['Plan bir nesne değil'];

  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  if (!num(plan.wallHeight) || plan.wallHeight <= 0) e.push('wallHeight pozitif bir sayı olmalı');
  if (!num(plan.wallThickness) || plan.wallThickness <= 0) e.push('wallThickness pozitif bir sayı olmalı');

  if (!Array.isArray(plan.zones) || !plan.zones.length) {
    e.push('En az bir bölge (zones) gerekli');
  } else {
    plan.zones.forEach((z, i) => {
      if (!z.id) e.push(`zones[${i}] için id gerekli`);
      if (!Array.isArray(z.polygon) || z.polygon.length < 3) {
        e.push(`${z.id || `zones[${i}]`}: polygon en az 3 nokta olmalı`);
      } else if (!z.polygon.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]))) {
        e.push(`${z.id || `zones[${i}]`}: polygon noktaları [x, z] sayı çifti olmalı`);
      }
    });
    const ids = plan.zones.map((z) => z.id);
    if (new Set(ids).size !== ids.length) e.push('Bölge id\'leri benzersiz olmalı');
  }

  if (!Array.isArray(plan.walls) || !plan.walls.length) {
    e.push('En az bir duvar (walls) gerekli');
    return e;
  }

  const openingIds = [];
  plan.walls.forEach((w, i) => {
    const tag = `walls[${i}]`;
    const okPt = (p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
    if (!okPt(w.a) || !okPt(w.b)) { e.push(`${tag}: a ve b [x, z] sayı çifti olmalı`); return; }
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (len < 0.01) { e.push(`${tag}: duvar uzunluğu sıfır`); return; }

    const ops = (w.openings || []).slice().sort((p, q) => p.center - q.center);
    let prev = -Infinity;
    for (const o of ops) {
      const name = o.id || `${tag} açıklık`;
      openingIds.push(o.id);
      if (!['door', 'passbox', 'window'].includes(o.type)) {
        e.push(`${name}: type door | passbox | window olmalı`);
      }
      if (!num(o.center) || !num(o.w) || !num(o.h) || !num(o.sill)) {
        e.push(`${name}: center, w, h, sill sayı olmalı`); continue;
      }
      const t0 = o.center - o.w / 2, t1 = o.center + o.w / 2;
      if (t0 < -1e-6 || t1 > len + 1e-6) {
        e.push(`${name}: duvarın dışına taşıyor (${t0.toFixed(2)}–${t1.toFixed(2)} m, duvar ${len.toFixed(2)} m)`);
      }
      if (t0 < prev - 1e-6) e.push(`${name}: önceki açıklıkla çakışıyor`);
      prev = t1;
      if (o.sill < -1e-6) e.push(`${name}: sill negatif olamaz`);
      if (num(plan.wallHeight) && o.sill + o.h > plan.wallHeight + 1e-6) {
        e.push(`${name}: tavanı aşıyor (${(o.sill + o.h).toFixed(2)} m > ${plan.wallHeight} m)`);
      }
    }
  });

  const seen = openingIds.filter(Boolean);
  if (new Set(seen).size !== seen.length) e.push('Açıklık (kapı/pass-box) id\'leri benzersiz olmalı');

  if (plan.spawn && !(num(plan.spawn.x) && num(plan.spawn.z))) {
    e.push('spawn.x ve spawn.z sayı olmalı');
  }
  return e;
}
