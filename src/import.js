// CleanAi — teknik çizimden (raster plan) otomatik plan çıkarımı.
// Saf JS, bağımlılıksız: hem tarayıcıda hem testte aynı kod çalışır.
//
// Hat: ikili eşikleme → eksen hizalı çizgi çıkarma → çift çizgileri duvara birleştirme
//      → ızgara ile oda (bölge) bulma → artık mürekkepten simge sınıflandırma
//      → ölçek uygulama → plan JSON.

const DEFAULTS = {
  threshold: 170,      // bu değerden koyu pikseller mürekkep sayılır
  minLineFrac: 0.045,  // en kısa çizgi = kenarın bu oranı
  gapTol: 2,           // çizgi içinde tolere edilen boşluk (px)
  lineBand: 3,         // aynı çizgiye ait sayılan dikey sapma (px)
  maxWallFrac: 0.025,  // çift çizgi arası en fazla bu kadarsa tek duvar sayılır
  minSymbolPx: 40,     // bu alandan küçük mürekkep kümesi gürültüdür
  minRoomFrac: 0.06,   // en büyük odanın bu oranından küçük bölgeler çizim süsüdür
};

/* ---------- 1. ikili eşikleme ---------- */

export function binarize(imageData, threshold = DEFAULTS.threshold) {
  const { width: w, height: h, data } = imageData;
  const ink = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // alfa 0 ise beyaz kabul et (şeffaf PNG)
    const a = data[i + 3];
    const lum = a < 16 ? 255 : (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    ink[p] = lum < threshold ? 1 : 0;
  }
  return { ink, w, h };
}

/* ---------- 2. eksen hizalı çizgiler ---------- */

/** Bir eksen boyunca koyu piksel dizilerini bulur. horizontal=true → satır tarar. */
function runs(bin, horizontal, minLen, gapTol) {
  const { ink, w, h } = bin;
  const outer = horizontal ? h : w;   // tarama satırı/sütunu
  const inner = horizontal ? w : h;   // tarama yönü
  const found = [];
  for (let o = 0; o < outer; o++) {
    let start = -1, gap = 0;
    for (let i = 0; i < inner; i++) {
      const on = ink[horizontal ? o * w + i : i * w + o];
      if (on) {
        if (start < 0) start = i;
        gap = 0;
      } else if (start >= 0) {
        if (++gap > gapTol) {
          const end = i - gap;
          if (end - start + 1 >= minLen) found.push({ o, a: start, b: end });
          start = -1; gap = 0;
        }
      }
    }
    if (start >= 0 && inner - gap - start >= minLen) found.push({ o, a: start, b: inner - 1 - gap });
  }
  return found;
}

/** Komşu satırlardaki örtüşen dizileri tek bir kalın çizgiye toplar. */
function clusterRuns(list, band) {
  const sorted = list.slice().sort((p, q) => p.o - q.o || p.a - q.a);
  const out = [];
  for (const r of sorted) {
    const hit = out.find((c) => {
      if (r.o - c.oMax > band) return false;
      const ov = Math.min(c.b, r.b) - Math.max(c.a, r.a);
      return ov > 0.5 * Math.min(c.b - c.a, r.b - r.a);
    });
    if (hit) {
      hit.oMax = Math.max(hit.oMax, r.o);
      hit.a = Math.min(hit.a, r.a);
      hit.b = Math.max(hit.b, r.b);
      hit.n++;
    } else {
      out.push({ oMin: r.o, oMax: r.o, a: r.a, b: r.b, n: 1 });
    }
  }
  return out.map((c) => ({ o: (c.oMin + c.oMax) / 2, a: c.a, b: c.b, t: c.oMax - c.oMin + 1 }));
}

