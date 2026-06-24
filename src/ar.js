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
import { bearingDeg, distanceM, destPoint, formatDist, compassLabel, toEastNorth, fromEastNorth } from "./geo.js";
import {
  traditionsWithin, categoryOf, CATEGORY_COLORS,
  nearestTsunamiFacilities, facilities, intensityLabel,
} from "./data.js";

let renderer, scene, camera, locar, controls, lookControls, video, videoStream;
let started = false;
let mode = "live";          // "live"=カメラ / "sim"=避難の現地目線 / "learn"=伝承学習
let envGroup = null;         // 検証モードの合成シーン（空・地面・東西南北）
let curPos = null;          // {lat,lng}
let target = null;          // 選択中の避難施設
let focusTradition = null;  // 学習モードで深掘り中の伝承
let arrowGroup = null;
let targetBoard = null;
let targetObjs = [];        // 避難先の付随オブジェクト（地面マーカー・垂直ライン・方向ガイド）
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
let guideArrow = null;      // カメラに追従して「次に進む方向」を指す浮遊矢印
let simBuilt = false;
let routeGeom = null;       // OSRM経路形状(GeoJSON LineString)。あれば道筋をこれに沿わせる
let routeGroup = null;      // 経路の3Dオブジェクト（青ルート or 灰破線）をまとめるGroup
let routeENU = [];          // 経路点のENU列 [{x,z}]（道路経路がある時はその形状、無ければ[原点,目的地]）
let routeHasRoad = false;   // 道路経路あり(true) / 直線参考のみ(false)
let routeTotalM = 0;        // 経路全長(m)

