// WebAR表示 (LocAR.js + three.js)
// - 選択した避難先への矢印 + 説明ボード
// - 周辺の伝承・史料ポイントのボード表示
// - 史料に津波高の記録がある地点は「記録高ゲージ」(柱) で高さを体感できるようにする
// 開発・発表は fakeGps(デモモード)、実機確認は屋外で行う (CLAUDE.md)。
//
// LocAR 0.1.x では LocationBased(投影とGPS/fakeGps) と DeviceOrientationControls(姿勢)を使う。
// カメラ映像は堅牢性のため自前の <video> 背景で管理する（LocARのWebcamクラスに依存しない）。
import * as THREE from "three";
import * as LocAR from "locar";
import { LookControls } from "./lookcontrols.js";
import { loadTown, buildTownGroup } from "./town.js";
import { bearingDeg, distanceM, destPoint, formatDist, toEastNorth, fromEastNorth } from "./geo.js";
import {
  traditionsWithin, categoryOf, CATEGORY_COLORS,
  nearestTsunamiFacilities, facilities,
} from "./data.js";

let renderer, scene, camera, locar, controls, lookControls, video, videoStream;
let started = false;
let mode = "live";          // "live"=カメラ＋方位センサー / "sim"=歩いて見回す検証モード
let envGroup = null;         // 検証モードの合成シーン（空・地面・東西南北）
let curPos = null;          // {lat,lng}
let target = null;          // 選択中の避難施設
let arrowGroup = null;
let targetBoard = null;
let traditionObjs = [];
let traditionsBuiltAt = null;
let onUpdateCb = null;
let onStatusCb = null;

// --- 検証モード(歩ける3D)の状態 ---
const EYE_Y = 0;            // 目線の高さ基準（地面は EYE_Y-1.5）
const GROUND_Y = EYE_Y - 1.5;
const GUIDE_Y = EYE_Y - 1.15; // ガイド矢印の高さ。目線より下げて町並みの視界を塞がない
let simOrigin = null;       // GPS原点 {lat,lng}（ENUの基準）
let simWorld = null;        // 建物・看板・地面などをまとめるGroup
let guideArrow = null;      // カメラに追従して目的地を指す浮遊矢印
let simBuilt = false;
let routeGeom = null;       // OSRM経路形状(GeoJSON LineString)。あれば道筋をこれに沿わせる

// ENU(東/北 メートル)でオブジェクトを配置（北=-Z, 東=+X）
function placeENU(obj, lat, lng, y = 0) {
  const { east, north } = toEastNorth(lat, lng, simOrigin.lat, simOrigin.lng);
  obj.position.set(east, y, -north);
}
// カメラの現在位置(ENU) → 実効緯度経度
function effectiveLatLng() {
  if (mode === "sim" && simOrigin && camera) {
    return fromEastNorth(camera.position.x, -camera.position.z, simOrigin.lat, simOrigin.lng);
  }
  return curPos;
}

export function isStarted() { return started; }
export function getMode() { return mode; }
export function setOnUpdate(cb) { onUpdateCb = cb; }
export function setOnStatus(cb) { onStatusCb = cb; }
function status(msg, kind) { if (onStatusCb) onStatusCb(msg, kind); }

// 検証モードの現在方位（HUD用）。センサーモードでは null。
export function currentHeading() {
  return lookControls ? lookControls.headingDeg() : null;
}
// 歩いて移動した後の実効現在地（HUDの距離・方向計算用）。live/原点時は curPos。
export function effectivePos() {
  return effectiveLatLng();
}
export function faceTarget() {
  if (lookControls && target && target.lat != null) {
    const eff = effectiveLatLng();
    if (eff) lookControls.faceBearing(bearingDeg(eff.lat, eff.lng, target.lat, target.lng));
  }
}
export function faceNorth() {
  if (lookControls) lookControls.reset();
}

// ズーム（望遠）: FOVを狭めて遠くのものを拡大する。zoom=1で標準70°、最大約3.5倍
const BASE_FOV = 70;
let zoom = 1;
function applyZoom() {
  if (!camera) return;
  camera.fov = BASE_FOV / zoom;
  camera.updateProjectionMatrix();
  if (onStatusCb && zoom > 1.05) status(`ズーム ×${zoom.toFixed(1)}（遠くを拡大中）`, "info");
}
export function setZoom(z) { zoom = Math.min(3.5, Math.max(1, z)); applyZoom(); }
export function zoomBy(factor) { setZoom(zoom * factor); }
export function getZoom() { return zoom; }