/** Duvarı oluşturan iki paralel çizgiyi tek eksen çizgisine indirger. */
function mergeDoubles(lines, maxGap) {
  const used = new Set();
  const out = [];
  const sorted = lines.slice().sort((p, q) => p.o - q.o);
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const A = sorted[i];
    let best = -1, bestGap = Infinity;
    for (let k = i + 1; k < sorted.length; k++) {
      if (used.has(k)) continue;
      const B = sorted[k];
      const gap = B.o - A.o;
      if (gap > maxGap) break;
      const ov = Math.min(A.b, B.b) - Math.max(A.a, B.a);
      // uzun olanın da çoğunu kaplamalı: kısa bir parça duvarın ikinci çizgisi sayılmasın
      if (ov < 0.5 * Math.max(A.b - A.a, B.b - B.a)) continue;
      if (gap < bestGap) { bestGap = gap; best = k; }
    }
    if (best >= 0) {
      const B = sorted[best];
      used.add(best);
      out.push({
        o: (A.o + B.o) / 2,
        a: Math.min(A.a, B.a), b: Math.max(A.b, B.b),
        t: Math.max(2, bestGap), double: true,
      });
    } else {
      out.push({ ...A, double: false });
    }
  }
  return out;
}

/* ---------- 3. duvar çıkarımı ---------- */

export function detectWalls(bin, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const minH = Math.round(o.minLineFrac * bin.w);
  const minV = Math.round(o.minLineFrac * bin.h);
  const maxGap = Math.round(o.maxWallFrac * Math.max(bin.w, bin.h));

  const hor = mergeDoubles(clusterRuns(runs(bin, true, minH, o.gapTol), o.lineBand), maxGap);
  const ver = mergeDoubles(clusterRuns(runs(bin, false, minV, o.gapTol), o.lineBand), maxGap);

  // yatay: y = o, x ∈ [a,b] · dikey: x = o, y ∈ [a,b]
  return {
    horizontal: hor.map((l) => ({ y: l.o, x0: l.a, x1: l.b, t: l.t })),
    vertical: ver.map((l) => ({ x: l.o, y0: l.a, y1: l.b, t: l.t })),
  };
}

/* ---------- 4. ızgara ile oda bulma ---------- */

const uniqSnap = (vals, tol) => {
  const s = vals.slice().sort((a, b) => a - b);
  const out = [];
  for (const v of s) {
    if (!out.length || v - out[out.length - 1] > tol) out.push(v);
    else out[out.length - 1] = (out[out.length - 1] + v) / 2;
  }
  return out;
};