// ENU(東/北 メートル)でオブジェクトを配置（北=-Z, 東=+X）
function placeENU(obj, lat, lng, y = 0) {
  const { east, north } = toEastNorth(lat, lng, simOrigin.lat, simOrigin.lng);
  obj.position.set(east, y, -north);
}
// カメラの現在位置(ENU) → 実効緯度経度
function effectiveLatLng() {
  if ((mode === "sim" || mode === "learn") && simOrigin && camera) {
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
  const obj = mode === "learn" ? focusTradition : target;
  if (lookControls && obj && obj.lat != null) {
    const eff = effectiveLatLng();
    if (eff) lookControls.faceBearing(bearingDeg(eff.lat, eff.lng, obj.lat, obj.lng));
  }
}
export function faceNorth() {
  if (lookControls) lookControls.reset();
}
// 経路の「次に進む方向」を正面に向ける（道路経路があれば最初の進行方向、無ければ目的地方向）
export function faceRoute() {
  if (!lookControls) return;
  if (mode === "sim" && routeHasRoad && routeENU.length >= 2) {
    const ns = nextStep();
    const eff = effectiveLatLng();
    if (ns && eff) { lookControls.faceBearing(ns.brg); return; }
  }
  faceTarget();
}
// 「正面に」ボタン用: モードに応じて経路方向 or 主役（伝承）を向く
export function faceGuide() {
  if (mode === "learn") return faceTarget();
  return faceRoute();
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

// canvasの実描画幅で折り返す（measureText基準）。日本語・全角・絵文字を grapheme 単位で扱う。
function wrapByWidth(ctx, text, font, maxW) {
  ctx.font = font;
  const out = [];
  let cur = "";
  for (const ch of Array.from(String(text ?? ""))) {
    if (ch === "\n") { out.push(cur); cur = ""; continue; }
    if (cur !== "" && ctx.measureText(cur + ch).width > maxW) { out.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur !== "" || out.length === 0) out.push(cur);
  return out;
}

// 白背景＋左アクセントバーの文字スプライト。各入力行を実描画幅で折り返し、
// 行数に応じて canvas 高さ・Sprite スケールが自然に伸びる（長い日本語がクリップされない）。
// ワールド寸法は userData.worldW / worldH に持たせ、配置計算（重なり回避）に使える。
function makeTextSprite(lines, { accent = "#0d2b45", width = 460 } = {}) {
  const pad = 18, lineH = 34, fontPx = 26;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const textX = pad + 6;                 // 左アクセントバー(10px)＋余白
  const maxTextW = width - textX - pad;  // 文字に使える実幅
  // 各行をピクセル幅で折り返して描画行(rows)に展開
  const rows = [];
  for (const ln of lines) {
    const size = ln.size ?? fontPx;
    const font = `${ln.bold ? "700 " : ""}${size}px sans-serif`;
    for (const piece of wrapByWidth(ctx, ln.text, font, maxTextW)) {
      rows.push({ text: piece, bold: ln.bold, size, color: ln.color });
    }
  }
  const w = width, h = rows.length * lineH + pad * 2 + 8;
  canvas.width = w * 2;
  canvas.height = h * 2;
  ctx.scale(2, 2);
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 14);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 10, h);
  rows.forEach((r, i) => {
    ctx.font = `${r.bold ? "700 " : ""}${r.size ?? fontPx}px sans-serif`;
    ctx.fillStyle = r.color ?? "#1d2429";
    ctx.fillText(r.text, textX, pad + 4 + lineH * i + fontPx * 0.8);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  const scale = 0.013; // 1px ≒ 1.3cm → 12m先で読める大きさ
  sp.scale.set(w * scale, h * scale, 1);
  sp.userData.worldW = w * scale;
  sp.userData.worldH = h * scale;
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
  // ボードはピクセル幅で自動折り返し（タイトル・災害名・避難メッセージ・注意文を省略せず全文表示）
  const board = makeTextSprite([
    { text: `📜 ${t.title}`, bold: true, size: 26, color: "#7a3b00" },
    { text: t.disaster, size: 21, color: "#41505b" },
    { text: t.evacuation_message, size: 20, color: "#5d3200" },
    { text: "※伝承は補助情報。避難判断は公式情報で。", size: 18, color: "#8a6d3b" },
  ], { accent: CATEGORY_COLORS.tradition, width: 560 });
  const bw = board.userData.worldW || 7.3;
  const bh = board.userData.worldH || 5;
  // 柱はボード下端（GROUND_Y+4付近）まで伸ばす
  const postTop = 4;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, postTop, 8),
    new THREE.MeshBasicMaterial({ color: 0x8d6e63 }));
  post.position.y = GROUND_Y + postTop / 2; grp.add(post);
  // ボードの下端を柱の上端付近にそろえて配置（中心 = 下端 + 高さ/2）
  board.position.y = GROUND_Y + postTop - 0.3 + bh / 2; grp.add(board);
  if (t.recorded_height_m != null) {
    const gauge = buildHeightGauge(t.recorded_height_m,
      `${t.disaster.includes("安政") ? "安政の津波" : "記録津波"} 記録高 約${t.recorded_height_m}m（史料）`);
    // 橙の説明ボードの右端の外側にゲージを置き、青い柱・記録高ラベルと重ならないようにする
    gauge.position.x = bw / 2 + 4; grp.add(gauge);
  }
  return grp;
}

// 経路の3D表現を（再）構築する。routeGeom(OSRM道路経路)があれば青ルート、
// 無ければ「目的地方向（直線参考）」を灰色破線で描く（青い道路風ルートは出さない）。
function buildRoute() {
  if (!routeGroup || !simOrigin) return;
  while (routeGroup.children.length) {
    const c = routeGroup.children.pop();
    c.geometry?.dispose?.();
  }
  routeENU = []; routeHasRoad = false; routeTotalM = 0;
  if (!target || target.lat == null) return;

  const coords = routeGeom?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    routeENU = coords.map(([lng, lat]) => {
      const { east, north } = toEastNorth(lat, lng, simOrigin.lat, simOrigin.lng);
      return { x: east, z: -north };
    });
    routeHasRoad = true;
  } else {
    const { east, north } = toEastNorth(target.lat, target.lng, simOrigin.lat, simOrigin.lng);
    routeENU = [{ x: 0, z: 0 }, { x: east, z: -north }];
    routeHasRoad = false;
  }
  routeTotalM = pathLength(routeENU);
  if (import.meta.env?.DEV) window.__arRouteMode = routeHasRoad ? "geometry" : "straight";

  if (routeHasRoad) drawRoadRoute(routeGroup);
  else drawStraightRef(routeGroup);
}

