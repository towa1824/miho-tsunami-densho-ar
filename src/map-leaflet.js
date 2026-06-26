// Leaflet 地図（OSM タイル）バックエンド: 施設・伝承マーカー、現在地、選択先への経路表示。
// APIキー未設定時のメイン地図はこれ（キー設定時は map-google.js の Google Maps を使う＝map.js が選択）。
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  facilities, traditions, hasPos, categoryOf,
  CATEGORY_COLORS, CATEGORY_LABELS, intensityLabel, coordCaveat,
} from "./data.js";
import { formatDist } from "./geo.js";
import { fetchRoute, ROUTE_COLOR } from "./route.js";

let map;
let currentMarker = null;
let routeLine = null;
let onMapClickCb = null;
let onFacilityViewCb = null;
const facilityMarkers = new Map();  // id -> { marker, cat }
const traditionMarkers = new Map(); // id -> { marker, cat }

// 地図クリックで現在地を指定するためのコールバック登録
export function setOnMapClick(cb) { onMapClickCb = cb; }
// ポップアップ「現地目線で見る」→ 施設idを渡してビューを起動するコールバック
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
  const inten = intenStr
    ? `<br>推定震度: ${esc(intenStr)}（寺院被害記録による）` : "";
  return `<b>${esc(t.title)}</b><br>
    <span style="color:${CATEGORY_COLORS.tradition};font-weight:700">災害伝承・史料</span>
    ｜関連災害: ${esc(t.disaster)}${ht}${inten}
    <div class="pvDesc" style="margin-top:4px">${esc(t.summary)}</div>
    <div style="margin-top:4px;background:#fff3e0;padding:3px 5px;border-radius:3px">
      避難への意味づけ: ${esc(t.evacuation_message)}</div>
    ${(() => { const cv = coordCaveat(t); return cv ? `<div class="src" style="margin-top:3px">📍 ${esc(cv)}</div>` : ""; })()}
    <div class="src" style="margin-top:3px">${esc(t.caution)}</div>${srcLink(t)}`;
}

// マーカーアイコン: 通常は色つきドット、番号付きはカテゴリ色のバッジ（白い連番）。
function markerIcon(cat, number) {
  const color = CATEGORY_COLORS[cat];
  if (number == null) {
    return L.divIcon({
      className: "mapMarker",
      html: `<span class="mapMarker__dot" style="background:${color}"></span>`,
      iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -9],
    });
  }
  return L.divIcon({
    className: "mapMarker mapMarker--num",
    html: `<span class="mapMarker__badge" style="background:${color}">${number}</span>`,
    iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -13],
  });
}

function makeMarker(r, popupHtml) {
  const m = L.marker([r.lat, r.lng], { icon: markerIcon(categoryOf(r), null) });
  m.bindPopup(popupHtml, { maxWidth: 280, maxHeight: window.innerWidth < 760 ? 200 : 320 });
  return m;
}

export function initMap(el) {
  map = L.map(el, { zoomControl: true });
  // 地図(OSM) と 空撮(Esri World Imagery=無料・APIキー不要・要帰属) を切り替えられるようにする
  // （キー無しでも空撮モードを使えるようにするため。© は各レイヤの attribution で表示）。
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const esri = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" }
  );
  L.control.layers({ "🗺 地図": osm, "🛰 空撮": esri }, null, { position: "topleft" }).addTo(map);

  const bounds = [];
  for (const f of facilities) {
    if (!hasPos(f)) continue;
    const m = makeMarker(f, facilityPopup(f)).addTo(map);
    // ポップアップ内ボタンはHTML文字列なので、開いた時にクリックを配線する
    m.on("popupopen", (ev) => {
      ev.popup.getElement()?.querySelector("button[data-fid]")
        ?.addEventListener("click", () => onFacilityViewCb?.(f.id), { once: true });
    });
    facilityMarkers.set(f.id, { marker: m, cat: categoryOf(f) });
    bounds.push([f.lat, f.lng]);
  }
  for (const t of traditions) {
    if (!hasPos(t)) continue;
    const m = makeMarker(t, traditionPopup(t)).addTo(map);
    traditionMarkers.set(t.id, { marker: m, cat: categoryOf(t) });
    bounds.push([t.lat, t.lng]);
  }
  map.fitBounds(bounds, { padding: [20, 20] });

  // 凡例
  const legend = L.control({ position: "topright" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "mapLegend");
    div.innerHTML = Object.keys(CATEGORY_COLORS)
      .map((k) =>
        `<span class="legendDot" style="background:${CATEGORY_COLORS[k]}"></span>${CATEGORY_LABELS[k]}`)
      .join("<br>");
    return div;
  };
  legend.addTo(map);

  // クリックで現在地変更できることのヒント
  const hint = L.control({ position: "bottomleft" });
  hint.onAdd = () => {
    const div = L.DomUtil.create("div");
    div.style.cssText =
      "background:rgba(13,43,69,.82);color:#fff;padding:4px 8px;border-radius:6px;font-size:11px;margin-bottom:2px";
    div.innerHTML = "🖱️ 地図をクリックすると、その地点を現在地にできます";
    return div;
  };
  hint.addTo(map);

  // 地図をクリック → その地点を現在地に
  map.on("click", (e) => {
    if (onMapClickCb) onMapClickCb(e.latlng.lat, e.latlng.lng);
  });
  return map;
}

