// 距離・方位のユーティリティ（WGS84近似の球面計算）

const R = 6371000;

export function distanceM(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 真北基準・時計回りの方位角(0-360)
export function bearingDeg(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const DIRS = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
  "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];

export function compassLabel(deg) {
  return DIRS[Math.round(deg / 22.5) % 16];
}

export function formatDist(m) {
  if (m == null || Number.isNaN(m)) return "-";
  if (m < 950) return `${Math.round(m / 10) * 10}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// 移動手段ごとの所要時間（分）。徒歩は80m/分（F-19）、車は市街地約24km/h(=400m/分)で概算
const SPEED_M_PER_MIN = { foot: 80, car: 400 };

export function travelTimeMin(distM, mode = "foot") {
  if (distM == null || Number.isNaN(distM)) return null;
  return Math.max(1, Math.round(distM / (SPEED_M_PER_MIN[mode] ?? 80)));
}

// 分 → 「約N分」/「約N時間M分」
export function formatDuration(min) {
  if (min == null) return "-";
  if (min < 60) return `約${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `約${h}時間` : `約${h}時間${m}分`;
}

export const TRAVEL_LABEL = { foot: "徒歩", car: "車" };

// 局所ENU座標（1単位=1実メートル）。検証モードの3D空間で正確な距離・移動を扱うため。
// 原点(lat0,lng0)を基準に、east(東+)/north(北+)メートルを返す。
const M_PER_DEG_LAT = 110540;
export function toEastNorth(lat, lng, lat0, lng0) {
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    east: (lng - lng0) * mPerDegLng,
    north: (lat - lat0) * M_PER_DEG_LAT,
  };
}
// ENUのeast/north(メートル) → 緯度経度（原点からの逆変換）
export function fromEastNorth(east, north, lat0, lng0) {
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    lat: lat0 + north / M_PER_DEG_LAT,
    lng: lng0 + east / mPerDegLng,
  };
}

// 道路経路(GeoJSON LineStringの coords: [[lng,lat],…])上で、現在地posに最も近い点から
// 道なりに aheadM[m] 先の点を求め、その点への方位(真北基準)・距離、経路の残距離を返す。
// Street View の「次にどっちへ歩くか」算出に使う（AR の routeProgress を lat/lng でやり直す版）。
// pos を原点とする局所ENU(メートル)へ投影してから計算するので、ARと同じ投影・最近点の考え方になる。
export function routeGuidance(coords, pos, aheadM = 25) {
  if (!Array.isArray(coords) || coords.length < 2 || !pos) return null;
  const pts = coords.map(([lng, lat]) => toEastNorth(lat, lng, pos.lat, pos.lng)); // {east,north}
  // pos(=原点)に最も近い経路上の点（線分への射影）を探す
  let bestD = Infinity, bestI = 1, bestT = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.east - a.east, dy = b.north - a.north, len2 = dx * dx + dy * dy || 1e-9;
    let t = ((0 - a.east) * dx + (0 - a.north) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.east + dx * t, cy = a.north + dy * t;
    const d = cx * cx + cy * cy;
    if (d < bestD) { bestD = d; bestI = i; bestT = t; }
  }
  const a0 = pts[bestI - 1], b0 = pts[bestI];
  const nx = a0.east + (b0.east - a0.east) * bestT;
  const ny = a0.north + (b0.north - a0.north) * bestT;
  // 最近点から道なりに aheadM 先の look-ahead 点
  let remain = aheadM, cx = nx, cy = ny, i = bestI, tx = nx, ty = ny;
  while (i < pts.length) {
    const b = pts[i];
    const dx = b.east - cx, dy = b.north - cy, seg = Math.hypot(dx, dy);
    if (seg >= remain) { const t = remain / seg; tx = cx + dx * t; ty = cy + dy * t; break; }
    remain -= seg; cx = b.east; cy = b.north; i++; tx = cx; ty = cy;
  }
  // 残距離（最近点→経路終点）
  let remainingM = Math.hypot(b0.east - nx, b0.north - ny);
  for (let j = bestI + 1; j < pts.length; j++) {
    remainingM += Math.hypot(pts[j].east - pts[j - 1].east, pts[j].north - pts[j - 1].north);
  }
  // 原点(pos)から look-ahead 点への方位(真北0・時計回り・東+)と距離
  const brg = (Math.atan2(tx, ty) * 180 / Math.PI + 360) % 360;
  return { brg, distAhead: Math.hypot(tx, ty), remainingM };
}

// 起点(lat,lng)から方位bearing(度)・距離d(m)だけ進んだ地点
export function destPoint(lat, lng, brgDeg, d) {
  const br = (brgDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lng * Math.PI) / 180;
  const dr = d / R;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(br)
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(p1),
      Math.cos(dr) - Math.sin(p1) * Math.sin(p2)
    );
  return { lat: (p2 * 180) / Math.PI, lng: (l2 * 180) / Math.PI };
}