function makeTextSprite(lines, { accent = "#0d2b45", width = 460 } = {}) {
  const pad = 18, lineH = 34, fontPx = 26;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = width * 2;
  canvas.height = (lines.length * lineH + pad * 2 + 8) * 2;
  ctx.scale(2, 2);
  const w = width, h = lines.length * lineH + pad * 2 + 8;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 14);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 10, h);
  lines.forEach((ln, i) => {
    ctx.font = `${ln.bold ? "700 " : ""}${ln.size ?? fontPx}px sans-serif`;
    ctx.fillStyle = ln.color ?? "#1d2429";
    ctx.fillText(ln.text, pad + 6, pad + 4 + lineH * i + fontPx * 0.8);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  const scale = 0.013; // 1px ≒ 1.3cm → 12m先で読める大きさ
  sp.scale.set(w * scale, h * scale, 1);
  return sp;
}

// 矢印は+Z向きに組む。Object3D.lookAt()は「+Z軸」を目標に向けるため、
// -Z向きに組むと常に目的地の正反対を指してしまう。
function buildArrow(color = 0xd32f2f, opacity = 1) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.4, 12), mat);
  shaft.rotation.x = Math.PI / 2; // Z方向(進行方向)に寝かせる
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 16), mat);
  head.rotation.x = Math.PI / 2;
  head.position.z = 1.7;
  shaft.position.z = 0.2;
  g.add(shaft, head);
  return g;
}

// 史料の記録津波高を示すゲージ柱（高さ heightM [m]）
function buildHeightGauge(heightM, label) {
  const g = new THREE.Group();
  const groundY = -1.5; // 目線(=原点)から地面までの目安
  const mat = new THREE.MeshBasicMaterial({
    color: 0x1e88e5, transparent: true, opacity: 0.45,
  });
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, heightM, 14), mat);
  pole.position.y = groundY + heightM / 2;
  g.add(pole);
  // 1mごとの目盛りリング
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 1; i <= Math.floor(heightM); i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.045, 8, 24), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = groundY + i;
    g.add(ring);
  }
  // 天端の水面板
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 0.06, 24),
    new THREE.MeshBasicMaterial({ color: 0x1565c0, transparent: true, opacity: 0.55 }));
  top.position.y = groundY + heightM;
  g.add(top);
  const tag = makeTextSprite(
    [{ text: label, bold: true, size: 28, color: "#0d47a1" }], { accent: "#1565c0", width: 430 });
  tag.position.y = groundY + heightM + 0.9;
  g.add(tag);
  return g;
}

function clearObj(o) {
  if (o && o.parent) o.parent.remove(o);
}

const COLOR_HEX = {
  tower: 0x1565c0, inochiyama: 0x2e7d32, building: 0x6a1b9a,
  shelter: 0x455a64, tradition: 0xef6c00, unsure: 0x8d8d8d,
};

// 空のグラデーション背景（スクリーン固定）
function setSky() {
  const sky = document.createElement("canvas");
  sky.width = 16; sky.height = 256;
  const sc = sky.getContext("2d");
  const grd = sc.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#7fb2e5");
  grd.addColorStop(0.55, "#cfe3f5");
  grd.addColorStop(1, "#e9eef2");
  sc.fillStyle = grd; sc.fillRect(0, 0, 16, 256);
  scene.background = new THREE.CanvasTexture(sky);
}

