// 手続き生成の3Dモデルビルダー (three.js -> glb)
// 実行: node scripts/build-models.mjs
// 出力: public/models/car.glb, public/models/airliner.glb
// 座標規約: メートル / +Y 上 / 前方 +Z / 左 +X (右手系)。原点は地面上。
//   車: 前後車軸中間の真下  旅客機: 主脚中心の真下
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Node 用の最小ポリフィル (GLTFExporter が FileReader を使う) ----
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((b) => { this.result = b; this.onloadend && this.onloadend({ target: this }); this.onload && this.onload({ target: this }); });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((b) => {
        this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(b).toString('base64');
        this.onloadend && this.onloadend({ target: this }); this.onload && this.onload({ target: this });
      });
    }
  };
}

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const rad = (d) => (d * Math.PI) / 180;

// ======================= 共通ヘルパ =======================
function mat(name, hex, o = {}) {
  const m = new THREE.MeshStandardMaterial({
    name, color: new THREE.Color(hex),
    metalness: o.metalness ?? 0, roughness: o.roughness ?? 0.6,
    side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (o.emissive !== undefined) { m.emissive = new THREE.Color(o.emissive); m.emissiveIntensity = o.emissiveIntensity ?? 1; }
  if (o.opacity !== undefined) { m.transparent = true; m.opacity = o.opacity; }
  return m;
}

// 頂点属性を position/normal のみにして index 化 (サイズ削減 + 結合可能に)
function clean(g, keepNormals = true) {
  g = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!keepNormals || !g.attributes.normal) g.computeVertexNormals();
  return mergeVertices(g, 1e-4);
}
function flip(g) {
  const idx = g.index;
  if (idx) { for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1), b = idx.getX(i + 2); idx.setX(i + 1, b); idx.setX(i + 2, a); } }
  const n = g.attributes.normal;
  if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}
// 閉じたメッシュの符号付き体積が負なら反転
function orientVolume(g) {
  const p = g.attributes.position, idx = g.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let vol = 0;
  const n = idx ? idx.count : p.count;
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
    vol += a.dot(b.clone().cross(c)) / 6;
  }
  if (vol < 0) flip(g);
  g.computeVertexNormals();
  return g;
}
// 回転体: 最大半径付近の頂点法線が(sign>0: 外向き / sign<0: 軸向き)になるよう向きを揃える (軸=Y)
function fixLathe(g, sign = 1) {
  const p = g.attributes.position, n = g.attributes.normal;
  let best = -1, br = -1;
  for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getZ(i)); if (r > br) { br = r; best = i; } }
  const d = (p.getX(best) * n.getX(best) + p.getZ(best) * n.getZ(best));
  if (d * sign < 0) flip(g);
  return g;
}
function lathe(pts, seg = 32) {
  const g = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg);
  return g;
}

// コレクタ: マテリアルごとに結合して1メッシュにする
class Collector {
  constructor() { this.m = new Map(); }
  add(material, geom, matrix) {
    let g = clean(geom);
    if (matrix) g.applyMatrix4(matrix);
    if (!this.m.has(material)) this.m.set(material, []);
    this.m.get(material).push(g);
  }
  toGroup(name) {
    const grp = new THREE.Group(); grp.name = name;
    for (const [material, list] of this.m) {
      const g = mergeGeometries(list, false);
      const mesh = new THREE.Mesh(g, material); mesh.name = `${name}_${material.name}`;
      grp.add(mesh);
    }
    return grp;
  }
}
const M4 = (pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) =>
  new THREE.Matrix4().compose(V3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), V3(...scl));

const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);
// p0 -> p1 の梁 (断面 w x h)
function beamM(p0, p1, up = V3(0, 1, 0)) {
  const dir = p1.clone().sub(p0); const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), dir.clone().normalize());
  return { len, m: new THREE.Matrix4().compose(p0.clone().add(p1).multiplyScalar(0.5), q, V3(1, 1, 1)) };
}
function addBeam(col, material, p0, p1, w, h) {
  const { len, m } = beamM(p0, p1);
  col.add(material, boxG(w, h, len), m);
}
// 凸多角形(3D頂点)を扇状に三角形化
function polyG(pts) {
  const pos = [];
  for (let i = 1; i < pts.length - 1; i++) pos.push(...pts[0].toArray(), ...pts[i].toArray(), ...pts[i + 1].toArray());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// 角丸多角形: pts=[[u,v,r],...]  (r=0 は尖らせる)
function roundPoly(pts, seg = 5) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x, y, r = 0] = pts[i];
    if (!r) { out.push(new THREE.Vector2(x, y)); continue; }
    const pp = pts[(i + n - 1) % n], pn = pts[(i + 1) % n];
    const v = new THREE.Vector2(x, y);
    const a = new THREE.Vector2(pp[0], pp[1]).sub(v), b = new THREE.Vector2(pn[0], pn[1]).sub(v);
    const d = Math.min(r, a.length() * 0.45, b.length() * 0.45);
    const s = v.clone().add(a.normalize().multiplyScalar(d)), e = v.clone().add(b.normalize().multiplyScalar(d));
    for (let k = 0; k <= seg; k++) {
      const t = k / seg, mt = 1 - t;
      out.push(new THREE.Vector2(mt * mt * s.x + 2 * mt * t * v.x + t * t * e.x, mt * mt * s.y + 2 * mt * t * v.y + t * t * e.y));
    }
  }
  return out;
}
// 側面プロファイル(z,y) を X 方向 [x0,x1] に押し出し(面取り付き)
function extrudeProfile(pts, x0, x1, { bs = 0.02, bt = 0.02, crease = 40 } = {}) {
  const shape = new THREE.Shape(roundPoly(pts));
  const depth = Math.max(0.001, (x1 - x0) - 2 * bt);
  let g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelSegments: 2, curveSegments: 1, steps: 1 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2); // local x -> world z, local z -> -x
  g.translate((x0 + x1) / 2, 0, 0);
  // (ExtrudeGeometry は非インデックス)
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g = toCreasedNormals(g, rad(crease));
  return g;
}
const arc = (cz, cy, r, a0, a1, n) => {
  const o = [];
  for (let i = 0; i <= n; i++) { const a = rad(a0 + ((a1 - a0) * i) / n); o.push([cz + r * Math.cos(a), cy + r * Math.sin(a), 0]); }
  return o;
};

