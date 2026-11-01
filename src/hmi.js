// CleanAi — PLC/HMI arka planı üretimi.
// PNG: tepeden ortografik render (tavan plakası gizli).
// SVG: aynı plan koordinatlarına oturan, id'li canlı veri katmanları.
import * as THREE from 'three';

export function planBounds(cfg, margin = 0.6) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const zone of cfg.zones) {
    for (const [x, z] of zone.polygon) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  return {
    minX: minX - margin, minZ: minZ - margin,
    maxX: maxX + margin, maxZ: maxZ + margin,
    w: (maxX - minX) + 2 * margin, h: (maxZ - minZ) + 2 * margin,
  };
}

/** Tepeden ortografik PNG üretir. pxPerM: çözünürlük (varsayılan 160 px/m). */
export function renderHMIBackground(renderer, scene, root, cfg, pxPerM = 160) {
  const b = planBounds(cfg);
  const W = Math.round(b.w * pxPerM), H = Math.round(b.h * pxPerM);

  const hidden = [];
  root.traverse((o) => {
    if (o.isMesh && o.name.startsWith('ceiling:')) { hidden.push(o); o.visible = false; }
  });

  const cam = new THREE.OrthographicCamera(-b.w / 2, b.w / 2, b.h / 2, -b.h / 2, 0.01, 100);
  cam.position.set(b.minX + b.w / 2, 20, b.minZ + b.h / 2);
  cam.up.set(0, 0, -1);           // plan +z aşağı bakacak
  cam.lookAt(b.minX + b.w / 2, 0, b.minZ + b.h / 2);

  const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);

  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  rt.dispose();
  for (const o of hidden) o.visible = true;

  // WebGL alttan-üste okur -> çevir
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4, dst = y * W * 4;
    img.data.set(buf.subarray(src, src + W * 4), dst);
  }
  ctx.putImageData(img, 0, 0);
  return { dataURL: c.toDataURL('image/png'), width: W, height: H, bounds: b, pxPerM };
}

/* ---------- SVG katmanları ---------- */

