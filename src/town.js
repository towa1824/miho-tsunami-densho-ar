// 町並み3D（OpenStreetMap / Overpass API・無料/APIキー不要）
// 現地目線ビューに実際の町並み（建物・道路・水域・緑地・砂浜・海岸線）を立体で重ねる。
// - 建物・道路・公園の名前に加え、店舗・施設などの名前付きPOI(OSMノード)もラベル表示する（addLabels）
// - 表示中は「© OpenStreetMap contributors」を明示する（ODbL。#arAttrib / 注意事項タブ）
// - 建物高さは height → building:levels×3m → 種別既定値 の順で推定（=概形。実物と異なりうる）
// - 取得結果は localStorage に7日キャッシュし、同一地点での再リクエストを避ける
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { toEastNorth } from "./geo.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", // 本家が混雑時のミラー
];
// v5: 取得半径拡大・キャッシュキー細分化(toFixed4)・進行に応じたチャンク追加ロード対応。
// prefix更新で旧キャッシュは自然に無効化され、再取得される。
const CACHE_PREFIX = "town.v5:";
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

// 取得半径[m]。目線の見通し＋目的地周辺をカバーしつつデータ量を抑える。
// R_BUILDING はチャンク1セル（ar.js 側 ~700m四方）の対角を確実に覆える大きさにする。
const R_BUILDING = 750, R_ROAD = 800, R_AREA = 900, R_COAST = 1600, R_POI = 900;

const FOOT = new Set(["footway", "path", "pedestrian", "cycleway", "steps", "track"]);
const ROAD_W = {
  motorway: 9, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
  residential: 4.5, unclassified: 4.5, living_street: 4, service: 3,
  footway: 1.8, path: 1.6, pedestrian: 2.5, cycleway: 1.8, steps: 1.6, track: 2.2,
};

function buildQuery({ lat, lng }) {
  const at = (r) => `(around:${r},${lat.toFixed(6)},${lng.toFixed(6)})`;
  return `[out:json][timeout:25];(
way["building"]${at(R_BUILDING)};
way["highway"]${at(R_ROAD)};
node["name"]["amenity"]${at(R_POI)};
node["name"]["shop"]${at(R_POI)};
node["name"]["office"]${at(R_POI)};
node["name"]["tourism"]${at(R_POI)};
node["name"]["leisure"]${at(R_POI)};
node["name"]["healthcare"]${at(R_POI)};
node["name"]["craft"]${at(R_POI)};
node["name"]["historic"]${at(R_POI)};
node["name"]["man_made"]${at(R_POI)};
node["name"]["railway"]${at(R_POI)};
node["name"]["public_transport"]${at(R_POI)};
way["natural"="water"]${at(R_AREA)};
way["natural"~"^(wood|beach|sand)$"]${at(R_AREA)};
way["landuse"~"^(forest|grass|meadow|recreation_ground|village_green)$"]${at(R_AREA)};
way["leisure"~"^(park|garden|pitch|playground)$"]${at(R_AREA)};
way["natural"="coastline"]${at(R_COAST)};
);out geom;`;
}

// 建物高さの推定。タグが無い建物は種別ごとの既定値（概形表示であることはUI側に明記）
function estHeight(tags) {
  const h = parseFloat(tags.height ?? tags["building:height"]);
  if (Number.isFinite(h) && h > 0) return Math.min(h, 60);
  const lv = parseFloat(tags["building:levels"]);
  if (Number.isFinite(lv) && lv > 0) return Math.min(lv * 3, 60);
  const t = tags.building;
  if (["house", "detached", "residential", "hut", "shed", "garage"].includes(t)) return 5;
  if (["apartments", "school", "hospital", "hotel", "public", "civic"].includes(t)) return 11;
  if (["industrial", "warehouse", "retail", "commercial"].includes(t)) return 8;
  return 7; // 高さ不明の一般建物。少し高めにして地面に埋もれず見えるように（=概形）
}