// 道路経路（青）: 太い帯ではなく細い半透明ライン＋明るい中心線＋小さな白シェブロン。
// 経路始点が原点から離れている場合は、原点→経路始点を灰破線でつなぐ（道路への取り付き）。
function drawRoadRoute(g) {
  const pts = routeENU;
  const W = 0.7;                 // 帯の半幅（全幅1.4m）
  const y = GROUND_Y + 0.04;
  const fillMat = new THREE.MeshBasicMaterial({
    color: 0x1a73e8, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  const pos = [], core = [];
  let acc = 0, nextChev = 14;
  const total = routeTotalM;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z, seg = Math.hypot(dx, dz);
    if (seg < 0.2) continue;
    const ux = dx / seg, uz = dz / seg, px = -uz, pz = ux;
    pos.push(
      a.x + px * W, y, a.z + pz * W, a.x - px * W, y, a.z - pz * W, b.x + px * W, y, b.z + pz * W,
      a.x - px * W, y, a.z - pz * W, b.x - px * W, y, b.z - pz * W, b.x + px * W, y, b.z + pz * W);
    core.push(new THREE.Vector3(a.x, y + 0.01, a.z), new THREE.Vector3(b.x, y + 0.01, b.z));
    const rotY = Math.atan2(ux, uz);
    while (nextChev <= acc + seg && nextChev < total - 3) {
      const t = (nextChev - acc) / seg;
      const chev = makeChevron(0xffffff); chev.scale.setScalar(0.66);
      chev.position.set(a.x + dx * t, y + 0.03, a.z + dz * t); chev.rotation.y = rotY;
      g.add(chev); nextChev += 24;
    }
    acc += seg;
  }
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    const mesh = new THREE.Mesh(geo, fillMat); mesh.renderOrder = 1; g.add(mesh);
  }
  if (core.length) {
    const cgeo = new THREE.BufferGeometry().setFromPoints(core);
    const line = new THREE.LineSegments(cgeo,
      new THREE.LineBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.9 }));
    line.renderOrder = 2; g.add(line);
  }
  // 原点が経路始点から離れている（公園内など）場合の取り付き線
  const start = pts[0];
  if (Math.hypot(start.x, start.z) > 8) g.add(dashedLine({ x: 0, z: 0 }, start, y, 0x9e9e9e, 0.8));
}

// 直線参考（道路経路が取れない時）: 灰色の破線で「目的地方向」だけを控えめに示す。
function drawStraightRef(g) {
  const a = routeENU[0], b = routeENU[routeENU.length - 1];
  const y = GROUND_Y + 0.04;
  g.add(dashedLine(a, b, y, 0x9e9e9e, 0.85));
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const lab = makeTextSprite(
    [{ text: "目的地方向（直線参考・道路経路なし）", bold: true, size: 22, color: "#5f6368" }],
    { accent: "#9e9e9e", width: 460 });
  lab.position.set(mid.x, GROUND_Y + 1.6, mid.z);
  g.add(lab);
}

function dashedLine(a, b, y, color, opacity) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, b.z)]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
    color, dashSize: 2.5, gapSize: 2, transparent: true, opacity }));
  line.computeLineDistances();
  line.renderOrder = 1;
  return line;
}

// 現在のカメラ位置から経路上の最近点・前方の目標点・残距離を求める（経路追従）
function routeProgress() {
  if (!routeENU || routeENU.length < 2 || !camera) return null;
  const p = camera.position;
  let bestD = Infinity, bestI = 1, bestT = 0;
  for (let i = 1; i < routeENU.length; i++) {
    const a = routeENU[i - 1], b = routeENU[i];
    const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1e-9;
    let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t, cz = a.z + dz * t, d = (p.x - cx) ** 2 + (p.z - cz) ** 2;
    if (d < bestD) { bestD = d; bestI = i; bestT = t; }
  }
  const a0 = routeENU[bestI - 1], b0 = routeENU[bestI];
  const projx = a0.x + (b0.x - a0.x) * bestT, projz = a0.z + (b0.z - a0.z) * bestT;
  let remaining = Math.hypot(b0.x - projx, b0.z - projz);
  for (let i = bestI + 1; i < routeENU.length; i++) {
    remaining += Math.hypot(routeENU[i].x - routeENU[i - 1].x, routeENU[i].z - routeENU[i - 1].z);
  }
  return { target: lookAheadPoint(bestI, projx, projz, 12), remaining };
}

// 経路上の (px,pz)（セグメントsegI上）から道なりに dist[m] 進んだ点
function lookAheadPoint(segI, px, pz, dist) {
  let remain = dist, curx = px, curz = pz, i = segI;
  while (i < routeENU.length) {
    const b = routeENU[i];
    const dx = b.x - curx, dz = b.z - curz, seg = Math.hypot(dx, dz);
    if (seg >= remain) { const t = remain / seg; return { x: curx + dx * t, z: curz + dz * t }; }
    remain -= seg; curx = b.x; curz = b.z; i++;
  }
  return { x: curx, z: curz };
}