// 詳しい地面: 細かいグリッド(5m)＋同心距離リング＋方位放射線＋距離ラベル＋東西南北標識
function buildGround(g) {
  // 床とグリッドは町並みレイヤー（town.js: renderOrder -9..-4）より先に描く。
  // 半透明同士の上塗り順を固定しないと、後から描いた床が海・道路を washed out にする。
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(900, 64),
    new THREE.MeshBasicMaterial({ color: 0xd7e2d2, transparent: true, opacity: 0.6 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = GROUND_Y - 0.06;
  floor.renderOrder = -20;
  g.add(floor);

  // 細かいグリッド(5m間隔・近距離)＋粗いグリッド(50m・遠距離)
  const fine = new THREE.GridHelper(400, 80, 0x9bb0a6, 0xc4d2bd);
  fine.position.y = GROUND_Y - 0.02; fine.material.opacity = 0.55; fine.material.transparent = true;
  fine.renderOrder = -19;
  g.add(fine);
  const coarse = new THREE.GridHelper(1600, 32, 0x789, 0x9bb0a6);
  coarse.position.y = GROUND_Y - 0.04; coarse.material.opacity = 0.4; coarse.material.transparent = true;
  coarse.renderOrder = -19;
  g.add(coarse);

  // 同心円の距離リング
  for (const d of [10, 25, 50, 100, 200, 400, 800]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(d - 0.7, d + 0.7, 120),
      new THREE.MeshBasicMaterial({
        color: d <= 50 ? 0x2e7d32 : 0x546e7a, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide,
      }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = GROUND_Y + 0.02; // 町並みの道路面より上
    g.add(ring);
    for (const [lx, lz] of [[0, -d], [d, 0], [0, d], [-d, 0]]) {
      const lab = makeTextSprite([{ text: `${d}m`, bold: true, size: 30, color: "#37474f" }],
        { accent: "#546e7a", width: 150 });
      lab.position.set(lx, GROUND_Y + 1.0, lz);
      lab.scale.multiplyScalar(0.8 + d / 500);
      g.add(lab);
    }
  }

  // 8方位の放射線
  const radialMat = new THREE.LineBasicMaterial({ color: 0x90a4ae, transparent: true, opacity: 0.5 });
  for (let a = 0; a < 360; a += 45) {
    const rad = (a * Math.PI) / 180;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, GROUND_Y + 0.025, 0),
      new THREE.Vector3(Math.sin(rad) * 800, GROUND_Y + 0.025, -Math.cos(rad) * 800),
    ]);
    const line = new THREE.Line(geo, radialMat);
    line.renderOrder = -19; // 町並みレイヤーの下
    g.add(line);
  }

  // 東西南北の標識
  for (const d of [
    { t: "北 N", x: 0, z: -45, c: "#d32f2f" }, { t: "東 E", x: 45, z: 0, c: "#1565c0" },
    { t: "南 S", x: 0, z: 45, c: "#455a64" }, { t: "西 W", x: -45, z: 0, c: "#6a1b9a" },
  ]) {
    const sp = makeTextSprite([{ text: d.t, bold: true, size: 40, color: d.c }], { accent: d.c, width: 220 });
    sp.position.set(d.x, GROUND_Y + 3, d.z); sp.scale.multiplyScalar(1.8);
    g.add(sp);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5, 8),
      new THREE.MeshBasicMaterial({ color: d.c }));
    post.position.set(d.x, GROUND_Y + 2.5, d.z);
    g.add(post);
  }
}

// 避難施設を立体の建物として配置（種別で色・高さ）。targetは強調＋ビーコン。
function building3D(f, isTarget) {
  const grp = new THREE.Group();
  const cat = categoryOf(f);
  const color = COLOR_HEX[cat] ?? 0x607d8b;
  const h = cat === "building" ? 13 : cat === "tower" ? 11 : cat === "shelter" ? 9 : 7;
  if (cat === "inochiyama") {
    // 命山は盛土＝円錐
    const mound = new THREE.Mesh(new THREE.ConeGeometry(6, h, 24),
      new THREE.MeshBasicMaterial({ color }));
    mound.position.y = GROUND_Y + h / 2; grp.add(mound);
  } else {
    const w = cat === "building" ? 10 : 6;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, w),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
    box.position.y = GROUND_Y + h / 2; grp.add(box);
    // 階を表す横ライン
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    edges.position.copy(box.position); grp.add(edges);
  }
  if (isTarget) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 60, 12),
      new THREE.MeshBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.4 }));
    beam.position.y = GROUND_Y + 30; grp.add(beam);
  }
  const heightLine = f.evacuation_height_m != null
    ? `避難高さ ${f.evacuation_height_m}m` : (f.evacuation_place ?? "");
  const label = makeTextSprite([
    { text: (isTarget ? "🎯 " : "") + f.name, bold: true, size: 30, color: isTarget ? "#c62828" : "#0d2b45" },
    { text: `${f.type}｜${heightLine}`, size: 22, color: "#41505b" },
  ], { accent: color, width: 520 });
  label.position.y = GROUND_Y + h + 2.4;
  label.scale.multiplyScalar(isTarget ? 1.3 : 1.05);
  grp.add(label);
  grp.userData.labelBaseY = GROUND_Y + h + 2.4;
  return grp;
}