// 建物の色分け 0=住宅系 1=大型(集合住宅・公共) 2=産業/商業 3=その他
function colorClass(tags) {
  const t = tags.building;
  if (["house", "detached", "residential", "hut", "shed", "garage"].includes(t)) return 0;
  if (["apartments", "school", "hospital", "hotel", "public", "civic"].includes(t)) return 1;
  if (["industrial", "warehouse", "retail", "commercial"].includes(t)) return 2;
  return 3;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

// 名前付きPOIノードのアイコン（種別ごと。店舗・施設名を見分けやすくする）
function poiIcon(tags) {
  const a = tags.amenity;
  if (tags.healthcare || ["hospital", "clinic", "pharmacy", "dentist", "doctors"].includes(a)) return "🏥";
  if (["school", "kindergarten", "university", "college"].includes(a)) return "🏫";
  if (["restaurant", "cafe", "fast_food", "food_court", "bar", "pub"].includes(a)) return "🍴";
  if (a === "post_office") return "📮";
  if (["bank", "atm"].includes(a)) return "🏦";
  if (a === "fuel") return "⛽";
  if (a === "place_of_worship") return "⛩️";
  if (tags.railway || tags.public_transport) return "🚉";
  if (tags.historic) return "🏛️";
  if (tags.man_made) return "🗼";
  if (tags.tourism) return "📸";
  if (tags.shop) return "🏪";
  if (tags.office) return "🏢";
  if (tags.leisure) return "🏞️";
  return "📍";
}

// Overpass応答 → 描画に必要な最小構造（キャッシュもこの形）
function parseOsm(json) {
  const town = { buildings: [], roads: [], water: [], green: [], sand: [], coast: [], pois: [] };
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    // 名前付きPOI（店舗・施設などのOSMノード）。建物polygonにnameが無い店も名前を拾える。
    if (el.type === "node") {
      const nm = tags["name:ja"] || tags.name;
      if (nm && el.lat != null) town.pois.push({ name: nm, lat: r6(el.lat), lng: r6(el.lon), icon: poiIcon(tags) });
      continue;
    }
    if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const pts = el.geometry.map((p) => [r6(p.lat), r6(p.lon)]);
    const name = tags["name:ja"] || tags.name || null; // 地物名（日本語名を優先）
    if (tags.building) {
      town.buildings.push({ h: Math.round(estHeight(tags) * 10) / 10, c: colorClass(tags), pts, name });
    } else if (tags.highway) {
      town.roads.push({ w: ROAD_W[tags.highway] ?? 4, f: FOOT.has(tags.highway) ? 1 : 0, pts, name });
    } else if (tags.natural === "coastline") town.coast.push(pts);
    else if (tags.natural === "water") town.water.push(pts);
    else if (tags.natural === "beach" || tags.natural === "sand") town.sand.push(pts);
    else town.green.push({ pts, name });
  }
  return town;
}

// 町並みデータ取得（localStorageキャッシュ → Overpass本家 → ミラー）
export async function loadTown(origin) {
  // キャッシュキーは toFixed(4)（≒11m）まで細かくし、チャンク中心ごとに別キャッシュとして扱う。
  const key = `${CACHE_PREFIX}${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}`;
  if (import.meta.env?.DEV) window.__arTownCacheKey = key;
  try {
    const hit = JSON.parse(localStorage.getItem(key) ?? "null");
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.town;
  } catch { /* 壊れたキャッシュは無視して再取得 */ }
  let lastErr;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(buildQuery(origin)),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const town = parseOsm(await res.json());
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), town })); }
      catch { /* 容量超過時はキャッシュ無しで続行 */ }
      return town;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---------------- 3D化 ----------------

// 建物色（住宅/大型/産業/他）。明るい地面（淡緑）と区別しやすいよう、やや濃いめにする。
// ただし避難先(青/緑/紫)・経路(青)・ガイド矢印より目立たない無彩色寄りに留める。
const B_BASE = [0xc2b6a4, 0xadb6c4, 0x9fadb4, 0xb7afa3]; // 住宅/大型/産業/他
// 地面レイヤーの重なり順。renderOrderを負にして既存の道筋ストリップ等を常に上に保つ
const FLAT = {
  coast: { color: 0x6fa8cc, opacity: 0.80, lift: 0.004, order: -9 },
  water: { color: 0x7fb3d8, opacity: 0.78, lift: 0.005, order: -8 },
  sand:  { color: 0xe3d7b0, opacity: 0.85, lift: 0.006, order: -7 },
  green: { color: 0x9cc296, opacity: 0.70, lift: 0.008, order: -6 },
  road:  { color: 0x8d949c, opacity: 0.92, lift: 0.012, order: -5 },
  foot:  { color: 0xb8b0a2, opacity: 0.85, lift: 0.014, order: -4 },
};