/** Duvarların kapattığı hücre ızgarasından odaları ve sınır poligonlarını çıkarır. */
export function detectRooms(walls, bin, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const tol = Math.max(3, Math.round(0.006 * Math.max(bin.w, bin.h)));
  const xs = uniqSnap(walls.vertical.map((v) => v.x), tol);
  const ys = uniqSnap(walls.horizontal.map((h) => h.y), tol);
  if (xs.length < 2 || ys.length < 2) return [];

  const nx = xs.length - 1, ny = ys.length - 1;
  const cov = 0.55; // duvarın hücre kenarını kapatma oranı

  const blockedRight = (i, j) => {
    const x = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
    return walls.vertical.some((v) =>
      Math.abs(v.x - x) <= tol &&
      (Math.min(v.y1, y1) - Math.max(v.y0, y0)) > cov * (y1 - y0));
  };
  const blockedDown = (i, j) => {
    const y = ys[j + 1], x0 = xs[i], x1 = xs[i + 1];
    return walls.horizontal.some((hl) =>
      Math.abs(hl.y - y) <= tol &&
      (Math.min(hl.x1, x1) - Math.max(hl.x0, x0)) > cov * (x1 - x0));
  };
  const edgeWall = (side, i, j) => {
    if (side === 'left') return i > 0 ? !blockedRight(i - 1, j) === false : hasVertical(xs[0], ys[j], ys[j + 1]);
    if (side === 'top') return hasHorizontal(ys[0], xs[i], xs[i + 1]);
    return false;
  };
  const hasVertical = (x, y0, y1) => walls.vertical.some((v) =>
    Math.abs(v.x - x) <= tol && (Math.min(v.y1, y1) - Math.max(v.y0, y0)) > cov * (y1 - y0));
  const hasHorizontal = (y, x0, x1) => walls.horizontal.some((hl) =>
    Math.abs(hl.y - y) <= tol && (Math.min(hl.x1, x1) - Math.max(hl.x0, x0)) > cov * (x1 - x0));

  // bağlantılı hücre bölgeleri
  const id = new Int32Array(nx * ny).fill(-1);
  const regions = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (id[j * nx + i] >= 0) continue;
      const r = { cells: [], outside: false };
      const idx = regions.length;
      const stack = [[i, j]];
      id[j * nx + i] = idx;
      while (stack.length) {
        const [ci, cj] = stack.pop();
        r.cells.push([ci, cj]);
        // dışarı açılıyor mu? (ızgara kenarında duvar yoksa bu bölge bina dışıdır)
        if (ci === 0 && !hasVertical(xs[0], ys[cj], ys[cj + 1])) r.outside = true;
        if (ci === nx - 1 && !hasVertical(xs[nx], ys[cj], ys[cj + 1])) r.outside = true;
        if (cj === 0 && !hasHorizontal(ys[0], xs[ci], xs[ci + 1])) r.outside = true;
        if (cj === ny - 1 && !hasHorizontal(ys[ny], xs[ci], xs[ci + 1])) r.outside = true;

        const push = (ni, nj) => {
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) return;
          if (id[nj * nx + ni] >= 0) return;
          id[nj * nx + ni] = idx;
          stack.push([ni, nj]);
        };
        if (!blockedRight(ci, cj)) push(ci + 1, cj);
        if (ci > 0 && !blockedRight(ci - 1, cj)) push(ci - 1, cj);
        if (!blockedDown(ci, cj)) push(ci, cj + 1);
        if (cj > 0 && !blockedDown(ci, cj - 1)) push(ci, cj - 1);
      }
      regions.push(r);
    }
  }

  const thickest = Math.max(...walls.horizontal.concat(walls.vertical).map((l) => l.t), 6);
  const all = [];
  for (const r of regions) {
    if (r.outside) continue;
    const area = r.cells.reduce((a, [i, j]) => a + (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]), 0);
    const poly = tracePolygon(r.cells, xs, ys);
    const px = poly.map((p) => p[0]), py = poly.map((p) => p[1]);
    const thin = Math.min(Math.max(...px) - Math.min(...px), Math.max(...py) - Math.min(...py));
    // çift duvar çizgisi arasındaki boşluk oda değildir
    if (thin < 2.5 * thickest) continue;
    all.push({ polygon: poly, areaPx: area });
  }
  all.sort((a, b) => b.areaPx - a.areaPx);
  // çizim süsleri (pass-box kutusu gibi) en büyük odanın yanında çok küçük kalır
  const minArea = (o.minRoomFrac ?? 0.06) * (all[0]?.areaPx || 0);
  return all.filter((r) => r.areaPx >= minArea);
}

/** Hücre kümesinin dış sınırını saat yönünde poligona çevirir. */
function tracePolygon(cells, xs, ys) {
  const key = (i, j) => `${i},${j}`;
  const set = new Set(cells.map(([i, j]) => key(i, j)));
  const edges = new Map(); // "x,y" -> [x2,y2]
  const add = (x1, y1, x2, y2) => edges.set(`${x1},${y1}`, [x2, y2]);

  for (const [i, j] of cells) {
    const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
    if (!set.has(key(i, j - 1))) add(x0, y0, x1, y0);
    if (!set.has(key(i + 1, j))) add(x1, y0, x1, y1);
    if (!set.has(key(i, j + 1))) add(x1, y1, x0, y1);
    if (!set.has(key(i - 1, j))) add(x0, y1, x0, y0);
  }

  const startKey = edges.keys().next().value;
  let [cx, cy] = startKey.split(',').map(Number);
  const poly = [];
  const guard = edges.size + 4;
  for (let n = 0; n < guard; n++) {
    poly.push([cx, cy]);
    const nxt = edges.get(`${cx},${cy}`);
    if (!nxt) break;
    edges.delete(`${cx},${cy}`);
    [cx, cy] = nxt;
    if (`${cx},${cy}` === startKey) break;
  }

  // aynı doğrultudaki ardışık noktaları sadeleştir
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i - 1 + poly.length) % poly.length], c = poly[i], n = poly[(i + 1) % poly.length];
    const col = (p[0] === c[0] && c[0] === n[0]) || (p[1] === c[1] && c[1] === n[1]);
    if (!col) out.push(c);
  }
  return out.length >= 3 ? out : poly;
}