export function setCurrentPos(pos, label, { recenter = true } = {}) {
  if (!map) return;
  if (currentMarker) currentMarker.remove();
  currentMarker = L.circleMarker([pos.lat, pos.lng], {
    radius: 9, color: "#fff", weight: 3, fillColor: "#d32f2f", fillOpacity: 1,
  }).addTo(map).bindTooltip(label ?? "現在地", { permanent: false });
  if (recenter) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 15));
}

export function focusFacility(id) {
  const e = facilityMarkers.get(id);
  if (e) {
    map.setView(e.marker.getLatLng(), 17);
    e.marker.openPopup();
  }
}

// ---- カード番号 ↔ マーカー番号の同期 ----
export function setNumberedMarkers(kind, ordered) {
  resetMarkerNumbers();
  const target = kind === "tradition" ? traditionMarkers : facilityMarkers;
  (ordered ?? []).forEach((r, i) => {
    const e = target.get(r.id);
    if (!e) return;
    e.marker.setIcon(markerIcon(e.cat, i + 1));
    e.marker.setZIndexOffset(1000); // 重なっても番号が前面で読めるように
  });
}

export function clearNumbers() {
  resetMarkerNumbers();
}

function resetMarkerNumbers() {
  for (const e of facilityMarkers.values()) {
    e.marker.setIcon(markerIcon(e.cat, null));
    e.marker.setZIndexOffset(0);
  }
  for (const e of traditionMarkers.values()) {
    e.marker.setIcon(markerIcon(e.cat, null));
    e.marker.setZIndexOffset(0);
  }
}

// 伝承マーカーへ地図を移動して説明ポップアップを開く
export function focusLatLng(lat, lng) {
  if (!map) return;
  map.setView([lat, lng], 17);
  let nearest = null;
  let best = Infinity;
  map.eachLayer((layer) => {
    if (layer.getLatLng && layer.getPopup) {
      const ll = layer.getLatLng();
      const d = Math.hypot(ll.lat - lat, ll.lng - lng);
      if (d < best) { best = d; nearest = layer; }
    }
  });
  if (nearest && best < 1e-4) nearest.openPopup();
}

export async function showRoute(pos, facility, travelMode = "foot") {
  clearRoute();
  if (!hasPos(facility)) return { mode: "none" };
  const r = await fetchRoute(pos, facility, travelMode, { allowGoogle: true });
  if (r.geometry) {
    routeLine = L.geoJSON(r.geometry, {
      style: { color: ROUTE_COLOR[travelMode] ?? "#0d47a1", weight: 5, opacity: 0.85 },
    }).addTo(map);
    addDirectionArrows(r.geometry, ROUTE_COLOR[travelMode] ?? "#0d47a1");
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
    return r; // { mode, geometry, distM, durS }
  }
  // 経路取得不可 → 直線を「参考」として灰色破線で描く
  routeLine = L.polyline(
    [[pos.lat, pos.lng], [facility.lat, facility.lng]],
    { color: "#666", weight: 3, dashArray: "6 8" }
  ).addTo(map).bindTooltip("直線参考（経路計算不可）");
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  return { mode: "straight", distM: null };
}

// 進行方向の矢印を約120m間隔で配置（F-10相当）
let arrowMarkers = [];
function addDirectionArrows(geojson, color) {
  const coords = geojson.coordinates; // [[lng,lat],...]
  let acc = 0;
  const STEP = 120;
  for (let i = 1; i < coords.length; i++) {
    const [aLng, aLat] = coords[i - 1];
    const [bLng, bLat] = coords[i];
    const segM = haversine(aLat, aLng, bLat, bLng);
    acc += segM;
    if (acc >= STEP) {
      acc = 0;
      const ang = Math.atan2(bLng - aLng, bLat - aLat) * 180 / Math.PI;
      const icon = L.divIcon({
        className: "",
        html: `<div style="transform:rotate(${ang}deg);color:${color};font-size:16px;line-height:1">▲</div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      });
      arrowMarkers.push(L.marker([bLat, bLng], { icon, interactive: false }).addTo(map));
    }
  }
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = Math.PI / 180;
  const dp = (lat2 - lat1) * toR, dl = (lng2 - lng1) * toR;
  const a = Math.sin(dp / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function clearRoute() {
  if (routeLine) { routeLine.remove(); routeLine = null; }
  arrowMarkers.forEach((m) => m.remove());
  arrowMarkers = [];
}

export function invalidate() {
  if (map) map.invalidateSize();
}