// 町並みのGroupを構築（origin=ENU原点、groundY=地面の高さ）。
// opts.cellHalf を指定すると建物・道路を中心 origin の ±cellHalf[m] セル内にクリップする
// （チャンクをタイル状に並べ、隣接チャンクとの重複描画＝z-fighting/二重塗りを防ぐ）。
// opts.areas=false で水域・緑地・砂浜・海岸線を描かない（広域の地形は最初の1チャンクが担当）。
// opts.addLights=false でライトを足さない（ライトはシーン全体に効くので最初の1チャンクのみ）。
export function buildTownGroup(town, origin, groundY, { addLights = true, cellHalf = Infinity, areas = true } = {}) {
  const g = new THREE.Group();
  g.name = "osmTown";
  const enu = (lat, lng) => {
    const { east, north } = toEastNorth(lat, lng, origin.lat, origin.lng);
    return [east, -north]; // 世界座標は 北=-Z / 東=+X（CLAUDE.md）
  };
  const inCell = (x, z) => Math.abs(x) <= cellHalf && Math.abs(z) <= cellHalf;

  // 建物: footprint押し出しを1メッシュに結合（頂点色＋Lambertの陰影で立体感）。
  // 重心がセル内の建物だけを対象にし（タイル化）、中心に近い順で MAX_BUILDINGS まで（フリーズ防止）。
  // ※距離判定は footprint先頭点ではなく重心。大きな/複雑な建物が誤って落ちるのを防ぐ。
  const MAX_BUILDINGS = 1400;
  const cand = [];
  for (const b of town.buildings) {
    const [cx, cz] = centroidEnu(b.pts, enu);
    if (!inCell(cx, cz)) continue;
    cand.push({ b, d: cx * cx + cz * cz });
  }
  cand.sort((p, q) => p.d - q.d);
  const blds = (cand.length > MAX_BUILDINGS ? cand.slice(0, MAX_BUILDINGS) : cand).map((x) => x.b);
  const geos = [];
  for (const b of blds) {
    const geo = footprintGeo(b.pts, b.h, enu);
    if (geo) { paint(geo, b.c); geos.push(geo); }
  }
  if (geos.length) {
    const merged = mergeGeometries(geos, false);
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.position.y = groundY;
    g.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28 }));
    edges.position.y = groundY;
    g.add(edges);
    if (addLights) {
      // Lambert用ライト（MeshBasicの既存表示には影響しない）。シーン全体に効くので最初の1回だけ。
      g.add(new THREE.HemisphereLight(0xe9f3ff, 0x9a9183, 1.35));
      const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
      sun.position.set(180, 420, 240); // 南東の上空から（北=-Z）
      g.add(sun);
      g.userData.hasLights = true;
    }
  }

  // 道路: 中点がセル内のものだけ（建物と同じくタイル化）
  const midIn = (r) => {
    const m = r.pts[Math.floor(r.pts.length / 2)];
    const [x, z] = enu(m[0], m[1]);
    return inCell(x, z);
  };
  const roadsC = town.roads.filter(midIn);
  addFlat(g, FLAT.road, roadsGeo(roadsC.filter((r) => !r.f), enu), groundY);
  addFlat(g, FLAT.foot, roadsGeo(roadsC.filter((r) => r.f), enu), groundY);

  // 水域・緑地・砂浜・海岸線（広域の地形）は重複描画を避けるため最初の1チャンクのみ描く。
  if (areas) {
    addFlat(g, FLAT.water, polysGeo(town.water, enu), groundY);
    addFlat(g, FLAT.green, polysGeo(town.green.map((x) => x.pts), enu), groundY);
    addFlat(g, FLAT.sand, polysGeo(town.sand, enu), groundY);
    // 海岸線: OSMの規約で「進行方向の右側が水域」→ 右側へ帯を張り海の手がかりに
    addFlat(g, FLAT.coast, coastGeo(town.coast, enu), groundY);
  }

  // 名前ラベル（建物・道路・公園 ＋ 店舗・施設POI。OSM name。© OpenStreetMap contributors）
  // 近傍(MAXD=150m)だけ＝チャンク中心が離れていれば実質重複しない。
  addLabels(g, town, origin, groundY);
  return g;
}

function addFlat(g, spec, geo, groundY) {
  if (!geo) return;
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: spec.color, transparent: true, opacity: spec.opacity,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  mesh.position.y = groundY + spec.lift;
  mesh.renderOrder = spec.order;
  g.add(mesh);
}

const dropClose = (pts) =>
  pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
    ? pts.slice(0, -1) : pts;