function triCount(obj) {
  let t = 0;
  obj.traverse((o) => { if (o.isMesh) { const g = o.geometry; t += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
  return t;
}

async function exportGLB(scene, file) {
  const exporter = new GLTFExporter();
  const buf = await exporter.parseAsync(scene, { binary: true, onlyVisible: false });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(buf));
  return buf.byteLength;
}

// ======================= 車 =======================
function buildCar() {
  const root = new THREE.Group(); root.name = 'car';

  const paint = mat('paint_blue', 0x0f2a6b, { metalness: 0.6, roughness: 0.3 });
  const paintD = mat('paint_blue_ds', 0x0f2a6b, { metalness: 0.6, roughness: 0.3, doubleSided: true });
  const black = mat('trim_black', 0x0b0b0c, { metalness: 0.1, roughness: 0.5 });
  const plastic = mat('plastic_dark', 0x1b1c1f, { metalness: 0.0, roughness: 0.75 });
  const dashM = mat('dash_dark', 0x202226, { metalness: 0.0, roughness: 0.8, doubleSided: true });
  const seatM = mat('seat_fabric', 0x3b3f46, { metalness: 0.0, roughness: 0.95 });
  const carpet = mat('carpet', 0x15161a, { metalness: 0.0, roughness: 1.0, doubleSided: true });
  const doorCard = mat('door_card', 0x2a2d33, { metalness: 0.0, roughness: 0.9, doubleSided: true });
  const chrome = mat('chrome', 0xd5d8dc, { metalness: 1.0, roughness: 0.18 });
  const glass = mat('glass', 0x0a1016, { metalness: 0.0, roughness: 0.05, opacity: 0.35, doubleSided: true });
  const headM = mat('headlight', 0xffffff, { roughness: 0.2, emissive: 0xffffff, emissiveIntensity: 1 });
  const tailM = mat('taillight', 0x8a0000, { roughness: 0.3, emissive: 0xff1010, emissiveIntensity: 1 });
  const screenM = mat('screen', 0x05080c, { roughness: 0.2, emissive: 0x103050, emissiveIntensity: 1 });

  const body = new Collector();
  const BELT = 0.96, W = 0.9; // 半幅

  // --- 前ブロック (ボンネット + ノーズ) ---
  const archPts = (cz, dir) => {
    // 下面ノッチ(ホイールアーチ)。dir=+1: 後ろ->前へ進む順
    const r = 0.385, cy = 0.31, bot = 0.22;
    const dx = Math.sqrt(r * r - (cy - bot) ** 2); const a0 = Math.atan2(bot - cy, dx) * 180 / Math.PI; // 負
    return dir > 0 ? arc(cz, cy, r, 180 - a0, a0, 14) : arc(cz, cy, r, a0, 180 - a0, 14);
  };
  const front = [
    [0.72, 0.22, 0], ...archPts(1.325, 1), [2.08, 0.22, 0.05], [2.155, 0.30, 0.05], [2.16, 0.62, 0.05],
    [2.13, 0.74, 0.06], [1.9, 0.83, 0.2], [1.3, 0.915, 0.4], [0.72, BELT - 0.02, 0.0],
  ];
  body.add(paint, extrudeProfile(front, -W, W, { bs: 0.02, bt: 0.03 }));
  // --- 後ブロック (リアデッキ + テール) ---
  const rear = [
    [-0.90, 0.22, 0], ...archPts(-1.325, -1).reverse().reverse(), [-2.08, 0.22, 0.05], [-2.155, 0.30, 0.05], [-2.16, 0.62, 0.05],
    [-2.12, 0.86, 0.1], [-1.98, BELT - 0.02, 0.1], [-0.90, BELT - 0.02, 0.0],
  ];
  // archPts(-1.325,-1): 前(右)→後(左)へ (a0 -> 180-a0) の順なので、そのまま使う
  body.add(paint, extrudeProfile(rear, -W, W, { bs: 0.02, bt: 0.03 }));
  // --- 側面パネル (ドア/シル): 室内は空洞 ---
  const side = [[-0.92, 0.22, 0.03], [0.74, 0.22, 0.03], [0.74, BELT - 0.02, 0.0], [-0.92, BELT - 0.02, 0.0]];
  for (const s of [1, -1]) {
    body.add(paint, extrudeProfile(side, s > 0 ? 0.80 : -W, s > 0 ? W : -0.80, { bs: 0.015, bt: 0.025 }));
    // ドアカード(室内側)
    body.add(doorCard, boxG(0.02, 0.62, 1.55), M4([s * 0.78, 0.60, -0.08]));
    // ドアシーム + ハンドル + ベルトモール
    for (const zz of [0.45, -0.36, -0.92]) body.add(black, boxG(0.012, 0.66, 0.010), M4([s * (W + 0.002), 0.58, zz]));
    for (const zz of [0.10, -0.62]) body.add(chrome, boxG(0.02, 0.025, 0.14), M4([s * (W + 0.004), 0.86, zz]));
    body.add(chrome, boxG(0.012, 0.012, 1.55), M4([s * (W + 0.002), BELT - 0.05, -0.08]));
    // サイドスカート
    body.add(black, boxG(0.03, 0.05, 1.5), M4([s * (W - 0.005), 0.25, -0.08]));
  }
  // --- 床・トンネル ---
  body.add(carpet, boxG(1.64, 0.05, 1.62), M4([0, 0.275, -0.08]));
  body.add(plastic, boxG(0.24, 0.10, 1.2), M4([0, 0.35, -0.10]));
  // リアシート(ベンチ)
  body.add(seatM, boxG(1.3, 0.14, 0.45), M4([0, 0.42, -0.68]));
  body.add(seatM, boxG(1.3, 0.50, 0.12), M4([0, 0.72, -0.86], [rad(-10), 0, 0]));

  // --- 屋根・ピラー・ガラス ---
  const roof = [[0.22, 1.36, 0.02], [0.10, 1.425, 0.1], [-0.55, 1.428, 0.2], [-1.40, 1.418, 0.1], [-1.47, 1.37, 0.03]];
  body.add(paint, extrudeProfile(roof, -0.74, 0.74, { bs: 0.012, bt: 0.025 }));
  const A_B = (s) => V3(s * 0.86, 0.975, 0.70), A_T = (s) => V3(s * 0.72, 1.395, 0.15);
  const C_B = (s) => V3(s * 0.86, 0.975, -1.96), C_T = (s) => V3(s * 0.72, 1.395, -1.43);
  const B_B = (s) => V3(s * 0.87, 0.975, -0.40), B_T = (s) => V3(s * 0.73, 1.395, -0.42);
  for (const s of [1, -1]) {
    addBeam(body, paint, A_B(s), A_T(s), 0.07, 0.06);
    addBeam(body, paint, C_B(s), C_T(s), 0.08, 0.06);
    addBeam(body, black, B_B(s), B_T(s), 0.06, 0.05);
    addBeam(body, paint, A_T(s), C_T(s).clone().setZ(-1.43), 0.05, 0.05); // ルーフレール
    addBeam(body, black, A_B(s).setY(0.96), C_B(s).setY(0.96), 0.02, 0.02);
  }
  // フロントガラス/リアガラス
  const wsB = 0.84, wsT = 0.70;
  const gl = new Collector();
  gl.add(glass, polyG([V3(-wsB + 0.03, 0.985, 0.70), V3(wsB - 0.03, 0.985, 0.70), V3(wsT - 0.02, 1.385, 0.16), V3(-wsT + 0.02, 1.385, 0.16)]));
  gl.add(glass, polyG([V3(wsT - 0.02, 1.385, -1.44), V3(-wsT + 0.02, 1.385, -1.44), V3(-0.82, 0.985, -1.955), V3(0.82, 0.985, -1.955)]));
  // サイドガラス(傾斜、ドア窓 + 後席窓)
  const zf = (y) => 0.70 - (y - 0.975) * (0.55 / 0.42);
  const zr = (y) => -1.96 + (y - 0.975) * (0.53 / 0.42);
  const xs = (y) => 0.86 - (y - 0.975) * (0.14 / 0.42);
  const y0 = 0.99, y1 = 1.375;
  const win = (za, zb, s) => {
    const hi = (y) => Math.min(za, zf(y) - 0.05), lo = (y) => Math.max(zb, zr(y) + 0.05);
    return polyG([V3(s * xs(y0), y0, hi(y0)), V3(s * xs(y0), y0, lo(y0)), V3(s * xs(y1), y1, lo(y1)), V3(s * xs(y1), y1, hi(y1))]);
  };
  for (const s of [1, -1]) { gl.add(glass, win(0.66, -0.37, s)); gl.add(glass, win(-0.44, -1.95, s)); }

  // --- 灯火・グリル・バンパー ---
  for (const s of [1, -1]) {
    body.add(headM, boxG(0.40, 0.085, 0.07), M4([s * 0.62, 0.69, 2.145], [rad(-12), 0, 0]));
    body.add(tailM, boxG(0.40, 0.11, 0.06), M4([s * 0.64, 0.80, -2.115], [rad(14), 0, 0]));
    body.add(black, boxG(0.12, 0.07, 0.05), M4([s * 0.72, 0.36, 2.15]));   // フォグ/インテーク
    body.add(tailM, boxG(0.14, 0.05, 0.05), M4([s * 0.82, 0.42, -2.15]));  // リフレクタ
  }
  body.add(black, boxG(0.95, 0.10, 0.05), M4([0, 0.55, 2.16]));      // グリル
  body.add(black, boxG(1.0, 0.10, 0.05), M4([0, 0.36, 2.15]));       // 下部インテーク
  body.add(chrome, boxG(0.50, 0.018, 0.02), M4([0, 0.60, 2.185]));    // クロームバー
  body.add(black, boxG(1.45, 0.10, 0.04), M4([0, 0.30, -2.17]));      // リアバンパー下部
  body.add(chrome, boxG(0.5, 0.018, 0.02), M4([0, 0.68, -2.17]));

  // --- ドアミラー ---
  for (const s of [1, -1]) {
    addBeam(body, black, V3(s * 0.84, 0.98, 0.52), V3(s * 0.91, 1.02, 0.50), 0.03, 0.03);
    body.add(paint, extrudeProfile([[0.12, 0.0, 0.04], [0.02, 0.07, 0.04], [-0.07, 0.06, 0.03], [-0.07, -0.04, 0.03], [0.05, -0.05, 0.04]], s > 0 ? 0.89 : -0.95, s > 0 ? 0.95 : -0.89, { bs: 0.01, bt: 0.015 }).translate(0, 1.04, 0.50));
  }

  // --- 内装 ---
  const interior = new Collector();
  // ダッシュボード
  const dash = [[0.76, 0.30, 0], [0.76, 0.975, 0.0], [0.52, 1.005, 0.03], [0.36, 0.985, 0.04], [0.27, 0.90, 0.05], [0.28, 0.66, 0.06], [0.44, 0.54, 0.05], [0.56, 0.30, 0]];
  interior.add(dashM, extrudeProfile(dash, -0.80, 0.80, { bs: 0.01, bt: 0.02 }));
  // メーターフード(運転席前)
  interior.add(plastic, extrudeProfile([[0.54, 0.97, 0.01], [0.50, 1.03, 0.02], [0.40, 1.055, 0.03], [0.33, 1.035, 0.02], [0.31, 0.97, 0.0]], -0.56, -0.18, { bs: 0.008, bt: 0.01 }));
  interior.add(screenM, boxG(0.30, 0.10, 0.008), M4([-0.37, 0.94, 0.265], [rad(-15), 0, 0]));
  // センターディスプレイ + 吹き出し口
  interior.add(screenM, boxG(0.30, 0.17, 0.02), M4([0.05, 1.03, 0.50], [rad(-35), 0, 0]));
  interior.add(plastic, boxG(0.6, 0.06, 0.04), M4([0.05, 0.82, 0.27], [rad(-10), 0, 0]));
  // センターコンソール
  interior.add(plastic, extrudeProfile([[0.34, 0.30, 0], [0.34, 0.62, 0.02], [0.05, 0.60, 0.02], [-0.40, 0.55, 0.02], [-0.40, 0.30, 0]], -0.11, 0.11, { bs: 0.01, bt: 0.015 }));
  // ステアリング(右ハンドル: x=-0.37)
  const sw = new THREE.Group();
  const swc = new Collector();
  swc.add(black, new THREE.TorusGeometry(0.175, 0.018, 8, 28));
  swc.add(black, new THREE.CylinderGeometry(0.045, 0.045, 0.04, 14), M4([0, 0, 0], [Math.PI / 2, 0, 0]));
  for (const a of [90, 210, 330]) swc.add(black, boxG(0.16, 0.025, 0.02), M4([Math.cos(rad(a)) * 0.09, Math.sin(rad(a)) * 0.09, 0], [0, 0, rad(a)]));
  const swAxis = V3(0, 0.42, -0.91).normalize();
  const swPos = V3(-0.37, 0.86, 0.10);
  const swQ = new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), swAxis);
  const swM = new THREE.Matrix4().compose(swPos, swQ, V3(1, 1, 1));
  for (const [material, list] of swc.m) for (const g of list) interior.add(material, g, swM);
  addBeam(interior, plastic, swPos.clone().add(swAxis.clone().multiplyScalar(-0.02)), V3(-0.37, 0.72, 0.42), 0.07, 0.07); // コラム
  // シート
  const seatProfile = [[0.02, 0.34, 0.03], [0.02, 0.48, 0.04], [-0.38, 0.52, 0.05], [-0.50, 1.08, 0.04], [-0.52, 1.17, 0.04], [-0.68, 1.17, 0.04], [-0.70, 1.08, 0.04], [-0.62, 0.50, 0.04], [-0.62, 0.34, 0.03]];
  for (const sx of [-0.37, 0.37]) {
    interior.add(seatM, extrudeProfile(seatProfile, sx - 0.24, sx + 0.24, { bs: 0.012, bt: 0.03 }).translate(0, 0, -0.02));
    interior.add(plastic, boxG(0.3, 0.05, 0.45), M4([sx, 0.3, -0.35]));
  }
  // ルームミラー
  interior.add(black, boxG(0.18, 0.05, 0.02), M4([0, 1.31, 0.25], [rad(8), 0, 0]));
  addBeam(interior, black, V3(0, 1.385, 0.17), V3(0, 1.33, 0.25), 0.025, 0.025);
  // 天井ライナー(屋根裏)
  interior.add(doorCard, boxG(1.36, 0.012, 1.45), M4([0, 1.352, -0.65]));
  // サンバイザー
  for (const s of [-1, 1]) interior.add(plastic, boxG(0.34, 0.015, 0.16), M4([s * 0.37, 1.34, 0.08]));

  root.add(body.toGroup('body'), interior.toGroup('interior'), gl.toGroup('glass'));

  // --- ホイール ---
  const R = 0.31, tireM = mat('tire_rubber', 0x101010, { metalness: 0.0, roughness: 0.9, doubleSided: true });
  const alloy = mat('wheel_alloy', 0xc3c7cc, { metalness: 0.95, roughness: 0.25, doubleSided: true });
  const brake = mat('brake_disc', 0x55585d, { metalness: 0.8, roughness: 0.45, doubleSided: true });
  function wheel(name, x, z, left) {
    const node = new THREE.Group(); node.name = name; node.position.set(x, R, z);
    const c = new Collector();
    c.add(tireM, fixLathe(lathe([[0.19, -0.09], [0.26, -0.10], [0.295, -0.085], [R, -0.05], [R, 0.05], [0.295, 0.085], [0.26, 0.10], [0.19, 0.09]], 36), 1));
    c.add(alloy, fixLathe(lathe([[0.17, 0.085], [0.19, 0.09], [0.195, 0.075], [0.19, -0.08], [0.17, -0.08]], 36), 1));
    c.add(brake, new THREE.CylinderGeometry(0.15, 0.15, 0.02, 28), M4([0, 0.0, 0]));
    c.add(alloy, new THREE.CylinderGeometry(0.045, 0.05, 0.03, 16), M4([0, 0.075, 0]));
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5;
      const m = new THREE.Matrix4().makeRotationY(a).multiply(M4([0.115, 0.065, 0]));
      c.add(alloy, boxG(0.15, 0.022, 0.04), m);
      const m2 = new THREE.Matrix4().makeRotationY(a + 0.0).multiply(M4([0.19, 0.075, 0], [0, 0, 0], [1, 1, 1]));
      c.add(alloy, boxG(0.04, 0.03, 0.05), m2);
    }
    const g = c.toGroup(name);
    // 軸をX、外面を+Xへ(左) / -Xへ(右)
    g.children.forEach((mesh) => { mesh.geometry.rotateZ(-Math.PI / 2); if (!left) mesh.geometry.rotateY(Math.PI); });
    // 一つのノードに複数メッシュ
    g.children.slice().forEach((m) => node.add(m));
    return node;
  }
  const WB = 1.325, TX = 0.76;
  root.add(wheel('wheel_fl', TX, WB, true), wheel('wheel_fr', -TX, WB, false), wheel('wheel_rl', TX, -WB, true), wheel('wheel_rr', -TX, -WB, false));
  return root;
}