// 伝承・史料の看板（柱＋ボード）＋記録高ゲージ
function signboard(t) {
  const grp = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.5, 8),
    new THREE.MeshBasicMaterial({ color: 0x8d6e63 }));
  post.position.y = GROUND_Y + 2.25; grp.add(post);
  const board = makeTextSprite([
    { text: `📜 ${t.title}`, bold: true, size: 26, color: "#7a3b00" },
    { text: `${t.disaster}`, size: 21, color: "#41505b" },
    ...wrap(t.evacuation_message, 28).slice(0, 2).map((x) => ({ text: x, size: 20, color: "#5d3200" })),
    { text: "※伝承は補助情報。避難判断は公式情報で。", size: 18, color: "#8a6d3b" },
  ], { accent: CATEGORY_COLORS.tradition, width: 560 });
  board.position.y = GROUND_Y + 5.6; grp.add(board);
  if (t.recorded_height_m != null) {
    const gauge = buildHeightGauge(t.recorded_height_m,
      `${t.disaster.includes("安政") ? "安政の津波" : "記録津波"} 記録高 約${t.recorded_height_m}m（史料）`);
    gauge.position.x = 3; grp.add(gauge);
  }
  return grp;
}

// 目的地までの道筋（地面のストリップ＋シェブロン＋距離マーカー）
// OSRMの経路形状(routeGeom)があれば道なりに、無ければ直線で描く。
function buildRoutePath(g, tLat, tLng) {
  const pts = routePoints(tLat, tLng);
  if (import.meta.env?.DEV) {
    window.__arRouteMode = pts.length > 2 ? "geometry" : "straight";
  }
  if (pts.length < 2) return;

  const W = 2.2;
  // 経路はGoogleマップのナビ風に「青い帯＋白いシェブロン」で、道筋の位置をはっきり示す
  const stripMat = new THREE.MeshBasicMaterial({
    color: 0x1a73e8, transparent: true, opacity: 0.78, side: THREE.DoubleSide });
  let acc = 0;            // 道なり累計距離
  let nextChev = 16;      // 次のシェブロン位置（足元すぐは置かない）
  let nextLab = 60;       // 次の「あと◯m」位置
  const total = pathLength(pts);

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const seg = Math.hypot(dx, dz);
    if (seg < 0.3) continue;
    const ux = dx / seg, uz = dz / seg;
    const px = -uz, pz = ux; // 幅方向
    // 区間ごとのストリップ
    const verts = new Float32Array([
      a.x + px * W, GROUND_Y + 0.03, a.z + pz * W,
      a.x - px * W, GROUND_Y + 0.03, a.z - pz * W,
      b.x + px * W, GROUND_Y + 0.03, b.z + pz * W,
      b.x - px * W, GROUND_Y + 0.03, b.z - pz * W,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geo.setIndex([0, 1, 2, 1, 3, 2]);
    const strip = new THREE.Mesh(geo, stripMat);
    strip.renderOrder = 1; // 町並みの道路・緑地レイヤーより前面に
    g.add(strip);
    // シェブロン（道なり約22m間隔・進行方向を向ける）。青帯の上に白でナビ感を出す
    const rotY = Math.atan2(ux, uz);
    while (nextChev <= acc + seg && nextChev < total - 4) {
      const t = (nextChev - acc) / seg;
      const chev = makeChevron(0xffffff);
      chev.position.set(a.x + dx * t, GROUND_Y + 0.06, a.z + dz * t);
      chev.rotation.y = rotY;
      g.add(chev);
      nextChev += 22;
    }
    // 「あと◯m」マーカー（道なり約60m間隔）
    while (nextLab <= acc + seg && nextLab < total - 10) {
      const t = (nextLab - acc) / seg;
      const lab = makeTextSprite(
        [{ text: `あと ${Math.round(total - nextLab)}m`, bold: true, size: 24, color: "#0d47a1" }],
        { accent: "#1a73e8", width: 220 });
      lab.position.set(a.x + dx * t, GROUND_Y + 1.4, a.z + dz * t);
      g.add(lab);
      nextLab += 60;
    }
    acc += seg;
  }
}

// 道筋の頂点列(ENU)。routeGeomがあればその形状、無ければ[原点→目的地]の直線。
function routePoints(tLat, tLng) {
  const coords = routeGeom?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    return coords.map(([lng, lat]) => {
      const { east, north } = toEastNorth(lat, lng, simOrigin.lat, simOrigin.lng);
      return { x: east, z: -north };
    });
  }
  const { east, north } = toEastNorth(tLat, tLng, simOrigin.lat, simOrigin.lng);
  return [{ x: 0, z: 0 }, { x: east, z: -north }];
}

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  return len;
}

