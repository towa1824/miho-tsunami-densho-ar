// Leaflet地図: 施設・伝承マーカー、現在地、選択先への経路表示
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  facilities, traditions, hasPos, categoryOf,
  CATEGORY_COLORS, CATEGORY_LABELS,
} from "./data.js";
import { formatDist } from "./geo.js";

let map;
let currentMarker = null;
let routeLine = null;
let onMapClickCb = null;
let onFacilityViewCb = null;
const facilityMarkers = new Map(); // id -> marker

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
  return `<b>${esc(f.name)}</b><br>
    <span style="color:${CATEGORY_COLORS[cat]};font-weight:700">${esc(CATEGORY_LABELS[cat])}</span>
    （${esc(f.type)}）<br>${h}${esc(f.evacuation_place ?? "")}<br>
    <div style="margin-top:4px">${esc(f.why ?? "")}</div>${shelterNote}${srcLink(f)}
    <button type="button" class="pvGo" data-fid="${esc(f.id)}"
      style="margin-top:6px;width:100%;padding:6px;border-radius:7px;border:none;
             background:#0d2b45;color:#fff;font-size:12px;font-weight:700">
      🧭 現地目線で見る</button>`;
}

function traditionPopup(t) {
  const ht = t.recorded_height_m != null
    ? `<br><b>記録上の津波高: 約${esc(t.recorded_height_m)}m</b>（${esc(t.recorded_height_note ?? "")}）` : "";
  const inten = t.intensity != null
    ? `<br>推定震度: ${t.intensity === 6.5 ? "6〜7" : esc(t.intensity)}（寺院被害記録による）` : "";
  return `<b>${esc(t.title)}</b><br>
    <span style="color:${CATEGORY_COLORS.tradition};font-weight:700">災害伝承・史料</span>
    ｜関連災害: ${esc(t.disaster)}${ht}${inten}
    <div style="margin-top:4px">${esc(t.summary)}</div>
    <div style="margin-top:4px;background:#fff3e0;padding:3px 5px;border-radius:3px">
      避難への意味づけ: ${esc(t.evacuation_message)}</div>
    <div class="src" style="margin-top:3px">${esc(t.caution)}</div>${srcLink(t)}`;
}

function makeMarker(r, popupHtml) {
  const cat = categoryOf(r);
  const m = L.circleMarker([r.lat, r.lng], {
    radius: cat === "tradition" || cat === "unsure" ? 8 : 9,
    color: "#ffffff",
    weight: 2,
    fillColor: CATEGORY_COLORS[cat],
    fillOpacity: 0.95,
  });
  m.bindPopup(popupHtml, { maxWidth: 280 });
  return m;
}

export function initMap(el) {
  map = L.map(el, { zoomControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const bounds = [];
  for (const f of facilities) {
    if (!hasPos(f)) continue;
    const m = makeMarker(f, facilityPopup(f)).addTo(map);
    // ポップアップ内ボタンはHTML文字列なので、開いた時にクリックを配線する
    m.on("popupopen", (ev) => {
      ev.popup.getElement()?.querySelector("button[data-fid]")
        ?.addEventListener("click", () => onFacilityViewCb?.(f.id), { once: true });
    });
    facilityMarkers.set(f.id, m);
    bounds.push([f.lat, f.lng]);
  }
  for (const t of traditions) {
    if (!hasPos(t)) continue;
    makeMarker(t, traditionPopup(t)).addTo(map);
    bounds.push([t.lat, t.lng]);
  }
  map.fitBounds(bounds, { padding: [20, 20] });

  // 凡例
  const legend = L.control({ position: "topright" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div");
    div.style.cssText =
      "background:rgba(255,255,255,.92);padding:6px 8px;border-radius:6px;font-size:10px;line-height:1.6;box-shadow:0 1px 3px rgba(0,0,0,.3)";
    div.innerHTML = Object.keys(CATEGORY_COLORS)
      .map((k) =>
        `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${CATEGORY_COLORS[k]};margin-right:4px"></span>${CATEGORY_LABELS[k]}`)
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
  const m = facilityMarkers.get(id);
  if (m) {
    map.setView(m.getLatLng(), 17);
    m.openPopup();
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

// 経路表示: OSRMで道路経路を取得。travelMode("foot"/"car")で線色を変える。
// ※公開OSRMサーバは車プロファイルのみ稼働のため経路の道筋は両モードで同じ。
//   所要時間は呼び出し側で徒歩=距離/80, 車=OSRM durationと出し分ける（geo.js）。
const ROUTE_COLOR = { foot: "#0d47a1", car: "#c62828" };

export async function showRoute(pos, facility, travelMode = "foot") {
  clearRoute();
  if (!hasPos(facility)) return { mode: "none" };
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${pos.lng},${pos.lat};${facility.lng},${facility.lat}` +
    `?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    const route = json.routes?.[0];
    if (route?.geometry) {
      routeLine = L.geoJSON(route.geometry, {
        style: { color: ROUTE_COLOR[travelMode] ?? "#0d47a1", weight: 5, opacity: 0.85 },
      }).addTo(map);
      addDirectionArrows(route.geometry, ROUTE_COLOR[travelMode] ?? "#0d47a1");
      map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
      // geometry(GeoJSON LineString)は現地目線ビューの道筋描画にも使う
      return { mode: "osrm", distM: route.distance, durS: route.duration,
               geometry: route.geometry };
    }
  } catch { /* OSRM不達時は直線にフォールバック */ }
  routeLine = L.polyline(
    [[pos.lat, pos.lng], [facility.lat, facility.lng]],
    { color: "#666", weight: 3, dashArray: "6 8" }
  ).addTo(map).bindTooltip("直線参考（経路計算不可）");
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  // 直線距離は呼び出し側のstraight扱いで時間計算
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
