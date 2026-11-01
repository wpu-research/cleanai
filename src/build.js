// CleanAi — plan JSON'undan 3D temiz oda sahnesi üretir.
// Koordinat: plan (x, z) -> dünya (x, y, z). y = yükseklik.
import * as THREE from 'three';

/* ---------- malzemeler ---------- */

function panelTexture(seam = 1.2, px = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f7f8';
  g.fillRect(0, 0, px, px);
  // hafif doku
  const img = g.getImageData(0, 0, px, px);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 6;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // panel derzi
  g.strokeStyle = 'rgba(150,165,172,0.55)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(1, 0); g.lineTo(1, px); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.userData.seam = seam;
  return t;
}

export function makeMaterials() {
  const wallTex = panelTexture();
  return {
    wall: new THREE.MeshStandardMaterial({
      color: 0xffffff, map: wallTex, roughness: 0.35, metalness: 0.02,
    }),
    wallPlain: new THREE.MeshStandardMaterial({ color: 0xf2f6f7, roughness: 0.4 }),
    floor: new THREE.MeshStandardMaterial({
      color: 0xe9eef0, roughness: 0.18, metalness: 0.0, side: THREE.DoubleSide,
    }),
    ceiling: new THREE.MeshStandardMaterial({
      color: 0xf7fafb, roughness: 0.6, side: THREE.DoubleSide,
    }),
    cove: new THREE.MeshStandardMaterial({ color: 0xe6ecee, roughness: 0.3 }),
    alu: new THREE.MeshStandardMaterial({ color: 0xc3ccd2, roughness: 0.3, metalness: 0.75 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xaeb8bf, roughness: 0.25, metalness: 0.9 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xdfeef2, roughness: 0.05, metalness: 0, transmission: 0.85,
      thickness: 0.02, transparent: true, opacity: 0.45,
    }),
    // pass-box camı: render'daki turkuaz ton
    glassTeal: new THREE.MeshPhysicalMaterial({
      color: 0x36d6d6, roughness: 0.08, metalness: 0, transmission: 0.6,
      thickness: 0.02, transparent: true, opacity: 0.62,
      emissive: 0x0d6e72, emissiveIntensity: 0.35,
    }),
    dial: new THREE.MeshStandardMaterial({ color: 0x9aa6ad, roughness: 0.2, metalness: 0.85 }),
    keypad: new THREE.MeshStandardMaterial({
      color: 0x14323c, emissive: 0x1aa6bd, emissiveIntensity: 0.6, roughness: 0.35,
    }),
    lightLens: new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xfff6e2, emissiveIntensity: 1.6, roughness: 0.4,
    }),
    hepa: new THREE.MeshStandardMaterial({ color: 0xeff3f5, roughness: 0.85 }),
    grille: new THREE.MeshStandardMaterial({ color: 0xd3dade, roughness: 0.6, metalness: 0.3 }),
    screen: new THREE.MeshStandardMaterial({
      color: 0x0b2630, emissive: 0x19c6e0, emissiveIntensity: 0.9, roughness: 0.3,
    }),
  };
}

/* ---------- yardımcılar ---------- */

const V = (x, z) => new THREE.Vector2(x, z);