// ======================= 旅客機 =======================
const FR = 1.95, FCY = 3.85;
const NOSE_Z = 18.0, TAIL_Z = -20.0;
function fusR(z) {
  if (z >= 14) { const u = (z - 14) / 4; return FR * Math.sqrt(Math.max(0, 1 - u * u)); }
  if (z >= -8) return FR;
  const v = Math.min(1, (-8 - z) / 12);
  return z <= TAIL_Z ? 0 : FR * (1 - 0.9 * Math.pow(v, 1.6));
}
function fusCY(z) {
  let y = FCY;
  if (z < -12) y += 1.3 * Math.pow((-12 - z) / 8, 2);
  if (z > 13) y -= 0.3 * Math.pow((z - 13) / 5, 2);
  return y;
}
// 胴体表面: θ は真上から、+X(左)側が正
const surf = (z, th, off = 0) => {
  const r = Math.max(fusR(z), 0) + off;
  return V3(r * Math.sin(th), fusCY(z) + r * Math.cos(th), z);
};

function fuselageGeom(M = 56) {
  const zs = [];
  for (let k = 14; k >= 0; k--) { const a = (k / 14) * (Math.PI / 2); zs.push(14 + 4 * Math.sin(a)); }       // 機首 18->14
  for (let z = 12; z > -8; z -= 2) zs.push(z);                                                              // 円筒
  zs.push(-8);
  for (let k = 1; k <= 14; k++) zs.push(-8 - 12 * (k / 14));                                                // 尾部 -8 -> -20
  const rings = [];
  const pos = [];
  const radAt = (z) => (z >= 18 - 1e-6 ? 0 : fusR(z));
  zs.forEach((z) => {
    const r = Math.max(radAt(z), 0), cy = fusCY(z);
    for (let j = 0; j < M; j++) { const th = (j / M) * Math.PI * 2; pos.push(r * Math.sin(th), cy + r * Math.cos(th), z); }
  });
  const idx = [];
  for (let i = 0; i < zs.length - 1; i++) for (let j = 0; j < M; j++) {
    const a = i * M + j, b = i * M + ((j + 1) % M), c = (i + 1) * M + j, d = (i + 1) * M + ((j + 1) % M);
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return orientVolume(g);
}

// 表面パッチ (z0..z1, θ0..θ1)。外向き
function patchG(z0, z1, t0, t1, off, nz = 2, nt = 2) {
  const pos = [], idx = [];
  for (let i = 0; i <= nz; i++) for (let j = 0; j <= nt; j++) {
    const z = z0 + ((z1 - z0) * i) / nz, th = t0 + ((t1 - t0) * j) / nt;
    pos.push(...surf(z, th, off).toArray());
  }
  for (let i = 0; i < nz; i++) for (let j = 0; j < nt; j++) {
    const a = i * (nt + 1) + j, b = a + 1, c = a + nt + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  // 外向き判定
  const p = g.attributes.position, n = g.attributes.normal;
  const mid = Math.floor(p.count / 2);
  const q = V3(p.getX(mid), p.getY(mid), p.getZ(mid)), axis = V3(0, fusCY(q.z), q.z);
  const nn = V3(n.getX(mid), n.getY(mid), n.getZ(mid));
  if (nn.dot(q.sub(axis)) < 0) flip(g);
  return g;
}

// 翼/尾翼ロフト。sec = {O, c(翼弦方向 LE->TE, 単位), n(厚み方向, 単位), chord, t}
const AF_N = 10;
function airfoil() {
  const yt = (x) => 5 * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const up = [], lo = [];
  for (let k = 0; k <= AF_N; k++) { const x = 0.5 * (1 - Math.cos((Math.PI * k) / AF_N)); up.push([x, yt(x)]); }
  for (let k = AF_N - 1; k >= 1; k--) { const x = 0.5 * (1 - Math.cos((Math.PI * k) / AF_N)); lo.push([x, -yt(x)]); }
  return [...up, ...lo];
}
const AF = airfoil();
function loft(secs, mirrorX = false) {
  const pos = [], idx = [];
  const P = AF.length;
  const flipX = (v) => (mirrorX ? V3(-v.x, v.y, v.z) : v);
  secs.forEach((s) => {
    AF.forEach(([x, y]) => {
      const p = s.O.clone().add(s.c.clone().multiplyScalar(x * s.chord)).add(s.n.clone().multiplyScalar(y * s.chord * s.t));
      pos.push(...flipX(p).toArray());
    });
  });
  for (let i = 0; i < secs.length - 1; i++) for (let j = 0; j < P; j++) {
    const a = i * P + j, b = i * P + ((j + 1) % P), c = (i + 1) * P + j, d = (i + 1) * P + ((j + 1) % P);
    idx.push(a, b, c, b, d, c);
  }
  // 端面キャップ
  const addCap = (i0, rev) => {
    const cpos = pos.length / 3;
    const c = V3(0, 0, 0); for (let j = 0; j < P; j++) c.add(V3(pos[(i0 + j) * 3], pos[(i0 + j) * 3 + 1], pos[(i0 + j) * 3 + 2]));
    c.multiplyScalar(1 / P); pos.push(c.x, c.y, c.z);
    for (let j = 0; j < P; j++) { const a = i0 + j, b = i0 + ((j + 1) % P); rev ? idx.push(cpos, b, a) : idx.push(cpos, a, b); }
  };
  addCap(0, false); addCap((secs.length - 1) * P, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return orientVolume(g);
}
const sec = (O, chord, t, c = V3(0, 0, -1), n = V3(0, 1, 0)) => ({ O, c, n, chord, t });

function buildAirliner() {
  const root = new THREE.Group(); root.name = 'airliner';
  const white = mat('fuselage_white', 0xf3f5f7, { metalness: 0.15, roughness: 0.35 });
  const wingM = mat('wing_gray', 0xc9ced4, { metalness: 0.35, roughness: 0.45 });
  const blue = mat('stripe_blue', 0x1f4e96, { metalness: 0.2, roughness: 0.4 });
  const winM = mat('window_dark', 0x0b1118, { metalness: 0.3, roughness: 0.1 });
  const darkM = mat('metal_dark', 0x2a2d32, { metalness: 0.8, roughness: 0.45, doubleSided: true });
  const gearM = mat('gear_gray', 0x8c9096, { metalness: 0.8, roughness: 0.4 });
  const tireM = mat('tire_rubber', 0x111111, { metalness: 0.0, roughness: 0.9 });
  const frameM = mat('cockpit_frame', 0x15171a, { metalness: 0.2, roughness: 0.6, doubleSided: true });
  const panelM = mat('cockpit_panel', 0x23262b, { metalness: 0.1, roughness: 0.8, doubleSided: true });
  const scrM = mat('cockpit_screen', 0x06090d, { metalness: 0.1, roughness: 0.2, emissive: 0x1c5a8c, emissiveIntensity: 0.8, doubleSided: true });
  const navR = mat('nav_red', 0xff2020, { roughness: 0.3, emissive: 0xff2020, emissiveIntensity: 1 });
  const navG = mat('nav_green', 0x20ff40, { roughness: 0.3, emissive: 0x20ff40, emissiveIntensity: 1 });
  const navW = mat('nav_white', 0xffffff, { roughness: 0.3, emissive: 0xffffff, emissiveIntensity: 1 });

  const c = new Collector();
  c.add(white, fuselageGeom());

  // ---- 窓・ストライプ ----
  const cabinTh = Math.acos(0.45 / FR);
  const ch = 0.21 / FR, cw = 0.15;
  for (const s of [1, -1]) {
    const th = s > 0 ? cabinTh : -cabinTh;
    for (let z = 11.2; z > -9.2; z -= 0.56) {
      if (Math.abs(z - 4.9) < 0.3 || Math.abs(z + 7.0) < 0.3) continue; // ドア部
      c.add(winM, patchG(z - cw, z + cw, th - s * ch, th + s * ch, 0.03, 1, 2));
    }
    // チートライン
    const t0 = s > 0 ? rad(86.5) : -rad(93.5), t1 = s > 0 ? rad(93.5) : -rad(86.5);
    const zl = []; for (let z = 16.2; z >= -17.5; z -= 1.0) zl.push(z);
    for (let i = 0; i < zl.length - 1; i++) c.add(blue, patchG(zl[i + 1], zl[i], t0, t1, 0.018, 1, 2));
    // 前方コックピット窓 (正面 + 側面) ※ 内側からは背面カリングで透けて見える
    c.add(winM, patchG(16.30, 17.35, s * rad(6), s * rad(52), 0.04, 10, 10));
    c.add(winM, patchG(15.20, 16.15, s * rad(34), s * rad(72), 0.04, 6, 6));
  }

  // ---- 翼 ----
  const dih = Math.tan(rad(5));
  const wingSecs = [
    sec(V3(1.2, 2.75, 4.4), 6.8, 0.13),
    sec(V3(4.0, 2.75 + 2.8 * dih, 4.4 - 2.8 * 0.50), 5.9, 0.12),
    sec(V3(9.0, 2.75 + 7.8 * dih, 4.4 - 7.8 * 0.50), 3.9, 0.11),
    sec(V3(17.2, 2.75 + 16.0 * dih, 4.4 - 16.0 * 0.51), 1.7, 0.10),
  ];
  const tipY = wingSecs[3].O.y, tipZ = wingSecs[3].O.z;
  for (const mir of [false, true]) c.add(wingM, loft(wingSecs, mir));
  // ウィングレット (シャークレット)
  const wl = [
    sec(V3(17.2, tipY, tipZ), 1.7, 0.10, V3(0, 0, -1), V3(1, 0, 0)),
    sec(V3(17.35, tipY + 0.9, tipZ - 0.45), 1.15, 0.09, V3(0, 0, -1), V3(1, 0, 0)),
    sec(V3(17.5, tipY + 1.8, tipZ - 0.9), 0.6, 0.08, V3(0, 0, -1), V3(1, 0, 0)),
  ];
  for (const mir of [false, true]) c.add(wingM, loft(wl, mir));
  // 翼胴フェアリング
  c.add(white, new THREE.SphereGeometry(1, 28, 14), M4([0, 2.25, -0.3], [0, 0, 0], [2.05, 0.62, 5.6]));
  // 水平尾翼
  const sdih = Math.tan(rad(6));
  const hs = [
    sec(V3(0.6, 4.15, -12.8), 3.8, 0.10),
    sec(V3(3.5, 4.15 + 2.9 * sdih, -12.8 - 2.9 * 0.62), 2.4, 0.09),
    sec(V3(6.4, 4.15 + 5.8 * sdih, -12.8 - 5.8 * 0.62), 1.4, 0.08),
  ];
  for (const mir of [false, true]) c.add(wingM, loft(hs, mir));
  // 垂直尾翼
  const fin = [
    sec(V3(0, 4.4, -11.4), 7.0, 0.10, V3(0, 0, -1), V3(1, 0, 0)),
    sec(V3(0, 7.2, -11.4 - 2.8 * 0.72), 5.0, 0.09, V3(0, 0, -1), V3(1, 0, 0)),
    sec(V3(0, 11.65, -11.4 - 7.25 * 0.72), 2.6, 0.08, V3(0, 0, -1), V3(1, 0, 0)),
  ];
  c.add(white, loft(fin));

  // ---- エンジン ----
  const nacZ = 3.9;
  for (const s of [1, -1]) {
    const ex = s * 5.8, ey = 2.05;
    const place = new THREE.Matrix4().compose(V3(ex, ey, nacZ - 4.2), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), V3(1, 1, 1));
    // 局所 y = 前方(+z)
    c.add(white, fixLathe(lathe([[0.95, 4.20], [1.04, 4.19], [1.09, 4.10], [1.10, 3.90], [1.12, 3.0], [1.08, 2.0], [0.92, 0.9], [0.74, 0.1], [0.70, 0.0]], 40), 1), place);
    c.add(darkM, fixLathe(lathe([[0.62, 0.0], [0.70, 0.9], [0.84, 2.2], [0.87, 3.2], [0.88, 3.9], [0.95, 4.20]], 40), -1), place);
    c.add(darkM, new THREE.CircleGeometry(0.88, 32), M4([ex, ey, nacZ - 0.9], [0, 0, 0]));
    // ファンブレード + スピナー
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const m = new THREE.Matrix4().makeTranslation(ex, ey, nacZ - 0.88).multiply(new THREE.Matrix4().makeRotationZ(a)).multiply(M4([0, 0.58, 0], [0.35, 0, 0]));
      c.add(gearM, boxG(0.10, 0.60, 0.015), m);
    }
    c.add(wingM, new THREE.ConeGeometry(0.26, 0.55, 20), M4([ex, ey, nacZ - 0.65], [Math.PI / 2, 0, 0]));
    c.add(darkM, new THREE.ConeGeometry(0.46, 1.4, 20), M4([ex, ey, -0.1], [-Math.PI / 2, 0, 0]));
    // パイロン
    c.add(white, boxG(0.34, 0.9, 2.6), M4([ex, 2.95, 1.6]));
  }

  // ---- 降着装置 ----
  const wheelG = (r, w) => new THREE.CylinderGeometry(r, r, w, 28).rotateZ(Math.PI / 2);
  for (const s of [1, -1]) {
    const gx = s * 3.9;
    c.add(gearM, new THREE.CylinderGeometry(0.14, 0.14, 2.2, 14), M4([gx, 1.7, -0.2]));
    c.add(gearM, new THREE.CylinderGeometry(0.07, 0.07, 1.4, 10), M4([gx - s * 0.35, 1.85, -0.2], [0, 0, s * 0.35]));
    for (const dx of [-0.36, 0.36]) {
      c.add(tireM, wheelG(0.58, 0.38), M4([gx + dx, 0.58, -0.2]));
      c.add(gearM, wheelG(0.30, 0.40), M4([gx + dx, 0.58, -0.2]));
    }
    c.add(gearM, new THREE.CylinderGeometry(0.06, 0.06, 1.0, 10).rotateZ(Math.PI / 2), M4([gx, 0.58, -0.2]));
    c.add(white, boxG(0.04, 0.9, 2.2), M4([gx - s * 0.75, 2.2, -0.2])); // 脚庫扉
  }
  // 前脚
  c.add(gearM, new THREE.CylinderGeometry(0.11, 0.11, 1.9, 14), M4([0, 1.3, 13.3]));
  for (const dx of [-0.26, 0.26]) {
    c.add(tireM, wheelG(0.36, 0.22), M4([dx, 0.36, 13.3]));
    c.add(gearM, wheelG(0.18, 0.24), M4([dx, 0.36, 13.3]));
  }
  c.add(gearM, new THREE.CylinderGeometry(0.05, 0.05, 0.6, 10).rotateZ(Math.PI / 2), M4([0, 0.36, 13.3]));
  c.add(white, boxG(0.04, 0.9, 1.6), M4([0.55, 2.0, 13.3]));
  c.add(white, boxG(0.04, 0.9, 1.6), M4([-0.55, 2.0, 13.3]));

  // ---- 航法灯 ----
  const tipTE = tipZ - 1.7;
  c.add(navR, new THREE.SphereGeometry(0.11, 10, 8), M4([17.28, tipY + 0.2, tipTE + 0.1]));
  c.add(navG, new THREE.SphereGeometry(0.11, 10, 8), M4([-17.28, tipY + 0.2, tipTE + 0.1]));
  const tz = TAIL_Z + 0.15;
  c.add(navW, new THREE.SphereGeometry(0.11, 10, 8), M4([0, fusCY(tz), tz]));

  // ---- コックピット内部(一人称視点用) ----
  const cp = new Collector();
  // グレアシールド+計器盤 (z,y) 側面プロファイルを幅 x ±1.3 に押し出し
  const gl = [[15.55, 4.10, 0.02], [15.55, 4.55, 0.04], [15.72, 4.69, 0.05], [16.10, 4.73, 0.04], [16.90, 4.50, 0.03], [16.90, 4.10, 0.0]];
  cp.add(panelM, extrudeProfile(gl, -1.30, 1.30, { bs: 0.01, bt: 0.02 }));
  // ディスプレイ(計器盤の背面に)
  for (const x of [-0.95, -0.5, 0.0, 0.5, 0.95]) cp.add(scrM, boxG(0.34, 0.26, 0.01), M4([x, 4.32, 15.535], [rad(-8), 0, 0]));
  // センターペデスタル
  cp.add(panelM, boxG(0.34, 0.40, 1.2), M4([0, 3.85, 14.9]));
  for (const x of [-0.5, 0.5]) cp.add(panelM, boxG(0.22, 0.06, 0.40), M4([x, 4.25, 15.1]));
  // 窓枠 (各ペインの縁に沿って梁)
  const frameBeam = (a, b, w) => addBeam(cp, frameM, a, b, w, w);
  for (const s of [1, -1]) {
    const pane = (z0, z1, t0, t1, w) => {
      const P = (z, t) => surf(z, s * t, 0.0);
      frameBeam(P(z0, t1), P(z1, t1), w);           // 外側ピラー
      frameBeam(P(z0, t0), P(z0, t1), w);           // 上端(ヘッダ)
    };
    pane(16.30, 17.35, rad(6), rad(52), 0.04);
    frameBeam(surf(16.15, s * rad(34), 0), surf(16.15, s * rad(72), 0), 0.05); // 側窓の前縁ピラー
  }
  // 中央ピラー
  frameBeam(surf(16.30, 0, -0.02), surf(17.5, 0, -0.02), 0.10);
  // シート背もたれ (視点後方)
  for (const x of [-0.5, 0.5]) cp.add(panelM, boxG(0.5, 0.9, 0.2), M4([x, 4.0, 14.2]));

  root.add(c.toGroup('airframe'), cp.toGroup('cockpit'));
  return root;
}

// ======================= main =======================
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/models');
const car = buildCar();
const air = buildAirliner();
for (const [obj, name] of [[car, 'car.glb'], [air, 'airliner.glb']]) {
  const scene = new THREE.Scene(); scene.add(obj);
  const bytes = await exportGLB(scene, resolve(outDir, name));
  const bb = new THREE.Box3().setFromObject(obj);
  console.log(`${name}: ${(bytes / 1024).toFixed(0)} KB, tris=${triCount(obj)}, bbox x:${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)} y:${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)} z:${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)}`);
}