/** Duvar kalınlığından küçük çıkıntı/girintileri poligondan atar. */
export function simplifyPolygon(poly, minFeature) {
  let p = poly.slice();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < p.length && p.length > 4; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const c = p[(i + 2) % p.length], d = p[(i + 3) % p.length];
      const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dep = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const w2 = Math.hypot(d[0] - c[0], d[1] - c[1]);
      // a→b ve c→d aynı doğrultuda, aradaki b→c kısa bir sapma ise düzle
      const sameAxis = (a[0] === b[0]) === (c[0] === d[0]);
      // çıkıntı/girinti: a→b ve c→d zıt yönlü kısa kenarlar, b→c dar (pass-box kutusu gibi)
      const bump = (a[0] === b[0]) !== (b[0] === c[0]) && (c[0] === d[0]) === (a[0] === b[0])
        && w < minFeature && w2 < minFeature && dep < minFeature * 2.5
        && ((a[0] === b[0]) ? Math.sign(b[1] - a[1]) !== Math.sign(d[1] - c[1])
                           : Math.sign(b[0] - a[0]) !== Math.sign(d[0] - c[0]));
      if (bump) {
        const keep = [];
        for (let k = 0; k < p.length; k++) {
          if (k === (i + 1) % p.length || k === (i + 2) % p.length) continue;
          keep.push(p[k]);
        }
        p = keep; changed = true; break;
      }
      if (sameAxis && dep < minFeature && Math.min(w, w2) < minFeature * 2.5) {
        const keep = [];
        for (let k = 0; k < p.length; k++) {
          if (k === (i + 1) % p.length || k === (i + 2) % p.length) continue;
          keep.push(p[k]);
        }
        p = keep; changed = true; break;
      }
    }
    if (!changed) break;
  }
  // kalan eşdoğrusal noktaları temizle
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    const col = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
    if (!col) out.push(b);
  }
  return out.length >= 4 ? out : p;
}

/** Aynı doğrultudaki örtüşen duvar parçalarını tek segmente indirger. */
function dedupeWalls(walls, tol) {
  const merge = (list, key, a, b) => {
    const out = [];
    for (const l of list.slice().sort((p, q) => p[key] - q[key] || p[a] - q[a])) {
      const hit = out.find((c) =>
        Math.abs(c[key] - l[key]) <= tol && Math.min(c[b], l[b]) >= Math.max(c[a], l[a]) - tol);
      if (hit) {
        hit[a] = Math.min(hit[a], l[a]);
        hit[b] = Math.max(hit[b], l[b]);
        hit.t = Math.max(hit.t, l.t);
      } else out.push({ ...l });
    }
    return out;
  };
  return {
    horizontal: merge(walls.horizontal, 'y', 'x0', 'x1'),
    vertical: merge(walls.vertical, 'x', 'y0', 'y1'),
  };
}

/** Yalnızca bir odanın sınırında yatan duvarları tutar (çizim süslerini atar). */
function keepRoomWalls(walls, rooms, tol) {
  const edges = [];
  for (const r of rooms) {
    const p = r.polygon;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if (a[0] === b[0]) edges.push({ axis: 'v', o: a[0], a: Math.min(a[1], b[1]), b: Math.max(a[1], b[1]) });
      else edges.push({ axis: 'h', o: a[1], a: Math.min(a[0], b[0]), b: Math.max(a[0], b[0]) });
    }
  }
  const onEdge = (axis, o, a, b) => edges.some((e) =>
    e.axis === axis && Math.abs(e.o - o) <= tol * 2 &&
    (Math.min(e.b, b) - Math.max(e.a, a)) > 0.3 * (b - a));

  return {
    horizontal: walls.horizontal.filter((l) => onEdge('h', l.y, l.x0, l.x1)),
    vertical: walls.vertical.filter((l) => onEdge('v', l.x, l.y0, l.y1)),
  };
}