// 進行方向を示すシェブロン（矢羽根）。小さめ＆半透明にして、
// 道筋の上に重なっても煩雑にならず「進む向き」だけが読み取れるようにする。
function makeChevron(color) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.95); shape.lineTo(0.7, -0.2); shape.lineTo(0.32, -0.2);
  shape.lineTo(0, 0.32); shape.lineTo(-0.32, -0.2); shape.lineTo(-0.7, -0.2);
  const geo = new THREE.ShapeGeometry(shape);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2; // 道筋ストリップ・町並みレイヤーより前面に
  return m;
}

// 検証モードの3D世界をまとめて構築（GPS原点が決まった時に1回）
function buildSimWorld() {
  setSky();
  const g = new THREE.Group();
  buildGround(g);

  // 近くの津波避難施設を立体建物として配置（target含む先頭8件＋target）
  const near = nearestTsunamiFacilities(simOrigin, 8);
  const shown = new Set();
  for (const f of near) {
    const isT = target && f.id === target.id;
    const b = building3D(f, isT);
    placeENU(b, f.lat, f.lng, 0);
    g.add(b); shown.add(f.id);
  }
  if (target && target.lat != null && !shown.has(target.id)) {
    const b = building3D(target, true);
    placeENU(b, target.lat, target.lng, 0);
    g.add(b);
  }

  // 周辺の伝承・史料を看板として配置
  for (const t of traditionsWithin(simOrigin, 900).slice(0, 8)) {
    const s = signboard(t);
    placeENU(s, t.lat, t.lng, 0);
    g.add(s);
  }

  // 目的地への道筋
  if (target && target.lat != null) buildRoutePath(g, target.lat, target.lng);

  scene.add(g);
  simWorld = g;
  simBuilt = true;

  // 実際の町並み（OpenStreetMap・無料）を非同期で読み込んで重ねる
  addTownAsync(g);

  // カメラに追従して目的地を指す浮遊ガイド矢印（小さめ・半透明・足元寄り）
  guideArrow = buildArrow(0xff5252, 0.85);
  guideArrow.scale.setScalar(0.6);
  scene.add(guideArrow);
  updateGuideArrow();
}

// OpenStreetMapの町並み3Dを読み込んでsimWorldへ追加。失敗してもビュー自体は続行する。
async function addTownAsync(world) {
  status("町並みデータ（OpenStreetMap）を読み込み中…", "info");
  try {
    const town = await loadTown(simOrigin);
    // 読み込み中に終了・再起動していたら古いシーンには足さない
    if (!started || mode !== "sim" || simWorld !== world) return;
    world.add(buildTownGroup(town, simOrigin, GROUND_Y));
    status(`実際の町並みを立体表示中（建物${town.buildings.length}棟・形と高さはOpenStreetMapによる概形）` +
      "© OpenStreetMap contributors", "info");
  } catch {
    if (!started || simWorld !== world) return;
    status("町並みデータを取得できませんでした（オフライン？）。施設・伝承のみ表示します。", "warn");
  }
}

// ガイド矢印をカメラ前方の足元寄りに置き、目的地（実位置）へ向ける
function updateGuideArrow() {
  if (!guideArrow || !target || target.lat == null) return;
  guideArrow.visible = zoom <= 1.5; // 望遠中は視界を塞ぐだけなので隠す
  if (!guideArrow.visible) return;
  const cam = camera.position;
  const yaw = lookControls ? lookControls.yaw : 0;
  // カメラ前方7m・目線より下に配置（町並みの視界を塞がない）
  guideArrow.position.set(cam.x - Math.sin(yaw) * 7, GUIDE_Y, cam.z - Math.cos(yaw) * 7);
  const { east, north } = toEastNorth(target.lat, target.lng, simOrigin.lat, simOrigin.lng);
  guideArrow.lookAt(east, GUIDE_Y, -north);
}