function openingWorld(wall, o) {
  const [ax, az] = wall.a, [bx, bz] = wall.b;
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len, uz = dz / len;
  const cx = ax + ux * o.center, cz = az + uz * o.center;
  return { cx, cz, ux, uz, angle: (Math.atan2(uz, ux) * 180) / Math.PI };
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * HMI SVG katmanı. viewBox plan metreleriyle, width/height PNG pikseliyle verilir;
 * böylece PNG'nin üstüne birebir oturur ve her ölçekte hizalı kalır.
 * Her eleman id + data-* taşır: PLC'de canlı veriyi bu id'lere bağlayacaksın.
 */
export function buildHMISVG(cfg, bg) {
  const b = bg.bounds;
  const L = [];
  const push = (s) => L.push('    ' + s);

  L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${bg.width}" height="${bg.height}" viewBox="${b.minX.toFixed(3)} ${b.minZ.toFixed(3)} ${b.w.toFixed(3)} ${b.h.toFixed(3)}" data-plan="${esc(cfg.id)}" data-px-per-m="${bg.pxPerM}">`);
  L.push(`  <title>${esc(cfg.name)} — HMI katmanları</title>`);
  L.push(`  <desc>Koordinat birimi: metre. viewBox plan koordinatlarıyla birebir aynıdır.</desc>`);
  L.push(`  <style>
    .zone{fill:none;stroke:#19c6e0;stroke-width:.04;opacity:.9}
    .zone.alarm{stroke:#ff4d4f}
    .door{fill:#2bd67b;stroke:#0b3b24;stroke-width:.02}
    .door.closed{fill:#8795a1}
    .door.alarm{fill:#ff4d4f}
    .passbox{fill:#ffb020;stroke:#5a3c00;stroke-width:.02}
    .hepa{fill:none;stroke:#7aa7ff;stroke-width:.04}
    .light{fill:#fff3c4;stroke:#b79a3a;stroke-width:.02}
    .light.off{fill:#5c6066}
    .ra{fill:none;stroke:#9aa7b0;stroke-width:.04;stroke-dasharray:.12 .08}
    .sensor{fill:#0b2630;stroke:#19c6e0;stroke-width:.03}
    .label{font:.26px sans-serif;fill:#dff3f8;text-anchor:middle;dominant-baseline:middle}
    .value{font:bold .3px sans-serif;fill:#19c6e0;text-anchor:middle;dominant-baseline:middle}
  </style>`);

  // bölgeler
  L.push(`  <g id="layer-zones" data-layer="zones">`);
  for (const z of cfg.zones) {
    const pts = z.polygon.map(([x, zz]) => `${x},${zz}`).join(' ');
    push(`<polygon id="zone-${esc(z.id)}" class="zone" points="${pts}" data-name="${esc(z.name)}" data-class="${esc(z.class || '')}" data-pressure-sp="${z.pressurePa ?? ''}" />`);
  }
  L.push(`  </g>`);

  // kapılar + pass-box
  L.push(`  <g id="layer-doors" data-layer="doors">`);
  const pb = [];
  for (const w of cfg.walls) {
    for (const o of w.openings || []) {
      const p = openingWorld(w, o);
      const d = 0.16;
      const rect = `<rect x="${(-o.w / 2).toFixed(3)}" y="${(-d / 2).toFixed(3)}" width="${o.w.toFixed(3)}" height="${d.toFixed(3)}" />`;
      const tf = `transform="translate(${p.cx.toFixed(3)} ${p.cz.toFixed(3)}) rotate(${p.angle.toFixed(2)})"`;
      if (o.type === 'door') {
        push(`<g id="door-${esc(o.id)}" class="door closed" ${tf} data-kind="door" data-label="${esc(o.type_tr || o.id)}" data-zone="${esc(w.zone)}">${rect}</g>`);
      } else if (o.type === 'passbox') {
        pb.push(`<g id="passbox-${esc(o.id)}" class="passbox" ${tf} data-kind="passbox" data-label="${esc(o.type_tr || o.id)}" data-zone="${esc(w.zone)}">${rect}</g>`);
      }
    }
  }
  L.push(`  </g>`);
  L.push(`  <g id="layer-passboxes" data-layer="passboxes">`);
  pb.forEach(push);
  L.push(`  </g>`);

  // HEPA
  L.push(`  <g id="layer-hepa" data-layer="hepa">`);
  for (const h of cfg.ceiling?.hepa || []) {
    push(`<rect id="hepa-${esc(h.id)}" class="hepa" x="${(h.x - h.w / 2).toFixed(3)}" y="${(h.z - h.l / 2).toFixed(3)}" width="${h.w}" height="${h.l}" data-kind="hepa" data-label="${esc(h.id)}" />`);
  }
  L.push(`  </g>`);

  // aydınlatma
  L.push(`  <g id="layer-lights" data-layer="lights">`);
  for (const l of cfg.ceiling?.lights || []) {
    push(`<rect id="light-${esc(l.id)}" class="light" x="${(l.x - l.w / 2).toFixed(3)}" y="${(l.z - l.l / 2).toFixed(3)}" width="${l.w}" height="${l.l}" rx=".06" data-kind="light" data-label="${esc(l.id)}" />`);
  }
  L.push(`  </g>`);

  // dönüş havası
  L.push(`  <g id="layer-return" data-layer="return">`);
  for (const r of cfg.ceiling?.returns || []) {
    push(`<rect id="ra-${esc(r.id)}" class="ra" x="${(r.x - r.w / 2).toFixed(3)}" y="${(r.z - r.l / 2).toFixed(3)}" width="${r.w}" height="${r.l}" data-kind="return" data-label="${esc(r.id)}" />`);
  }
  L.push(`  </g>`);

  // sensörler + canlı değer yuvaları
  L.push(`  <g id="layer-sensors" data-layer="sensors">`);
  for (const s of cfg.sensors || []) {
    push(`<g id="sensor-${esc(s.id)}" data-kind="${esc(s.type)}" data-label="${esc(s.label)}">`);
    push(`  <circle class="sensor" cx="${s.x}" cy="${s.z}" r=".22" />`);
    push(`  <text id="value-${esc(s.id)}" class="value" x="${s.x}" y="${(s.z - 0.45).toFixed(3)}">--</text>`);
    push(`</g>`);
  }
  L.push(`  </g>`);

  L.push(`</svg>`);
  return L.join('\n');
}

/** Hangi id'ye hangi veriyi bağlayacağını anlatan eşleme dosyası. */
export function buildTagMap(cfg) {
  const tags = [];
  for (const z of cfg.zones) {
    tags.push({ svgId: `zone-${z.id}`, kind: 'zone', label: z.name, signal: `${z.id}_PRESSURE_PA`, hint: 'Sınıf dışı ise class="zone alarm"' });
  }
  for (const w of cfg.walls) {
    for (const o of w.openings || []) {
      if (o.type === 'door') {
        tags.push({ svgId: `door-${o.id}`, kind: 'door', label: o.type_tr || o.id, signal: `${o.id}_OPEN`, hint: 'Açıkken class="door", kapalıyken class="door closed", interlock ihlalinde "door alarm"' });
      } else if (o.type === 'passbox') {
        tags.push({ svgId: `passbox-${o.id}`, kind: 'passbox', label: o.type_tr || o.id, signal: `${o.id}_LOCKED`, hint: 'Kilitliyse opacity düşür' });
      }
    }
  }
  for (const h of cfg.ceiling?.hepa || []) tags.push({ svgId: `hepa-${h.id}`, kind: 'hepa', label: h.id, signal: `${h.id}_DP_PA`, hint: 'Filtre fark basıncı; eşik aşımında stroke kırmızı' });
  for (const l of cfg.ceiling?.lights || []) tags.push({ svgId: `light-${l.id}`, kind: 'light', label: l.id, signal: `${l.id}_ON`, hint: 'Kapalıyken class="light off"' });
  for (const s of cfg.sensors || []) tags.push({ svgId: `value-${s.id}`, kind: s.type, label: s.label, signal: `${s.id}_VALUE`, hint: 'textContent olarak yaz' });
  return tags;
}