/* ---------- 5. simgeler (kapı / pass-box) ---------- */

/** Duvar piksellerini silip kalan mürekkep kümelerini çıkarır. */
export function detectSymbols(bin, walls, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const { w, h } = bin;
  const ink = bin.ink.slice();
  const pad = Math.max(2, Math.round(0.004 * Math.max(w, h)));

  for (const l of walls.horizontal) {
    const t = Math.ceil(l.t / 2) + pad;
    for (let y = Math.max(0, Math.round(l.y - t)); y <= Math.min(h - 1, Math.round(l.y + t)); y++)
      for (let x = Math.max(0, l.x0); x <= Math.min(w - 1, l.x1); x++) ink[y * w + x] = 0;
  }
  for (const l of walls.vertical) {
    const t = Math.ceil(l.t / 2) + pad;
    for (let x = Math.max(0, Math.round(l.x - t)); x <= Math.min(w - 1, Math.round(l.x + t)); x++)
      for (let y = Math.max(0, l.y0); y <= Math.min(h - 1, l.y1); y++) ink[y * w + x] = 0;
  }

  const seen = new Uint8Array(w * h);
  const clusters = [];
  for (let p = 0; p < ink.length; p++) {
    if (!ink[p] || seen[p]) continue;
    const px = [], stack = [p];
    seen[p] = 1;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (stack.length) {
      const q = stack.pop();
      const qx = q % w, qy = (q / w) | 0;
      px.push([qx, qy]);
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (ink[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    clusters.push({ px, minX, maxX, minY, maxY });
  }

  // kesik çizgili yaylar çok sayıda küçük parçaya bölünür → yakın kutuları birleştir
  const gapPx = Math.max(6, Math.round(0.012 * Math.max(w, h)));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let k = i + 1; k < clusters.length; k++) {
        const A = clusters[i], B = clusters[k];
        if (A.minX - gapPx > B.maxX || B.minX - gapPx > A.maxX ||
            A.minY - gapPx > B.maxY || B.minY - gapPx > A.maxY) continue;
        A.px = A.px.concat(B.px);
        A.minX = Math.min(A.minX, B.minX); A.maxX = Math.max(A.maxX, B.maxX);
        A.minY = Math.min(A.minY, B.minY); A.maxY = Math.max(A.maxY, B.maxY);
        clusters.splice(k, 1);
        merged = true;
        break outer;
      }
    }
  }
  return clusters.filter((c) => c.px.length >= o.minSymbolPx);
}

/** Küme yay mı (kapı) yoksa kutu mu (pass-box)? */
export function classifySymbol(c) {
  const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
  const corners = [[c.minX, c.minY], [c.maxX, c.minY], [c.minX, c.maxY], [c.maxX, c.maxY]];
  let best = { frac: 0, r: 0, corner: null };
  for (const [cx, cy] of corners) {
    const rs = c.px.map(([x, y]) => Math.hypot(x - cx, y - cy));
    const med = rs.slice().sort((a, b) => a - b)[rs.length >> 1];
    if (med < 4) continue;
    const frac = rs.filter((r) => Math.abs(r - med) <= 0.14 * med).length / rs.length;
    if (frac > best.frac) best = { frac, r: med, corner: [cx, cy] };
  }
  // yay simgesi: piksellerin çoğu bir köşeden eşit uzaklıkta, kare-ish kutu
  const squarish = Math.min(bw, bh) / Math.max(bw, bh) > 0.55;
  const isArc = best.frac >= 0.42 && squarish && best.r > 0.55 * Math.max(bw, bh);
  return {
    type: isArc ? 'door' : 'passbox',
    confidence: isArc ? best.frac : 1 - best.frac,
    radius: best.r, hinge: best.corner,
  };
}