// HUD/オーバーレイ用: 次に進む方位(地理)・そこまでの距離・経路の残距離
export function nextStep() {
  if (mode !== "sim") return null;
  const eff = effectiveLatLng();
  if (!target || target.lat == null || !eff) return null;
  if (!routeHasRoad || routeENU.length < 2) {
    const dist = distanceM(eff.lat, eff.lng, target.lat, target.lng);
    return { hasRoute: false, brg: bearingDeg(eff.lat, eff.lng, target.lat, target.lng), dist, remaining: dist };
  }
  const pr = routeProgress();
  if (!pr) return null;
  const tll = fromEastNorth(pr.target.x, -pr.target.z, simOrigin.lat, simOrigin.lng);
  const nextDist = Math.hypot(pr.target.x - camera.position.x, pr.target.z - camera.position.z);
  return { hasRoute: true, brg: bearingDeg(eff.lat, eff.lng, tll.lat, tll.lng), dist: nextDist, remaining: pr.remaining };
}
export function hasRoadRoute() { return routeHasRoad; }

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

  // 目的地への道筋（道路経路=青ルート / 取得不可=灰破線の直線参考）
  routeGroup = new THREE.Group();
  g.add(routeGroup);
  buildRoute();

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

// 伝承学習の3D世界（選んだ伝承を主役に・避難先や経路・ガイド矢印は出さない）
function buildLearnWorld() {
  setSky();
  const g = new THREE.Group();
  buildGround(g);
  // 中心の伝承を強調表示（目印の柱＋大ラベル＋記録高ゲージ＋震度）
  if (focusTradition && focusTradition.lat != null) {
    const c = learnSignboard(focusTradition);
    placeENU(c, focusTradition.lat, focusTradition.lng, 0);
    g.add(c);
  }
  // 周辺の他の伝承も柱で見せる（この一帯にどんな記録があるかを一望）
  for (const t of traditionsWithin(simOrigin, 900).slice(0, 8)) {
    if (focusTradition && t.id === focusTradition.id) continue;
    const s = signboard(t);
    placeENU(s, t.lat, t.lng, 0);
    g.add(s);
  }
  scene.add(g);
  simWorld = g;
  simBuilt = true;
  addTownAsync(g); // 実際の町並み（OSM）も重ねる
}

// 学習で深掘りする伝承の強調表示（橙の柱＋大ラベル＋「ここまで水が来た」ゲージ＋震度）
function learnSignboard(t) {
  const grp = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6, 12),
    new THREE.MeshBasicMaterial({ color: 0xef6c00 }));
  post.position.y = GROUND_Y + 3; grp.add(post);
  const lines = [
    { text: `📜 ${t.title}`, bold: true, size: 30, color: "#7a3b00" },
    { text: t.disaster, size: 22, color: "#41505b" },
  ];
  if (t.intensity != null) {
    lines.push({ text: `推定震度 ${intensityLabel(t)}（寺院被害記録）`, size: 21, color: "#b71c1c" });
  }
  wrap(t.evacuation_message, 30).slice(0, 1).forEach((x) =>
    lines.push({ text: x, size: 20, color: "#5d3200" }));
  const panel = makeTextSprite(lines, { accent: CATEGORY_COLORS.tradition, width: 620 });
  panel.position.y = GROUND_Y + 6.8; panel.scale.multiplyScalar(1.3); grp.add(panel);
  if (t.recorded_height_m != null) {
    const gauge = buildHeightGauge(t.recorded_height_m, `ここまで水が来た記録 約${t.recorded_height_m}m（史料）`);
    gauge.position.set(3.5, 0, 0); grp.add(gauge);
  }
  return grp;
}

// OpenStreetMapの町並み3Dを読み込んでsimWorldへ追加。失敗してもビュー自体は続行する。
async function addTownAsync(world) {
  status("町並みデータ（OpenStreetMap）を読み込み中…", "info");
  try {
    const town = await loadTown(simOrigin);
    // 読み込み中に終了・再起動していたら古いシーンには足さない
    if (!started || (mode !== "sim" && mode !== "learn") || simWorld !== world) return;
    world.add(buildTownGroup(town, simOrigin, GROUND_Y));
    status("実際の町並みを立体表示中（建物の形と高さはOpenStreetMapによる概形）" +
      "© OpenStreetMap contributors", "info");
  } catch {
    if (!started || simWorld !== world) return;
    status("町並みデータを取得できませんでした（オフライン？）。施設・伝承のみ表示します。", "warn");
  }
}