// 歩いて移動した時: 実効現在地で距離・方向を更新し、ガイド矢印を向け直す
function onSimMove() {
  updateGuideArrow();
  if (!target || target.lat == null) return;
  const eff = effectiveLatLng();
  const dist = distanceM(eff.lat, eff.lng, target.lat, target.lng);
  const brg = bearingDeg(eff.lat, eff.lng, target.lat, target.lng);
  if (onUpdateCb) onUpdateCb({ dist, brg, eff });
}

function placeAt(obj, lat, lng, y = 0) {
  // LocARの内部投影で lon/lat → ワールド座標へ
  const [x, z] = locar.lonLatToWorldCoords(lng, lat);
  obj.position.set(x, y, z);
}

function wrap(text, n) {
  const out = [];
  let s = String(text ?? "");
  while (s.length > 0 && out.length < 6) { out.push(s.slice(0, n)); s = s.slice(n); }
  return out;
}

// 避難先矢印と説明ボードを現在地に合わせて再配置（現地モード=LocAR投影用）
function refreshTarget() {
  if (mode === "sim") return; // 検証モードは buildSimWorld で配置
  if (!curPos || !target || !started || target.lat == null) return;
  const dist = distanceM(curPos.lat, curPos.lng, target.lat, target.lng);
  const brg = bearingDeg(curPos.lat, curPos.lng, target.lat, target.lng);
  const anchor = destPoint(curPos.lat, curPos.lng, brg, Math.min(dist, 14));

  if (!arrowGroup) {
    arrowGroup = buildArrow();
    scene.add(arrowGroup);
  }
  placeAt(arrowGroup, anchor.lat, anchor.lng, -0.3);
  // 矢印を目標方向へ向ける（lookAtで施設の実位置を向く）
  const [tx, tz] = locar.lonLatToWorldCoords(target.lng, target.lat);
  arrowGroup.lookAt(tx, -0.3, tz);

  clearObj(targetBoard);
  const heightLine = target.evacuation_height_m != null
    ? `避難可能高さ ${target.evacuation_height_m}m / ${target.evacuation_place}`
    : `避難可能場所: ${target.evacuation_place}`;
  const whyLines = wrap(target.why, 26);
  targetBoard = makeTextSprite([
    { text: `→ ${target.name} まで ${formatDist(dist)}`, bold: true, size: 30 },
    { text: `種別: ${target.type}（${target.subtype}）`, size: 24, color: "#41505b" },
    { text: heightLine, size: 24, color: "#41505b" },
    { text: `理由: ${whyLines[0] ?? ""}`, size: 22, color: "#0d47a1" },
    ...whyLines.slice(1, 3).map((t) => ({ text: `　${t}`, size: 22, color: "#0d47a1" })),
  ], { accent: CATEGORY_COLORS[categoryOf(target)] });
  targetBoard.position.set(arrowGroup.position.x, 2.1, arrowGroup.position.z);
  scene.add(targetBoard);

  if (onUpdateCb) onUpdateCb({ dist, brg });
}