function box(w, h, d, mat, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

/* Duvar segmenti üzerindeki yerel koordinatı dünyaya çevirir.
   t: segment başından uzaklık (m), n: normal yönünde ofset (m) */
function localGroup(a, b, parent) {
  const dir = V(b[0] - a[0], b[1] - a[1]);
  const len = dir.length();
  const ang = Math.atan2(dir.y, dir.x);
  const g = new THREE.Group();
  g.position.set(a[0], 0, a[1]);
  g.rotation.y = -ang; // +X yerel eksen = segment yönü
  parent.add(g);
  return { g, len, ang, dir: dir.clone().normalize() };
}

/* ---------- duvar ---------- */

function buildWall(wall, cfg, mats, parent, registry) {
  const H = cfg.wallHeight, T = cfg.wallThickness;
  const { g, len } = localGroup(wall.a, wall.b, parent);

  const ops = (wall.openings || []).slice().sort((p, q) => p.center - q.center);
  const spans = []; // dolu (tam yükseklik) parçalar
  let cursor = 0;
  for (const o of ops) {
    const t0 = o.center - o.w / 2, t1 = o.center + o.w / 2;
    if (t0 > cursor) spans.push([cursor, t0]);
    cursor = Math.max(cursor, t1);
  }
  if (cursor < len) spans.push([cursor, len]);

  for (const [t0, t1] of spans) {
    const w = t1 - t0;
    if (w <= 1e-4) continue;
    const m = box(w, H, T, mats.wall, t0 + w / 2, H / 2, 0, g);
    const tex = m.material.map;
    if (tex) {
      // her parça için ayrı tekrar: derzler 1.2 m'de bir
      m.material = m.material.clone();
      m.material.map = tex.clone();
      m.material.map.needsUpdate = true;
      m.material.map.repeat.set(Math.max(1, Math.round(w / 1.2)), 1);
    }
    // süpürgelik kavisi (coving)
    box(w, 0.12, T + 0.05, mats.cove, t0 + w / 2, 0.06, 0, g);
  }

  for (const o of ops) {
    if (o.type === 'door') buildDoor(o, cfg, mats, g, registry, wall);
    else if (o.type === 'passbox') buildPassBox(o, cfg, mats, g, registry, wall);
    else if (o.type === 'window') buildWindow(o, cfg, mats, g);
    // açıklık üstü dolgu
    const top = o.sill + o.h;
    if (top < H - 1e-4) {
      box(o.w, H - top, T, mats.wall, o.center, top + (H - top) / 2, 0, g);
      }
    if (o.sill > 1e-4) {
      box(o.w, o.sill, T, mats.wall, o.center, o.sill / 2, 0, g);
    }
  }
}

function buildDoor(o, cfg, mats, g, registry, wall) {
  const T = cfg.wallThickness;
  const fr = 0.06; // kasa kalınlığı
  // kasa
  box(fr, o.h, T + 0.03, mats.alu, o.center - o.w / 2 + fr / 2, o.h / 2, 0, g);
  box(fr, o.h, T + 0.03, mats.alu, o.center + o.w / 2 - fr / 2, o.h / 2, 0, g);
  box(o.w, fr, T + 0.03, mats.alu, o.center, o.h - fr / 2, 0, g);

  // kanat (menteşe sol kenarda, grup içinde döndürülebilir)
  const lw = o.w - 2 * fr, lh = o.h - fr;
  const hinge = new THREE.Group();
  hinge.position.set(o.center - o.w / 2 + fr, 0, 0);
  g.add(hinge);
  const leaf = box(lw, lh, 0.045, mats.wallPlain, lw / 2, lh / 2, 0, hinge);
  leaf.name = 'leaf';
  // gözetleme camları + kumanda (render'daki standart kapı)
  if (o.vision !== false) {
    const gw = lw * 0.46, gh = lh * 0.26;
    for (const yy of [lh * 0.74, lh * 0.30]) {
      box(gw + 0.05, gh + 0.05, 0.048, mats.alu, lw / 2, yy, 0, hinge);
      box(gw, gh, 0.056, mats.glass, lw / 2, yy, 0, hinge);
    }
    // iki pencere arasında: yuvarlak gösterge + kare kumanda paneli
    const my = lh * 0.52;
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.022, 20), mats.dial);
    dial.rotation.x = Math.PI / 2;
    dial.position.set(lw / 2 - 0.085, my, 0.03);
    hinge.add(dial);
    box(0.10, 0.10, 0.022, mats.alu, lw / 2 + 0.085, my, 0.03, hinge);
    box(0.072, 0.072, 0.026, mats.keypad, lw / 2 + 0.085, my, 0.033, hinge);
  }
  // kol
  const h1 = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.12, 12), mats.steel);
  h1.rotation.z = Math.PI / 2;
  h1.position.set(lw - 0.09, 1.05, 0.05);
  hinge.add(h1);

  registry.doors.push({ id: o.id, hinge, open: 0, target: 0, wall, opening: o });
}

function buildPassBox(o, cfg, mats, g, registry) {
  const T = cfg.wallThickness;
  const depth = 0.55;
  const y = o.sill + o.h / 2;
  // gövde (duvara gömülü kutu)
  box(o.w + 0.1, o.h + 0.1, depth, mats.alu, o.center, y, 0, g);
  box(o.w - 0.06, o.h - 0.06, depth + 0.02, mats.wallPlain, o.center, y, 0, g);
  // iki yüzde turkuaz camlı kapak + çerçeve
  for (const s of [1, -1]) {
    const zz = s * (depth / 2 + 0.01);
    box(o.w - 0.06, o.h - 0.06, 0.022, mats.alu, o.center, y, zz, g);
    box(o.w - 0.16, o.h - 0.16, 0.03, mats.glassTeal, o.center, y, zz + s * 0.004, g);
    // eğik kol (2D simgedeki iki çizgi)
    for (const sy of [1, -1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.035, o.h * 0.42, 0.03), mats.steel);
      arm.position.set(o.center + s * (o.w / 2 - 0.02), y + sy * o.h * 0.22, zz + s * 0.05);
      arm.rotation.z = sy * 0.3;
      g.add(arm);
    }
    // kilit düğmesi
    const k = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 14), mats.steel);
    k.rotation.x = Math.PI / 2;
    k.position.set(o.center - o.w / 2 + 0.06, y, zz + s * 0.03);
    g.add(k);
  }
  registry.passboxes.push({ id: o.id, opening: o });
}