// ガイド矢印をカメラ前方の足元寄りに置き、「次に進む方向」（経路の前方点）へ向ける。
// 道路経路がある時は次の経路点、無ければ目的地（直線）を指す。
function updateGuideArrow() {
  if (!guideArrow || !target || target.lat == null) return;
  guideArrow.visible = zoom <= 1.5; // 望遠中は視界を塞ぐだけなので隠す
  if (!guideArrow.visible) return;
  const cam = camera.position;
  const yaw = lookControls ? lookControls.yaw : 0;
  // カメラ前方7m・目線より下に配置（町並みの視界を塞がない）
  guideArrow.position.set(cam.x - Math.sin(yaw) * 7, GUIDE_Y, cam.z - Math.cos(yaw) * 7);
  let tx, tz;
  if (routeHasRoad && routeENU.length >= 2) {
    const pr = routeProgress();
    if (pr) { tx = pr.target.x; tz = pr.target.z; }
  }
  if (tx === undefined) {
    const { east, north } = toEastNorth(target.lat, target.lng, simOrigin.lat, simOrigin.lng);
    tx = east; tz = -north;
  }
  guideArrow.lookAt(tx, GUIDE_Y, tz);
}

// 歩いて移動した時: ガイド矢印を向け直し、HUD/オーバーレイを更新させる
function onSimMove() {
  updateGuideArrow();
  if (onUpdateCb) onUpdateCb({});
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

// --- 現地ARモードの「遠近・範囲・方向」表現ヘルパー -------------------------
// 遠方地点をAR内で手前にクランプ表示しても、実距離・実方位・範囲が誤認されないための共通部品。
// sim/learn にも流用しやすいよう、依存は GROUND_Y / locar / zoom と three だけに限定する。

// 実距離を帯に分類し、ラベル拡大率と「遠方扱い」フラグを返す。
// 遠いほど大きく見せる（ただし上限を設けて画面を占有しすぎない）。
function distanceBand(dist) {
  if (dist <= 80) return { key: "near", scale: 1.0, far: false };
  if (dist <= 300) return { key: "mid", scale: 1.15, far: false };
  if (dist <= 800) return { key: "far", scale: 1.3, far: true };
  return { key: "veryfar", scale: 1.4, far: true };
}

// AR内の表示距離。近距離(≲45m)はほぼ実距離のまま、遠距離は手前に縮約しつつ
// 「近い順に少しずつ手前→奥」へ並べ、実際の遠近の前後関係を保つ。
function displayDistanceForAR(dist, index = 0) {
  if (dist <= 45) return dist;
  return 42 + index * 8;
}

// スプライトのワールドスケールに mult を掛けて基準値として固定し、ズーム時に
// 見かけが極端に大きくならないよう毎フレーム補正する（zoom が上がるほどワールド
// スケールを縮め、見かけ倍率の増加を zoom^0.2 程度に抑える）。距離帯の拡大は zoom=1 で活きる。
function lockLabelScale(sp, mult = 1) {
  const bx = sp.scale.x * mult, by = sp.scale.y * mult;
  sp.scale.set(bx, by, 1);
  sp.onBeforeRender = () => {
    const k = 1 / Math.pow(Math.max(1, zoom), 0.8);
    sp.scale.set(bx * k, by * k, 1);
  };
}

// 地面に置く範囲マーカー（リング＋半透明ディスク）。「この看板はこの地面位置・
// この範囲の地点を指す」ことを示す。色で種別（避難先=赤/伝承=橙/記録高=青）を区別。
function makeGroundMarker(colorHex, radius = 5, { opacity = 0.16 } = {}) {
  const g = new THREE.Group();
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  disk.rotation.x = -Math.PI / 2; disk.renderOrder = 0; g.add(disk);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.1, radius - 0.4), radius + 0.4, 48),
    new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.renderOrder = 1; g.add(ring);
  return g;
}

// 看板と地面の対応位置を結ぶ細い垂直ライン（どの地面位置の看板かを示す）。
function makeAnchorLine(x, z, y0, y1, colorHex, opacity = 0.75) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y1, z)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: colorHex, transparent: true, opacity }));
  line.renderOrder = 1;
  return line;
}