/* ---------- 6. simgeleri duvara oturtma ---------- */

function wallSegments(walls) {
  return [
    ...walls.horizontal.map((l) => ({ a: [l.x0, l.y], b: [l.x1, l.y], t: l.t, axis: 'h' })),
    ...walls.vertical.map((l) => ({ a: [l.x, l.y0], b: [l.x, l.y1], t: l.t, axis: 'v' })),
  ];
}

function projectOnto(seg, pt) {
  const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
  const len2 = dx * dx + dy * dy;
  const t = ((pt[0] - seg.a[0]) * dx + (pt[1] - seg.a[1]) * dy) / len2;
  const cl = Math.max(0, Math.min(1, t));
  const px = seg.a[0] + cl * dx, py = seg.a[1] + cl * dy;
  return { t: cl * Math.sqrt(len2), dist: Math.hypot(pt[0] - px, pt[1] - py) };
}

/** Oda sınırında olmayan kısa çizgiler duvar değil, simge kenarıdır. */
function keepSegment(sg, rooms, bin, o) {
  const len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]);
  if (len > 0.2 * Math.max(bin.w, bin.h)) return true;
  const tol = Math.max(4, sg.t * 1.5 + 0.006 * Math.max(bin.w, bin.h));
  const pts = [sg.a, sg.b, [(sg.a[0] + sg.b[0]) / 2, (sg.a[1] + sg.b[1]) / 2]];
  for (const r of rooms) {
    const poly = r.polygon;
    const near = pts.filter((p) => {
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i], n = poly[(i + 1) % poly.length];
        const d = projectOnto({ a: q, b: n }, p).dist;
        if (d <= tol) return true;
      }
      return false;
    });
    if (near.length >= 2) return true;
  }
  return false;
}

/* ---------- 7. tam çıkarım ---------- */

/**
 * Teknik çizimi plan nesnesine çevirir.
 * @param imageData tarayıcı ImageData ya da {width,height,data}
 * @param opts {widthMeters, wallHeight, name, threshold, ...}
 */
export function detectPlan(imageData, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const bin = binarize(imageData, o.threshold);
  const tol = Math.max(3, Math.round(0.006 * Math.max(bin.w, bin.h)));

  const rawWalls = detectWalls(bin, o);
  const roomsRaw = detectRooms(rawWalls, bin, o);
  const thickest = Math.max(...rawWalls.horizontal.concat(rawWalls.vertical).map((l) => l.t), 6);
  const rooms = roomsRaw.map((r) => ({ ...r, polygon: simplifyPolygon(r.polygon, 2.5 * thickest) }));

  // simgeleri ayıklarken ham duvarlarla sil: çizim süsleri de temizlenmiş olur
  const clusters = detectSymbols(bin, rawWalls, o);
  const walls = keepRoomWalls(dedupeWalls(rawWalls, tol), rooms, tol);
  const segs = wallSegments(walls);

  // her kümeyi en yakın duvara oturt
  const maxDist = Math.max(6, 0.02 * Math.max(bin.w, bin.h));
  const hits = [];
  for (const c of clusters) {
    const mid = [(c.minX + c.maxX) / 2, (c.minY + c.maxY) / 2];
    let bestSeg = -1, bestD = Infinity;
    segs.forEach((s, i) => {
      const pr = projectOnto(s, mid);
      if (pr.dist < bestD) { bestD = pr.dist; bestSeg = i; }
    });
    const size = Math.max(c.maxX - c.minX, c.maxY - c.minY);
    if (bestSeg < 0 || bestD > maxDist + 0.75 * size) continue;
    const ts = [[c.minX, c.minY], [c.maxX, c.minY], [c.minX, c.maxY], [c.maxX, c.maxY]]
      .map((p) => projectOnto(segs[bestSeg], p).t);
    hits.push({ seg: bestSeg, t0: Math.min(...ts), t1: Math.max(...ts), clusters: [c] });
  }

  // aynı duvarda örtüşen/komşu parçalar tek simgedir (yay parçaları, pass-box'ın iki yanı)
  const near = Math.max(8, 0.03 * Math.max(bin.w, bin.h));
  const merged = [];
  for (const hit of hits.sort((a, b) => a.seg - b.seg || a.t0 - b.t0)) {
    const prev = merged[merged.length - 1];
    if (prev && prev.seg === hit.seg && hit.t0 - prev.t1 <= near) {
      prev.t1 = Math.max(prev.t1, hit.t1);
      prev.clusters.push(...hit.clusters);
    } else merged.push({ ...hit });
  }

  const openings = merged.map((m) => {
    const union = {
      px: m.clusters.flatMap((c) => c.px),
      minX: Math.min(...m.clusters.map((c) => c.minX)),
      maxX: Math.max(...m.clusters.map((c) => c.maxX)),
      minY: Math.min(...m.clusters.map((c) => c.minY)),
      maxY: Math.max(...m.clusters.map((c) => c.maxY)),
    };
    const cls = classifySymbol(union);
    return {
      type: cls.type, confidence: +cls.confidence.toFixed(2),
      seg: m.seg, t0: m.t0, t1: m.t1, parts: m.clusters.length, cluster: union,
    };
  });

  return { bin, walls, rawWalls, rooms, segs, openings, clusters };
}