// 周辺の伝承ポイント（実方位に、遠いものは見える距離にクランプして表示・現地モード用）
function refreshTraditions() {
  if (mode === "sim") return; // 検証モードは buildSimWorld で配置
  if (!curPos || !started) return;
  if (traditionsBuiltAt &&
      distanceM(traditionsBuiltAt.lat, traditionsBuiltAt.lng, curPos.lat, curPos.lng) < 50) {
    return;
  }
  traditionsBuiltAt = { ...curPos };
  traditionObjs.forEach(clearObj);
  traditionObjs = [];

  const list = traditionsWithin(curPos, 1500).slice(0, 5);
  list.forEach((t, i) => {
    const brg = bearingDeg(curPos.lat, curPos.lng, t.lat, t.lng);
    const showDist = Math.min(t._dist, 38 + i * 7); // 実際は遠くても38m+α先に見せる
    const p = destPoint(curPos.lat, curPos.lng, brg, showDist);

    const board = makeTextSprite([
      { text: `📜 ${t.title}`, bold: true, size: 26, color: "#7a3b00" },
      { text: `この方向 約${formatDist(t._dist)}｜${t.disaster}`, size: 22, color: "#41505b" },
      ...wrap(t.evacuation_message, 26).slice(0, 2)
        .map((x) => ({ text: x, size: 21, color: "#5d3200" })),
      { text: "※伝承は補助情報。避難判断は公式情報で。", size: 19, color: "#8a6d3b" },
    ], { accent: CATEGORY_COLORS.tradition, width: 520 });
    placeAt(board, p.lat, p.lng, 1.4 + (i % 2) * 0.8);
    scene.add(board);
    traditionObjs.push(board);

    if (t.recorded_height_m != null) {
      const gaugeDist = Math.min(t._dist, 26);
      const gp = destPoint(curPos.lat, curPos.lng, brg, gaugeDist);
      const gauge = buildHeightGauge(
        t.recorded_height_m,
        `${t.disaster.includes("安政") ? "安政の津波" : "記録津波"} 記録高 約${t.recorded_height_m}m（史料による）`);
      placeAt(gauge, gp.lat, gp.lng, 0);
      scene.add(gauge);
      traditionObjs.push(gauge);
    }
  });
}

export function setTarget(facility) {
  target = facility;
  if (started) refreshTarget();
}

async function startWebcam(holder) {
  video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.setAttribute("playsinline", "true");
  video.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0";
  holder.appendChild(video);
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }, audio: false,
    });
    video.srcObject = videoStream;
    await video.play().catch(() => {});
    return true;
  } catch (e) {
    status("カメラを開始できませんでした（権限/HTTPSを確認）。背景なしで矢印を表示します。", "warn");
    return false;
  }
}