// 現在地から地点の「実際の方位」へ伸ばす地面ガイド（破線＋矢羽根）。AR表示位置を
// 手前に縮約していても、この線と矢羽根で本当の方向が分かる。fromLL→toLL は同じ実方位上。
function makeDirectionGuide(fromLL, toLL, colorHex) {
  const g = new THREE.Group();
  const a = locar.lonLatToWorldCoords(fromLL.lng, fromLL.lat);
  const b = locar.lonLatToWorldCoords(toLL.lng, toLL.lat);
  const y = GROUND_Y + 0.05;
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(a[0], y, a[1]), new THREE.Vector3(b[0], y, b[1])]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
    color: colorHex, dashSize: 2.4, gapSize: 1.8, transparent: true, opacity: 0.9 }));
  line.computeLineDistances(); line.renderOrder = 1; g.add(line);
  const chev = makeChevron(colorHex); chev.scale.setScalar(0.8);
  chev.position.set(b[0], y + 0.02, b[1]);
  chev.rotation.y = Math.atan2(b[0] - a[0], b[1] - a[1]); // 現在地→地点の向きへ
  g.add(chev);
  return g;
}

// 方位が近い看板を高さ方向へ段組みして重なりを抑える簡易デコンフリクト。
// 重なり判定は各看板の角度半幅 halfAng（= worldW と表示距離から算出）の和で行うため、
// 看板の幅・距離に応じて適応的に効く。entries: [{ y, h, brg, halfAng }] の y を破壊的に
// 持ち上げる（n が小さい前提の O(n^2)・処理は軽量）。
function layoutARLabels(entries) {
  const GAP = 0.8, MARGIN = 1.5; // 段間の余白[m] / 角度の安全余白[deg]
  const order = entries.map((_, i) => i).sort((a, b) => entries[a].brg - entries[b].brg);
  const placed = [];
  for (const idx of order) {
    const e = entries[idx];
    for (const p of placed) {
      let d = Math.abs(p.brg - e.brg); if (d > 180) d = 360 - d;
      if (d < p.halfAng + e.halfAng + MARGIN) { // 横方向に重なる＝高さ方向へ段組み
        const top = p.y + p.h / 2 + GAP + e.h / 2;
        if (top > e.y) e.y = top;
      }
    }
    placed.push(e);
  }
}

// 避難先矢印と説明ボードを現在地に合わせて再配置（現地モード=LocAR投影用）。
// 避難先は最重要: 赤・大きめ・地面リング・垂直ライン・方向ガイドで最優先に見せ、
// 実距離/方位を明示する（AR内の表示位置は手前にクランプしても誤認させない）。
function refreshTarget() {
  if (mode === "sim" || mode === "learn") return; // 歩けるモードは build*World で配置
  if (!curPos || !target || !started || target.lat == null) return;
  const TARGET_C = 0xc62828; // 避難先は赤で最優先に見せる
  const dist = distanceM(curPos.lat, curPos.lng, target.lat, target.lng);
  const brg = bearingDeg(curPos.lat, curPos.lng, target.lat, target.lng);
  const showDist = Math.min(dist, 16);
  const clamped = showDist < dist - 5;
  const anchor = destPoint(curPos.lat, curPos.lng, brg, showDist);

  if (!arrowGroup) {
    arrowGroup = buildArrow();
    scene.add(arrowGroup);
  }
  placeAt(arrowGroup, anchor.lat, anchor.lng, -0.3);
  // 矢印を目標方向へ向ける（lookAtで施設の実位置を向く）
  const [tx, tz] = locar.lonLatToWorldCoords(target.lng, target.lat);
  arrowGroup.lookAt(tx, -0.3, tz);

  // 避難先の付随表示（地面マーカー・垂直ライン・方向ガイド・説明ボード）を作り直す
  targetObjs.forEach(clearObj);
  targetObjs = [];
  const [ax, az] = locar.lonLatToWorldCoords(anchor.lng, anchor.lat);

  // 地面の範囲マーカー（赤・大きめ＝最優先）。どの地面位置が避難先かを示す。
  const gm = makeGroundMarker(TARGET_C, 7, { opacity: 0.2 });
  placeAt(gm, anchor.lat, anchor.lng, GROUND_Y + 0.03);
  scene.add(gm); targetObjs.push(gm);
  // 遠い時は現在地→実方位の地面ガイド（赤い破線＋矢羽根）で本当の向きを示す
  if (clamped) {
    const guide = makeDirectionGuide(curPos, anchor, TARGET_C);
    scene.add(guide); targetObjs.push(guide);
  }

  const heightLine = target.evacuation_height_m != null
    ? `避難可能高さ ${target.evacuation_height_m}m / ${target.evacuation_place}`
    : `避難可能場所: ${target.evacuation_place}`;
  const whyLines = wrap(target.why, 26);
  const lines = [
    { text: `🎯 避難先 ${target.name}`, bold: true, size: 31, color: "#b71c1c" },
    { text: `🧭 ${compassLabel(brg)} ・ 実距離 約${formatDist(dist)}`, bold: true, size: 25, color: "#b71c1c" },
  ];
  if (clamped) lines.push(
    { text: `AR内は手前(約${Math.round(showDist)}m先)に表示。赤い線の向きが実際の方向です。`, size: 18, color: "#8a6d3b" });
  lines.push(
    { text: `種別: ${target.type}（${target.subtype}）`, size: 23, color: "#41505b" },
    { text: heightLine, size: 23, color: "#41505b" },
    { text: `理由: ${whyLines[0] ?? ""}`, size: 22, color: "#0d47a1" },
    ...whyLines.slice(1, 3).map((t) => ({ text: `　${t}`, size: 22, color: "#0d47a1" })));
  targetBoard = makeTextSprite(lines, { accent: TARGET_C, width: 540 });
  const bh = (targetBoard.userData.worldH || 5) * 1.5;
  placeAt(targetBoard, anchor.lat, anchor.lng, 1.9 + bh / 2);
  targetBoard.renderOrder = 10;       // 伝承ボード(5)より前面＝最優先
  lockLabelScale(targetBoard, 1.5);   // 伝承より大きく・ズーム時も破綻しない
  scene.add(targetBoard); targetObjs.push(targetBoard);

  // 看板と地面を結ぶ垂直ライン（赤）
  const line = makeAnchorLine(ax, az, GROUND_Y + 0.03, 1.9, TARGET_C);
  scene.add(line); targetObjs.push(line);

  if (onUpdateCb) onUpdateCb({ dist, brg });
}

