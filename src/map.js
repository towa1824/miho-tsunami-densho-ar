// メイン地図のファサード（バックエンド選択）。
//  - VITE_GOOGLE_MAPS_API_KEY あり → Google Maps（map-google.js）。利用者の明示指示でメイン地図も Google 化。
//  - キー無し / Google 読込失敗 → 従来の Leaflet + OSM（map-leaflet.js）へフォールバック（アプリは壊れない）。
// main.js は従来どおり `import * as MapView from "./map.js"` で同じインターフェイスを使う。
// 経路取得(fetchRoute)・経路色(ROUTE_COLOR)は地図バックエンドに依存しないので route.js から re-export する。
import * as Leaflet from "./map-leaflet.js";
import * as GMap from "./map-google.js";
import { hasApiKey } from "./streetview.js";
import { fetchRoute, ROUTE_COLOR } from "./route.js";

export { fetchRoute, ROUTE_COLOR };

let backend = null;                 // 確定したバックエンド（Leaflet or GMap）
const pending = [];                 // バックエンド確定前に来た void 呼び出しを貯めて後で再生
let readyResolve;
const readyPromise = new Promise((r) => { readyResolve = r; });

function activate(mod) {
  backend = mod;
  for (const [m, a] of pending) { try { backend[m]?.(...a); } catch { /* 再生失敗は無視 */ } }
  pending.length = 0;
  readyResolve(backend);
}

// void を返す状態系API: バックエンド未確定なら貯めて、確定後に同じ順序で再生する。
function fwd(method, args) {
  if (backend) return backend[method]?.(...args);
  pending.push([method, args]);
}

export function initMap(el) {
  if (!hasApiKey()) { Leaflet.initMap(el); activate(Leaflet); return; }
  // キーあり → Google を試み、失敗（読込エラー等）したら Leaflet+OSM へフォールバック。
  GMap.initMap(el)
    .then(() => activate(GMap))
    .catch(() => { Leaflet.initMap(el); activate(Leaflet); });
}

export const setOnMapClick = (...a) => fwd("setOnMapClick", a);
export const setOnFacilityView = (...a) => fwd("setOnFacilityView", a);
export const setCurrentPos = (...a) => fwd("setCurrentPos", a);
export const setNumberedMarkers = (...a) => fwd("setNumberedMarkers", a);
export const clearNumbers = (...a) => fwd("clearNumbers", a);
export const clearRoute = (...a) => fwd("clearRoute", a);
export const focusFacility = (...a) => fwd("focusFacility", a);
export const focusLatLng = (...a) => fwd("focusLatLng", a);
export const invalidate = (...a) => fwd("invalidate", a);

// 経路表示は戻り値（{mode,geometry,…}）を呼び出し側が await するので、バックエンド確定を待ってから委譲。
// 実際にはユーザー操作（カードの「地図で経路」等）で呼ばれるため、その時点では既に確定済み。
export async function showRoute(...a) {
  const b = await readyPromise;
  return b.showRoute(...a);
}