// mode: "sim"=現地目線ビュー（歩いて見回す合成3D・既定）/ "live"=ARカメラ（実機・上級）
// routeGeometry: OSRMのGeoJSON LineString（あればsimの道筋を道なりに描く）
export async function startAR(holder,
  { fakePos = null, facility = null, mode: m = "sim", routeGeometry = null } = {}) {
  if (started) return;
  target = facility ?? target;
  mode = m;
  routeGeom = routeGeometry;

  if (mode === "live") {
    await startWebcam(holder);
  }

  // 全画面表示直後はレイアウト未確定で clientWidth=0 になりうるため、ビューポートにフォールバック
  const sizeW = () => holder.clientWidth || window.innerWidth;
  const sizeH = () => holder.clientHeight || window.innerHeight;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: mode === "live" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(sizeW(), sizeH());
  renderer.domElement.style.cssText = "position:absolute;inset:0;z-index:1;touch-action:none";
  holder.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(BASE_FOV, sizeW() / sizeH(), 0.01, 5000);
  camera.position.set(0, EYE_Y, 0);
  zoom = 1; applyZoom();

  // ホイール（PC）とピンチ（スマホ）で望遠ズーム。遠くのものを拡大して確認できる。
  const dom = renderer.domElement;
  const onWheel = (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); };
  dom.addEventListener("wheel", onWheel, { passive: false });
  let pinchBase = 0;
  const onTouchStart = (e) => {
    if (e.touches.length === 2) pinchBase = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY) / zoom;
  };
  const onTouchMove = (e) => {
    if (e.touches.length === 2 && pinchBase) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      setZoom(d / pinchBase);
      e.preventDefault();
    }
  };
  dom.addEventListener("touchstart", onTouchStart, { passive: false });
  dom.addEventListener("touchmove", onTouchMove, { passive: false });
  renderer._zoomCleanup = () => {
    dom.removeEventListener("wheel", onWheel);
    dom.removeEventListener("touchstart", onTouchStart);
    dom.removeEventListener("touchmove", onTouchMove);
  };

  locar = new LocAR.LocationBased(scene, camera);

  if (mode === "sim") {
    // 現地目線ビュー: 歩ける3D空間＋ドラッグ見回し。カメラ・方位センサーは使わない。
    lookControls = new LookControls(camera, renderer.domElement, { groundY: GROUND_Y });
    lookControls.onMove = onSimMove;
    simBuilt = false;
    status("現地目線ビュー: ドラッグで見回し（離すと余韻）、行きたい場所をタップ/クリックで進めます。矢印キー/WASD（画面の◀▶▲▼）でも歩けます。", "info");
  } else {
    // 現地モード: iOS Safari の DeviceOrientation 許可はユーザータップ内でのみ取得可能。
    // startAR は必ず「ARを開始」ボタンの click ハンドラから呼ぶこと。
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") status("方位センサーが許可されていません。検証モード（ドラッグで見回し）に切り替えます。", "warn");
      } catch { /* 拒否時は下の error ハンドラで sim へフォールバック */ }
    }
    controls = new LocAR.DeviceOrientationControls(camera, { enablePermissionDialog: false });
    controls.on("deviceorientationgranted", () => controls.connect());
    controls.on("deviceorientationerror", () => {
      // 方位センサーが無い/拒否 → マウス見回しにフォールバック
      if (!lookControls) {
        lookControls = new LookControls(camera, renderer.domElement, { groundY: GROUND_Y });
        faceTarget();
        status("方位センサーが使えないため、ドラッグで見回す検証モードに切り替えました。", "info");
      }
    });
    controls.init();
  }

  // LocAR 0.1.x の gpsupdate ペイロードは { position: GeolocationPosition, distMoved }
  locar.on("gpsupdate", (data) => {
    const c = data?.position?.coords ?? data?.coords;
    if (!c) return;
    curPos = { lat: c.latitude, lng: c.longitude };
    if (mode === "sim") {
      // 検証モード: 初回に歩ける3D世界を構築（GPS原点＝ENU基準）
      if (!simBuilt) {
        simOrigin = { ...curPos };
        camera.position.set(0, EYE_Y, 0);
        buildSimWorld();
        faceTarget(); // 初期は避難先を正面に
      }
    } else {
      refreshTarget();
      refreshTraditions();
    }
  });

  started = true;
  if (fakePos) {
    locar.fakeGps(fakePos.lng, fakePos.lat); // デモ/検証: 擬似GPS
  } else {
    locar.startGps();
  }

  const onResize = () => {
    renderer.setSize(sizeW(), sizeH());
    camera.aspect = sizeW() / sizeH();
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);
  renderer._onResize = onResize;
  // レイアウト確定後（次フレーム）にサイズを補正
  requestAnimationFrame(onResize);
  setTimeout(onResize, 120);

  renderer.setAnimationLoop(() => {
    if (controls) controls.update();
    if (lookControls) lookControls.update();
    if (mode === "sim" && guideArrow) updateGuideArrow(); // 見回しでも矢印を追従
    renderer.render(scene, camera);
  });

  // 開発時のみ: シーン内容の検証用フック（合成シーン・矢印・伝承ボード・記録高ゲージの確認）
  if (import.meta.env?.DEV) {
    window.__arScene = scene;
    window.__arCamera = camera;
    window.__arLook = lookControls;
  }
}

export function stopAR() {
  if (!started) return;
  started = false;
  try { locar.stopGps?.(); } catch { /* fakeGps時など */ }
  try { controls?.disconnect?.(); } catch { /* 未接続時 */ }
  try { lookControls?.dispose?.(); } catch { /* noop */ }
  if (videoStream) { videoStream.getTracks().forEach((t) => t.stop()); videoStream = null; }
  if (video) { video.remove(); video = null; }
  if (scene) scene.background = null;
  if (renderer) {
    renderer.setAnimationLoop(null);
    window.removeEventListener("resize", renderer._onResize);
    renderer._zoomCleanup?.();
    renderer.domElement.remove();
    renderer.dispose();
  }
  zoom = 1;
  controls = null; lookControls = null; envGroup = null;
  arrowGroup = null; targetBoard = null;
  traditionObjs = []; traditionsBuiltAt = null; curPos = null;
  simWorld = null; guideArrow = null; simOrigin = null; simBuilt = false;
  routeGeom = null;
}

// 検証モードの移動操作API（画面ボタン用）
export function setMoveInput(forward, strafe) {
  if (lookControls) lookControls.setMoveInput(forward, strafe);
}
export function resetWalk() {
  if (lookControls) { lookControls.resetPosition(); faceTarget(); }
}