// Shape平面は x=東, y=北。rotateX(-90°)で y=高さ, z=-北 の接地姿勢に倒して使う
function shapeOf(pts, enu) {
  const ring = dropClose(pts);
  if (ring.length < 3) return null;
  return new THREE.Shape(ring.map(([lat, lng]) => {
    const [x, z] = enu(lat, lng);
    return new THREE.Vector2(x, -z);
  }));
}

function footprintGeo(pts, h, enu) {
  const shape = shapeOf(pts, enu);
  if (!shape) return null;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// 一棟ごとに種別色＋わずかな明度差をつけ、結合後ものっぺりしないようにする
function paint(geo, cls) {
  const base = new THREE.Color(B_BASE[cls] ?? B_BASE[3]);
  base.multiplyScalar(0.93 + Math.random() * 0.12);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = base.r; arr[i * 3 + 1] = base.g; arr[i * 3 + 2] = base.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
}

// 閉じたwayだけを面にする（開いたwayは形が定義できないので捨てる）
function polysGeo(list, enu) {
  const geos = [];
  for (const pts of list) {
    if (pts.length < 4) continue;
    if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) continue;
    const shape = shapeOf(pts, enu);
    if (!shape) continue;
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geos.push(geo);
  }
  return geos.length ? mergeGeometries(geos, false) : null;
}

// 道路の中心線に沿って幅wの帯（区間ごとの三角形2枚）を張る
function roadsGeo(roads, enu) {
  const pos = [];
  for (const r of roads) {
    const pts = r.pts.map(([lat, lng]) => enu(lat, lng));
    const hw = (r.w ?? 4) / 2;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.2) continue;
      const px = (-dz / len) * hw, pz = (dx / len) * hw; // 幅方向
      pos.push(
        ax + px, 0, az + pz, ax - px, 0, az - pz, bx + px, 0, bz + pz,
        ax - px, 0, az - pz, bx - px, 0, bz - pz, bx + px, 0, bz + pz,
      );
    }
  }
  return pos.length ? bufferGeo(pos) : null;
}

// 海岸線の右側（=水域側）へ幅Wの帯を張る。
// 目線の高さでは海は水平線際の細い帯にしかならないため、Wを大きく取り
// 「海岸線から先はずっと海」に見えるようにする（地面円900mの先まで覆う）。
function coastGeo(ways, enu) {
  const W = 1200;
  const pos = [];
  for (const raw of ways) {
    const pts = raw.map(([lat, lng]) => enu(lat, lng));
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const rx = (-dz / len) * W, rz = (dx / len) * W; // 進行方向の右
      pos.push(
        ax, 0, az, ax + rx, 0, az + rz, bx, 0, bz,
        ax + rx, 0, az + rz, bx + rx, 0, bz + rz, bx, 0, bz,
      );
    }
  }
  return pos.length ? bufferGeo(pos) : null;
}

function bufferGeo(pos) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  return geo;
}

// ---------------- 名前ラベル ----------------

// onBeforeRenderでのラベル拡縮に使う作業用ベクトル（毎フレーム再利用）
const _wp = new THREE.Vector3();