// 周辺の伝承ポイント（実方位に、遠いものは見える距離にクランプして表示・現地モード用）
function refreshTraditions() {
  if (mode === "sim" || mode === "learn") return; // 歩けるモードは build*World で配置
  if (!curPos || !started) return;
  if (traditionsBuiltAt &&
      distanceM(traditionsBuiltAt.lat, traditionsBuiltAt.lng, curPos.lat, curPos.lng) < 50) {
    return;
  }
  traditionsBuiltAt = { ...curPos };
  traditionObjs.forEach(clearObj);
  traditionObjs = [];

  const TRAD = 0xef6c00, GAUGE = 0x1565c0; // 伝承=橙 / 記録高ゲージ=青
  const list = traditionsWithin(curPos, 1500).slice(0, 5);

  // 1) 各地点の方位・表示距離・看板を準備（高さは後段のデコンフリクトで確定）
  const items = list.map((t, i) => {
    const brg = bearingDeg(curPos.lat, curPos.lng, t.lat, t.lng);
    const showDist = displayDistanceForAR(t._dist, i); // 遠い地点は手前に縮約
    const clamped = showDist < t._dist - 5;
    const band = distanceBand(t._dist);
    const anchor = destPoint(curPos.lat, curPos.lng, brg, showDist);
    const lines = [
      { text: `${band.far ? "🔭 遠方 " : "📜 "}${t.title}`, bold: true, size: 26, color: "#7a3b00" },
      { text: `🧭 ${compassLabel(brg)} ・ 実距離 約${formatDist(t._dist)}`, bold: true, size: 22, color: "#b5460b" },
    ];
    if (clamped) lines.push(
      { text: `AR内は手前(約${Math.round(showDist)}m先)に縮約表示`, size: 18, color: "#8a6d3b" });
    lines.push(
      { text: t.disaster, size: 21, color: "#41505b" },
      { text: t.evacuation_message, size: 20, color: "#5d3200" },
      { text: "※伝承は補助情報。避難判断は公式情報で。", size: 18, color: "#8a6d3b" });
    const board = makeTextSprite(lines, { accent: CATEGORY_COLORS.tradition, width: 520 });
    board.renderOrder = 5; // 避難先ボード(10)より背面
    const bh = (board.userData.worldH || 5) * band.scale;
    const bw = (board.userData.worldW || 7) * band.scale;
    // 表示距離における看板の角度半幅[deg]（worldW を活用した重なり判定用）
    const halfAng = (Math.atan2(bw / 2, showDist) * 180) / Math.PI;
    return { t, brg, showDist, clamped, band, anchor, board, bh, halfAng, y: 2.0 + bh / 2 };
  });

  // 2) 方位が近い看板は高さ方向に段組みして重なりを抑える（worldW から角度半幅を算出）
  const lay = items.map((it) => ({ y: it.y, h: it.bh, brg: it.brg, halfAng: it.halfAng }));
  layoutARLabels(lay);
  items.forEach((it, k) => { it.y = lay[k].y; });

  // 3) 配置: 地面マーカー → 看板 → 垂直ライン →（遠方は）方向ガイド → 記録高ゲージ
  for (const it of items) {
    const [ax, az] = locar.lonLatToWorldCoords(it.anchor.lng, it.anchor.lat);

    const gm = makeGroundMarker(TRAD, 4.5);
    placeAt(gm, it.anchor.lat, it.anchor.lng, GROUND_Y + 0.03);
    scene.add(gm); traditionObjs.push(gm);

    placeAt(it.board, it.anchor.lat, it.anchor.lng, it.y);
    lockLabelScale(it.board, it.band.scale); // 距離帯で拡大＋ズーム時も破綻しない
    scene.add(it.board); traditionObjs.push(it.board);

    const line = makeAnchorLine(ax, az, GROUND_Y + 0.03, it.y - it.bh / 2, TRAD);
    scene.add(line); traditionObjs.push(line);

    if (it.clamped) { // 遠方は現在地→実方位の地面ガイドで本当の向きを示す
      const guide = makeDirectionGuide(curPos, it.anchor, TRAD);
      scene.add(guide); traditionObjs.push(guide);
    }

    if (it.t.recorded_height_m != null) {
      // 記録高ゲージは看板と同じ地点へ寄せ、横に少しずらして垂直ライン・柱と干渉させない
      const gauge = buildHeightGauge(it.t.recorded_height_m,
        `${it.t.disaster.includes("安政") ? "安政の津波" : "記録津波"} 記録高 約${it.t.recorded_height_m}m（史料による）`);
      placeAt(gauge, it.anchor.lat, it.anchor.lng, 0);
      gauge.position.x += 3.2;
      scene.add(gauge); traditionObjs.push(gauge);
      const gring = makeGroundMarker(GAUGE, 1.6, { opacity: 0.22 }); // ゲージ脚元の青い範囲
      gring.position.set(ax + 3.2, GROUND_Y + 0.04, az);
      scene.add(gring); traditionObjs.push(gring);
    }
  }
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
  { fakePos = null, facility = null, mode: m = "sim", routeGeometry = null, tradition = null } = {}) {
  if (started) return;
  target = facility ?? target;
  focusTradition = tradition;
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

  if (mode === "sim" || mode === "learn") {
    // 歩ける3D空間＋ストリートビュー風操作。カメラ・方位センサーは使わない。
    lookControls = new LookControls(camera, renderer.domElement, { groundY: GROUND_Y });
    lookControls.onMove = onSimMove;
    simBuilt = false;
    status(mode === "learn"
      ? "伝承学習ビュー: ドラッグで見回し、行きたい場所をタップで移動。橙の柱が伝承スポット、青いゲージが「ここまで水が来た」記録です。下の解説をスクロールで読めます。"
      : "現地目線ビュー: ドラッグで見回し（離すと余韻）、行きたい場所をタップ/クリックで進めます。矢印キー/WASD（画面の◀▶▲▼）でも歩けます。", "info");
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
    if (mode === "sim" || mode === "learn") {
      // 歩ける3D世界を初回構築（GPS原点＝ENU基準）
      if (!simBuilt) {
        simOrigin = { ...curPos };
        camera.position.set(0, EYE_Y, 0);
        if (mode === "learn") { buildLearnWorld(); faceTarget(); }
        else { buildSimWorld(); faceRoute(); } // 初期は経路の最初の進行方向を正面に
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
    if (guideArrow) updateGuideArrow(); // simの見回しで矢印を追従（learnはguideArrow無し）
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
  arrowGroup = null; targetBoard = null; targetObjs = [];
  traditionObjs = []; traditionsBuiltAt = null; curPos = null;
  simWorld = null; guideArrow = null; simOrigin = null; simBuilt = false;
  routeGeom = null; focusTradition = null;
  routeGroup = null; routeENU = []; routeHasRoad = false; routeTotalM = 0;
}

// 検証モードの移動操作API（画面ボタン用）
export function setMoveInput(forward, strafe) {
  if (lookControls) lookControls.setMoveInput(forward, strafe);
}
export function resetWalk() {
  if (lookControls) { lookControls.resetPosition(); faceGuide(); }
}
