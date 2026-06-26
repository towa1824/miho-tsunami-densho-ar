// Google Maps（Maps JavaScript API の google.maps.Map）バックエンド。
// APIキー設定時のメイン地図（キー未設定時は map-leaflet.js の OSM 地図＝map.js が選択）。
// CLAUDE.md の「メイン地図は Leaflet+OSM 固定」は利用者の明示指示により本機能で上書き（キーがある時のみ Google）。
//
// 設計方針:
//  - Google Maps JS は streetview.js の loadGoogleMaps() のロード結果を再利用し、loader を増やさない。
//  - APIキーは直書きしない（loadGoogleMaps が import.meta.env.VITE_GOOGLE_MAPS_API_KEY を参照）。
//  - Google のロゴ・著作権・標準UIは隠さない。マーカー/ポリラインはクリア時に解放する。
//  - インターフェイスは map-leaflet.js と同一（initMap/setCurrentPos/showRoute…）。initMap だけ Promise を返す。
import {
  facilities, traditions, hasPos, categoryOf,
  CATEGORY_COLORS, CATEGORY_LABELS, intensityLabel, coordCaveat,
} from "./data.js";
import { fetchRoute, ROUTE_COLOR } from "./route.js";
import { loadGoogleMaps } from "./streetview.js";

let maps = null;   // window.google.maps
let gmap = null;   // google.maps.Map
let infoWindow = null;
let currentMarker = null;
let routeLine = null;    // 参考経路ポリライン（進行方向の矢印は icons で同梱／直線参考は破線 icons）
let onMapClickCb = null;
let onFacilityViewCb = null;
const facilityMarkers = new Map();  // id -> { marker, cat, rec }
const traditionMarkers = new Map(); // id -> { marker, cat, rec }

export function setOnMapClick(cb) { onMapClickCb = cb; }
export function setOnFacilityView(cb) { onFacilityViewCb = cb; }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function srcLink(r) {
  return `<div class="src">出典: <a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.source_title)}</a></div>`;
}
function facilityPopup(f) {
  const cat = categoryOf(f);
  const h = f.evacuation_height_m != null ? `避難可能高さ ${esc(f.evacuation_height_m)}m / ` : "";
  const shelterNote = cat === "shelter"
    ? `<div class="src">※指定避難所は被災後の生活の場。津波警報中の一時避難はタワー・命山・津波避難ビルへ。</div>` : "";
  const cv = coordCaveat(f);
  const cvNote = cv ? `<div class="src">📍 ${esc(cv)}</div>` : "";
  return `<b>${esc(f.name)}</b><br>
    <span style="color:${CATEGORY_COLORS[cat]};font-weight:700">${esc(CATEGORY_LABELS[cat])}</span>
    （${esc(f.type)}）<br>${h}${esc(f.evacuation_place ?? "")}<br>
    <div class="pvDesc" style="margin-top:4px">${esc(f.why ?? "")}</div>${cvNote}${shelterNote}${srcLink(f)}
    <button type="button" class="pvGo" data-fid="${esc(f.id)}"
      style="margin-top:6px;width:100%;padding:6px;border-radius:7px;border:none;
             background:#0d2b45;color:#fff;font-size:12px;font-weight:700">
      🧭 現地目線で見る</button>`;
}
function traditionPopup(t) {
  const ht = t.recorded_height_m != null
    ? `<br><b>記録上の津波高: 約${esc(t.recorded_height_m)}m</b>（${esc(t.recorded_height_note ?? "")}）` : "";
  const intenStr = intensityLabel(t);
  const inten = intenStr ? `<br>推定震度: ${esc(intenStr)}（寺院被害記録による）` : "";
  return `<b>${esc(t.title)}</b><br>
    <span style="color:${CATEGORY_COLORS.tradition};font-weight:700">災害伝承・史料</span>
    ｜関連災害: ${esc(t.disaster)}${ht}${inten}
    <div class="pvDesc" style="margin-top:4px">${esc(t.summary)}</div>
    <div style="margin-top:4px;background:#fff3e0;padding:3px 5px;border-radius:3px">
      避難への意味づけ: ${esc(t.evacuation_message)}</div>
    ${(() => { const cv = coordCaveat(t); return cv ? `<div class="src" style="margin-top:3px">📍 ${esc(cv)}</div>` : ""; })()}
    <div class="src" style="margin-top:3px">${esc(t.caution)}</div>${srcLink(t)}`;
}