function buildWindow(o, cfg, mats, g) {
  const T = cfg.wallThickness;
  const y = o.sill + o.h / 2;
  box(o.w, o.h, 0.02, mats.glass, o.center, y, 0, g);
  box(o.w + 0.06, o.h + 0.06, T + 0.02, mats.alu, o.center, y, -0.005, g);
}

/* ---------- zeminler / tavan ---------- */

function shapeFromPolygon(poly) {
  const s = new THREE.Shape();
  s.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) s.lineTo(poly[i][0], poly[i][1]);
  s.closePath();
  return s;
}

function buildZone(zone, cfg, mats, parent) {
  const shape = shapeFromPolygon(zone.polygon);

  const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), mats.floor);
  floor.rotation.x = Math.PI / 2; // (x,y,0) -> (x,0,y)
  floor.receiveShadow = true;
  floor.name = `floor:${zone.id}`;
  parent.add(floor);

  const ceil = new THREE.Mesh(new THREE.ShapeGeometry(shape), mats.ceiling);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = cfg.wallHeight;
  ceil.name = `ceiling:${zone.id}`;
  parent.add(ceil);
}

/* ---------- tavan ekipmanı ---------- */

function buildCeiling(cfg, mats, parent, registry) {
  const H = cfg.wallHeight;
  const c = cfg.ceiling || {};

  for (const h of c.hepa || []) {
    box(h.w, 0.06, h.l, mats.alu, h.x, H - 0.03, h.z, parent);
    box(h.w - 0.08, 0.03, h.l - 0.08, mats.hepa, h.x, H - 0.065, h.z, parent);
    registry.hepa.push(h);
  }

  for (const l of c.lights || []) {
    box(l.w, 0.05, l.l, mats.alu, l.x, H - 0.025, l.z, parent);
    const lens = box(l.w - 0.06, 0.02, l.l - 0.05, mats.lightLens, l.x, H - 0.055, l.z, parent);
    lens.name = `lens:${l.id}`;
    const pl = new THREE.PointLight(0xfff4e0, 6, 9, 2);
    pl.position.set(l.x, H - 0.2, l.z);
    parent.add(pl);
    registry.lights.push({ id: l.id, lens, light: pl, def: l });
  }

  for (const r of c.returns || []) {
    box(r.w, 0.04, r.l, mats.grille, r.x, H - 0.02, r.z, parent);
    registry.returns.push(r);
  }
}

/* ---------- duvar sensörleri ---------- */

function buildSensors(cfg, mats, parent, registry) {
  for (const s of cfg.sensors || []) {
    const g = new THREE.Group();
    g.position.set(s.x, s.y, s.z);
    if (s.wall === 'x+') g.rotation.y = -Math.PI / 2;
    else if (s.wall === 'x-') g.rotation.y = Math.PI / 2;
    else if (s.wall === 'z+') g.rotation.y = Math.PI;
    parent.add(g);
    box(0.20, 0.26, 0.05, mats.wallPlain, 0, 0, 0.025, g);
    const sc = box(0.15, 0.10, 0.052, mats.screen, 0, 0.04, 0.03, g);
    sc.name = `sensor:${s.id}`;
    registry.sensors.push({ ...s, mesh: sc });
  }
}

/* ---------- ana giriş ---------- */

export function buildPlan(cfg, mats) {
  const root = new THREE.Group();
  root.name = `plan:${cfg.id}`;
  const registry = {
    doors: [], passboxes: [], hepa: [], lights: [], returns: [], sensors: [],
    walls: [], cfg,
  };

  for (const z of cfg.zones) buildZone(z, cfg, mats, root);
  for (const w of cfg.walls) {
    buildWall(w, cfg, mats, root, registry);
    registry.walls.push(w);
  }
  buildCeiling(cfg, mats, root, registry);
  buildSensors(cfg, mats, root, registry);

  return { root, registry };
}

/* ---------- çarpışma ---------- */

/** Oyuncunun (x,z) noktasında yarıçap r ile duvara girip girmediğini döner. */
export function blocked(registry, x, z, r, eyeY = 1.6) {
  const cfg = registry.cfg;
  const half = cfg.wallThickness / 2;
  for (const w of registry.walls) {
    const ax = w.a[0], az = w.a[1], bx = w.b[0], bz = w.b[1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, pz = az + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d > r + half) continue;

    // açıklıktan geçiş var mı?
    const len = Math.sqrt(len2);
    const tm = t * len;
    let passable = false;
    for (const o of w.openings || []) {
      if (o.type !== 'door') continue;            // pass-box'tan geçilmez
      const d2 = registry.doors.find((q) => q.id === o.id);
      if (d2 && d2.open < 0.35) continue;         // kapalı kapı engeldir
      if (tm > o.center - o.w / 2 + r * 0.5 && tm < o.center + o.w / 2 - r * 0.5) {
        passable = true;
      }
    }
    if (!passable) return true;
  }
  return false;
}
