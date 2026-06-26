// 経路取得（地図バックエンドに依存しない純粋なロジック）。
// Leaflet 版・Google Maps 版どちらの地図(map-*.js)からも、また main.js / streetview.js からも使う。
// 元は map.js 内にあった fetchRoute/Google Routes/OSRM/polyline デコードをここへ集約した（重複実装を避ける）。
import { hasPos } from "./data.js";

// 徒歩=青/車=赤（Leaflet/Google 地図・ストリートビュー2D地図で共通の経路色）。
export const ROUTE_COLOR = { foot: "#0d47a1", car: "#c62828" };

// OSRM デモサーバのプロファイル: 徒歩=歩行者ネットワーク / 車=車道（いずれも参考経路）。
const OSRM_PROFILE = {
  foot: "routed-foot/route/v1/foot",
  car: "routed-car/route/v1/driving",
};

// 経路プロバイダ: VITE_GOOGLE_MAPS_API_KEY があれば Google Routes API（道路距離・所要時間が高品質）、
// 無ければ OSRM デモサーバ。Google を使うのは allowGoogle=true（実表示する1本）だけ。
const GOOGLE_API_KEY = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY;
const GOOGLE_TRAVEL_MODE = { foot: "WALK", car: "DRIVE" };

// 道路経路を取得するだけの純関数（地図には描かない）。{ mode, geometry(GeoJSON), distM, durS } を返す。
// allowGoogle かつキーがあれば Google を先に試し、失敗時は OSRM→直線へフォールバック
// （キー無し・HTTPローカルの sim でも従来どおり動く）。
export async function fetchRoute(pos, facility, travelMode = "foot", { allowGoogle = false } = {}) {
  if (!pos || !hasPos(facility)) return { mode: "none" };
  if (allowGoogle && GOOGLE_API_KEY) {
    const g = await fetchGoogleRoute(pos, facility, travelMode);
    if (g) return g; // 失敗(null)時は下の OSRM→直線フォールバックに落とす
  }
  const profile = OSRM_PROFILE[travelMode] ?? OSRM_PROFILE.foot;
  const url =
    `https://routing.openstreetmap.de/${profile}/` +
    `${pos.lng},${pos.lat};${facility.lng},${facility.lat}` +
    `?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    const route = json.routes?.[0];
    if (route?.geometry) {
      return { mode: "osrm", geometry: route.geometry, distM: route.distance, durS: route.duration };
    }
  } catch { /* OSRM不達 → 直線フォールバック */ }
  return { mode: "straight" };
}

// Google Routes API (Compute Routes Basic) で道路経路を1本取得し、OSRM と同じ形に整える。
// encoded polyline を GeoJSON LineString([[lng,lat],...]) へデコードする。失敗時は null。
async function fetchGoogleRoute(pos, facility, travelMode) {
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_API_KEY,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: pos.lat, longitude: pos.lng } } },
        destination: { location: { latLng: { latitude: facility.lat, longitude: facility.lng } } },
        travelMode: GOOGLE_TRAVEL_MODE[travelMode] ?? "WALK",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const route = (await res.json()).routes?.[0];
    const encoded = route?.polyline?.encodedPolyline;
    if (!encoded) return null;
    return {
      mode: "google",
      geometry: { type: "LineString", coordinates: decodePolyline(encoded) },
      distM: route.distanceMeters ?? null,
      durS: parseDurationS(route.duration),
    };
  } catch { return null; } // ネットワーク不達・タイムアウト → OSRM フォールバックへ
}

// Google Routes の duration は "123s" 形式の文字列。秒(number)へ変換する（不正時は null）。
function parseDurationS(d) {
  const m = typeof d === "string" && /^(\d+(?:\.\d+)?)s$/.exec(d.trim());
  return m ? Math.round(parseFloat(m[1])) : null;
}

// Encoded Polyline Algorithm Format（精度1e5）をデコード。GeoJSON に合わせ [lng,lat] 順で返す。
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}
