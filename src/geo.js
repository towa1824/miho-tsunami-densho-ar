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