// マーカーアイコン: 色つき円。番号付きは少し大きい円＋白い連番ラベル（Leaflet版の divIcon に対応）。
function dotIcon(cat) {
  return { path: maps.SymbolPath.CIRCLE, scale: 7, fillColor: CATEGORY_COLORS[cat], fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 };
}
function numIcon(cat) {
  return { path: maps.SymbolPath.CIRCLE, scale: 12, fillColor: CATEGORY_COLORS[cat], fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 };
}

// 施設/伝承の popup を DOM ノードで作る（ボタンのクリックを確実に配線できる）。
function popupNode(rec, isFacility) {
  const div = document.createElement("div");
  div.className = "gmPopup";
  div.style.maxWidth = "260px";
  div.innerHTML = isFacility ? facilityPopup(rec) : traditionPopup(rec);
  if (isFacility) {
    div.querySelector("button[data-fid]")
      ?.addEventListener("click", () => onFacilityViewCb?.(rec.id));
  }
  return div;
}
function openInfo(rec, marker, isFacility) {
  if (!infoWindow) return;
  infoWindow.setContent(popupNode(rec, isFacility));
  infoWindow.open({ map: gmap, anchor: marker });
}

// 凡例・ヒントの DOM コントロールを作る（Leaflet の L.control 相当）。
function legendControl() {
  const div = document.createElement("div");
  div.className = "mapLegend";
  div.style.margin = "8px";
  div.innerHTML = Object.keys(CATEGORY_COLORS)
    .map((k) => `<span class="legendDot" style="background:${CATEGORY_COLORS[k]}"></span>${CATEGORY_LABELS[k]}`)
    .join("<br>");
  return div;
}
function hintControl() {
  const div = document.createElement("div");
  div.style.cssText =
    "background:rgba(13,43,69,.82);color:#fff;padding:4px 8px;border-radius:6px;font-size:11px;margin:8px";
  div.textContent = "🖱️ 地図をクリックすると、その地点を現在地にできます";
  return div;
}

export function initMap(el) {
  // loadGoogleMaps が reject（キー無し・読込失敗）したら呼び出し側(map.js)が Leaflet にフォールバックする。
  return loadGoogleMaps().then((m) => { maps = m; build(el); });
}

function build(el) {
  const bounds = new maps.LatLngBounds();
  gmap = new maps.Map(el, {
    center: { lat: 34.99, lng: 138.52 }, zoom: 14,
    mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
    clickableIcons: false, gestureHandling: "greedy",
    // ズーム等の標準UI・Google のロゴ・著作権/帰属は残す（消さない）。
  });
  infoWindow = new maps.InfoWindow({ maxWidth: 280 });

  for (const f of facilities) {
    if (!hasPos(f)) continue;
    const marker = new maps.Marker({ position: { lat: f.lat, lng: f.lng }, map: gmap, icon: dotIcon(categoryOf(f)) });
    marker.addListener("click", () => openInfo(f, marker, true));
    facilityMarkers.set(f.id, { marker, cat: categoryOf(f), rec: f });
    bounds.extend({ lat: f.lat, lng: f.lng });
  }
  for (const t of traditions) {
    if (!hasPos(t)) continue;
    const marker = new maps.Marker({ position: { lat: t.lat, lng: t.lng }, map: gmap, icon: dotIcon(categoryOf(t)) });
    marker.addListener("click", () => openInfo(t, marker, false));
    traditionMarkers.set(t.id, { marker, cat: categoryOf(t), rec: t });
    bounds.extend({ lat: t.lat, lng: t.lng });
  }
  if (!bounds.isEmpty()) gmap.fitBounds(bounds, 20);

  gmap.controls[maps.ControlPosition.TOP_RIGHT].push(legendControl());
  gmap.controls[maps.ControlPosition.LEFT_BOTTOM].push(hintControl()); // Googleロゴ(下中央/左下隅)を覆わない位置

  gmap.addListener("click", (e) => onMapClickCb?.(e.latLng.lat(), e.latLng.lng()));
  return gmap;
}