// 常にカメラを向く文字ラベル（地物名表示用）。避難施設ラベルとは別スタイルで控えめに。
function makeLabel(text, { color = "#fff", bg = "rgba(40,50,60,.82)", fontPx = 30 } = {}) {
  const pad = 10;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `700 ${fontPx}px sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  canvas.width = w * 2; canvas.height = h * 2;
  ctx.scale(2, 2);
  ctx.font = `700 ${fontPx}px sans-serif`;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, 8); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = "middle";
  ctx.fillText(text, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.renderOrder = 3;
  sp.scale.set(w * 0.022, h * 0.022, 1); // 近距離の基準サイズ（1px ≒ 2.2cm）
  // 遠くの文字が小さく読めない対策：遠いラベルほど、カメラ距離に応じて拡大し画面上ほぼ一定の
  // 高さに見せる（近距離は基準サイズのまま＝下限クランプ。歩行・ズームに毎フレーム追従）。
  const aspect = w / h, baseH = h * 0.022;
  const TARGET = 0.05, MAXH = 6;   // 目安(約5%) / 遠景サイズ上限[m]＝小さいほど遠くは小さくなり重なりにくい
  sp.onBeforeRender = (renderer, scene, camera) => {
    _wp.setFromMatrixPosition(sp.matrixWorld);
    const D = camera.position.distanceTo(_wp);
    const tan = Math.tan(THREE.MathUtils.degToRad((camera.fov ?? 60) / 2));
    const hW = Math.min(MAXH, Math.max(baseH, TARGET * 2 * D * tan));
    sp.scale.set(aspect * hW, hW, 1);
  };
  return sp;
}

function centroidEnu(pts, enu) {
  let sx = 0, sz = 0;
  for (const [lat, lng] of pts) { const [x, z] = enu(lat, lng); sx += x; sz += z; }
  return [sx / pts.length, sz / pts.length];
}

function dedupeByName(arr) {
  const seen = new Set(), out = [];
  for (const it of arr) { if (seen.has(it.name)) continue; seen.add(it.name); out.push(it); }
  return out;
}

// 名前ラベルを3D空間に配置（建物名・店舗/施設POI・道路名・公園名）。
// 「出せるだけ」近い順に出す＝各カテゴリの個別上限は撤廃し、総数だけ LABEL_MAX で安全に頭打ちする。
function addLabels(g, town, origin, groundY) {
  const enu = (lat, lng) => {
    const { east, north } = toEastNorth(lat, lng, origin.lat, origin.lng);
    return [east, -north];
  };
  const MAXD = 150;                       // この距離(m)より遠い名前は出さない（近くだけ＝遠景の混乱を避ける）
  const LABEL_MAX = 40;                   // 出すラベル総数の上限（近い順＝近くの名前だけに絞る）
  const dist = (x, z) => Math.hypot(x, z);
  const items = [];                       // { d, x, z, y, mk } mkは実際に描く分だけ遅延生成しテクスチャを節約

  // 公園・緑地名
  const parks = [];
  for (const gr of town.green) {
    if (!gr.name) continue;
    const [x, z] = centroidEnu(gr.pts, enu);
    if (dist(x, z) > MAXD) continue;
    parks.push({ name: gr.name, x, z, d: dist(x, z) });
  }
  for (const p of dedupeByName(parks.sort((a, b) => a.d - b.d)))
    items.push({ d: p.d, x: p.x, z: p.z, y: groundY + 2.2,
      mk: () => makeLabel("🌳 " + p.name, { bg: "rgba(34,90,40,.82)" }) });

  // 建物名（名前付きのみ・屋根の上）
  const blds = [];
  for (const b of town.buildings) {
    if (!b.name) continue;
    const [x, z] = centroidEnu(b.pts, enu);
    if (dist(x, z) > MAXD) continue;
    blds.push({ name: b.name, x, z, y: groundY + b.h + 1.4, d: dist(x, z) });
  }
  for (const b of dedupeByName(blds.sort((a, b) => a.d - b.d)))
    items.push({ d: b.d, x: b.x, z: b.z, y: b.y,
      mk: () => makeLabel(b.name, { bg: "rgba(20,40,70,.82)" }) });

  // 店舗・施設などの名前付きPOI（OSMノード）。建物名だけでは出ない店名・施設名＝主な増分。
  const pois = [];
  for (const p of town.pois ?? []) {
    const [x, z] = enu(p.lat, p.lng);
    if (dist(x, z) > MAXD) continue;
    pois.push({ name: `${p.icon} ${p.name}`, x, z, d: dist(x, z) });
  }
  for (const p of dedupeByName(pois.sort((a, b) => a.d - b.d)))
    items.push({ d: p.d, x: p.x, z: p.z, y: groundY + 3,
      mk: () => makeLabel(p.name, { bg: "rgba(45,55,70,.82)", fontPx: 26 }) });

  // 道路名（同名は原点に最も近い中点1つに集約・低い位置に）
  const byRoad = new Map();
  for (const r of town.roads) {
    if (!r.name) continue;
    const mid = r.pts[Math.floor(r.pts.length / 2)];
    const [x, z] = enu(mid[0], mid[1]);
    if (dist(x, z) > MAXD) continue;
    const cur = byRoad.get(r.name), d = dist(x, z);
    if (!cur || d < cur.d) byRoad.set(r.name, { name: r.name, x, z, d });
  }
  for (const r of byRoad.values())
    items.push({ d: r.d, x: r.x, z: r.z, y: groundY + 0.8,
      mk: () => makeLabel(r.name, { bg: "rgba(60,60,68,.78)", fontPx: 25 }) });

  // 近い順に総数 LABEL_MAX まで描画（描く分だけテクスチャを生成）
  items.sort((a, b) => a.d - b.d);
  for (const it of items.slice(0, LABEL_MAX)) {
    const sp = it.mk();
    sp.position.set(it.x, it.y, it.z);
    g.add(sp);
  }
}