/* ---------- 8. plan JSON'u ---------- */

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Çıkarımı ölçekleyip plan JSON'una çevirir.
 * @param det detectPlan çıktısı
 * @param cfg {widthMeters, wallHeight, id, name, zoneNames}
 *   widthMeters: binanın DIŞ genişliği (duvarların dış yüzleri arası). Bölge
 *   poligonları duvar ekseninde üretildiği için bir duvar kalınlığı kadar küçüktür.
 */
export function toPlan(det, cfg = {}) {
  const { walls, rooms, segs, openings } = det;
  const wallHeight = cfg.wallHeight ?? 2.7;

  // ölçek: dış sınırın piksel genişliği → verilen metre
  const allX = [...walls.vertical.map((v) => v.x), ...walls.horizontal.flatMap((h) => [h.x0, h.x1])];
  const allY = [...walls.horizontal.map((h) => h.y), ...walls.vertical.flatMap((v) => [v.y0, v.y1])];
  const minX = Math.min(...allX), maxX = Math.max(...allX);
  const minY = Math.min(...allY), maxY = Math.max(...allY);
  const widthM = cfg.widthMeters ?? 7;
  const s = widthM / (maxX - minX);
  const X = (px) => r2((px - minX) * s);
  const Z = (py) => r2((py - minY) * s);

  const medT = walls.horizontal.concat(walls.vertical).map((l) => l.t).sort((a, b) => a - b);
  const wallThickness = Math.min(0.2, Math.max(0.05,
    r2((medT[medT.length >> 1] || 6) * s)));

  // bölgeler
  const names = cfg.zoneNames || [];
  const zones = rooms.map((r, i) => ({
    id: `Z${i + 1}`,
    name: names[i] || (i === 0 ? 'Temiz Oda' : `Oda ${i + 1}`),
    class: i === 0 ? 'ISO 7' : 'ISO 8',
    pressurePa: i === 0 ? 15 : 8,
    polygon: r.polygon.map(([x, y]) => [X(x), Z(y)]),
  }));

  const zoneOf = (x, y) => {
    for (const z of zones) if (pointInPoly(z.polygon, [X(x), Z(y)])) return z.id;
    return zones[0]?.id || 'Z1';
  };

  // duvarlar + açıklıklar
  const counters = { door: 0, passbox: 0 };
  const outWalls = segs.map((sg, i) => {
    const a = [X(sg.a[0]), Z(sg.a[1])], b = [X(sg.b[0]), Z(sg.b[1])];
    const mid = [(sg.a[0] + sg.b[0]) / 2, (sg.a[1] + sg.b[1]) / 2];
    const ops = openings.filter((op) => op.seg === i).map((op) => {
      const t0 = op.t0 * s, t1 = op.t1 * s;
      const isDoor = op.type === 'door';
      const n = ++counters[op.type];
      const wM = Math.max(0.6, r2(t1 - t0));
      return {
        id: isDoor ? `D${n}` : `PB${n}`,
        type: op.type,
        type_tr: isDoor ? 'Temiz oda kapısı' : 'Malzeme geçiş kutusu',
        center: r2((t0 + t1) / 2),
        w: Math.min(wM, 1.3),
        h: isDoor ? 2.1 : 0.7,
        sill: isDoor ? 0 : 0.9,
        ...(isDoor ? { vision: true } : {}),
        confidence: op.confidence,
      };
    }).sort((p, q) => p.center - q.center);
    const wl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let prevEnd = 0;
    const fit = [];
    for (const op of ops) {
      op.w = r2(Math.min(op.w, wl - 0.1));
      if (op.w < 0.3) continue;
      op.center = r2(Math.min(Math.max(op.center, op.w / 2 + 0.02), wl - op.w / 2 - 0.02));
      if (op.center - op.w / 2 < prevEnd - 1e-6) continue;
      prevEnd = op.center + op.w / 2;
      fit.push(op);
    }
    ops.length = 0; ops.push(...fit);
    return { a, b, zone: zoneOf(mid[0], mid[1]), openings: ops };
  }).filter((w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) > 0.3);

  // tavan ekipmanı: her bölgeye makul ızgara
  const hepa = [], lights = [], returns = [];
  zones.forEach((z, zi) => {
    const bb = polyBounds(z.polygon);
    const cols = Math.max(1, Math.round(bb.w / 4)), rows = Math.max(1, Math.round(bb.h / 3));
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = r2(bb.x0 + bb.w * (c + 0.5) / cols);
        const zz = r2(bb.y0 + bb.h * (r + 0.5) / rows);
        if (!pointInPoly(z.polygon, [x, zz])) continue;
        hepa.push({ id: `HEPA-${zi + 1}${++n}`, x, z: zz, w: 1.2, l: 0.6 });
        lights.push({ id: `L-${zi + 1}${n}`, x: r2(x), z: r2(zz + 1.0), w: 1.2, l: 0.3 });
      }
    }
    returns.push({
      id: `RA-${zi + 1}`, x: r2(bb.x0 + 0.4), z: r2(bb.y0 + bb.h / 2), w: 0.4, l: 1.2,
    });
  });

  // her bölgeye bir fark basıncı sensörü
  const sensors = zones.map((z, i) => {
    const bb = polyBounds(z.polygon);
    return {
      id: `DP-${i + 1}`, type: 'dp', label: `ΔP ${z.name}`,
      x: r2(bb.x0 + 0.1), z: r2(bb.y0 + bb.h / 2), y: 1.5, wall: 'x-',
    };
  });

  const spawn = (() => {
    const z = zones[0];
    if (!z) return { x: 1, z: 1, heading: 0 };
    const bb = polyBounds(z.polygon);
    return { x: r2(bb.x0 + bb.w / 2), z: r2(bb.y0 + bb.h / 2), heading: 0 };
  })();

  return {
    id: cfg.id || 'ice-aktarilan',
    name: cfg.name || 'Teknik çizimden içe aktarıldı',
    units: 'm',
    note: `Teknik çizimden otomatik çıkarıldı · ölçek: dış genişlik ${widthM} m`,
    wallHeight, wallThickness, plenumHeight: 0.45,
    zones, walls: outWalls,
    ceiling: { hepa, lights, returns },
    sensors, spawn,
  };
}

function polyBounds(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x0, y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

function pointInPoly(poly, [x, y]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export { DEFAULTS, polyBounds, pointInPoly };