export function setCurrentPos(pos, label, { recenter = true } = {}) {
  if (!gmap) return;
  const position = { lat: pos.lat, lng: pos.lng };
  const icon = { path: maps.SymbolPath.CIRCLE, scale: 8, fillColor: "#d32f2f", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3 };
  if (!currentMarker) {
    currentMarker = new maps.Marker({ position, map: gmap, icon, title: label ?? "現在地", zIndex: 50 });
  } else {
    currentMarker.setPosition(position);
    currentMarker.setTitle(label ?? "現在地");
  }
  if (recenter) { gmap.setCenter(position); gmap.setZoom(Math.max(gmap.getZoom() ?? 15, 15)); }
}

export function focusFacility(id) {
  const e = facilityMarkers.get(id);
  if (!e || !gmap) return;
  gmap.setCenter(e.marker.getPosition());
  gmap.setZoom(17);
  openInfo(e.rec, e.marker, true);
}

// ---- カード番号 ↔ マーカー番号の同期 ----
export function setNumberedMarkers(kind, ordered) {
  resetMarkerNumbers();
  const target = kind === "tradition" ? traditionMarkers : facilityMarkers;
  (ordered ?? []).forEach((r, i) => {
    const e = target.get(r.id);
    if (!e) return;
    e.marker.setIcon(numIcon(e.cat));
    e.marker.setLabel({ text: String(i + 1), color: "#fff", fontSize: "12px", fontWeight: "700" });
    e.marker.setZIndex(1000);
  });
}

export function clearNumbers() {
  resetMarkerNumbers();
}

function resetMarkerNumbers() {
  for (const e of facilityMarkers.values()) { e.marker.setIcon(dotIcon(e.cat)); e.marker.setLabel(null); e.marker.setZIndex(1); }
  for (const e of traditionMarkers.values()) { e.marker.setIcon(dotIcon(e.cat)); e.marker.setLabel(null); e.marker.setZIndex(1); }
}

// 伝承/施設マーカーへ地図を移動して説明ポップアップを開く
export function focusLatLng(lat, lng) {
  if (!gmap) return;
  gmap.setCenter({ lat, lng });
  gmap.setZoom(17);
  let nearest = null, best = Infinity, isFac = false;
  for (const e of [...facilityMarkers.values()].map((x) => [x, true]).concat([...traditionMarkers.values()].map((x) => [x, false]))) {
    const [entry, fac] = e;
    const ll = entry.rec;
    const d = Math.hypot(ll.lat - lat, ll.lng - lng);
    if (d < best) { best = d; nearest = entry; isFac = fac; }
  }
  if (nearest && best < 1e-4) openInfo(nearest.rec, nearest.marker, isFac);
}

export async function showRoute(pos, facility, travelMode = "foot") {
  clearRoute();
  if (!hasPos(facility) || !gmap) return { mode: "none" };
  const r = await fetchRoute(pos, facility, travelMode, { allowGoogle: true });
  const color = ROUTE_COLOR[travelMode] ?? "#0d47a1";
  if (r.geometry) {
    const path = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    const arrow = { path: maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2.4, strokeColor: color, strokeWeight: 1, fillColor: color, fillOpacity: 1 };
    routeLine = new maps.Polyline({
      path, strokeColor: color, strokeOpacity: 0.85, strokeWeight: 5, map: gmap,
      icons: [{ icon: arrow, offset: "0", repeat: "120px" }], // 進行方向の矢印
    });
    fitToPath(path);
    return r; // { mode, geometry, distM, durS }
  }
  // 経路取得不可 → 直線を「参考」として灰色破線で描く
  const a = { lat: pos.lat, lng: pos.lng }, b = { lat: facility.lat, lng: facility.lng };
  routeLine = new maps.Polyline({
    path: [a, b], strokeOpacity: 0, map: gmap,
    icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: "#666", scale: 3 }, offset: "0", repeat: "12px" }],
  });
  fitToPath([a, b]);
  return { mode: "straight", distM: null };
}

function fitToPath(latlngs) {
  const b = new maps.LatLngBounds();
  latlngs.forEach((p) => b.extend(p));
  if (!b.isEmpty()) gmap.fitBounds(b, 30);
}

export function clearRoute() {
  if (routeLine) { routeLine.setMap(null); routeLine = null; }
}

export function invalidate() {
  if (!gmap || !maps) return;
  const c = gmap.getCenter();
  maps.event.trigger(gmap, "resize");
  if (c) gmap.setCenter(c);
}
