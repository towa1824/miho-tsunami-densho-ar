// アプリ全体の制御: タブ切替・現在地(GPS/デモ)・地図・AR起動
import "./style.css";
import { demoLocations, facilityById, nearestTradition } from "./data.js";
import * as MapView from "./map.js";
import * as AR from "./ar.js";
import { initMiniMap, drawMiniMap } from "./minimap.js";
import {
  renderFacilitiesTab, renderTraditionsTab, renderArTab, renderAboutTab,
  arOverlayHtml,
} from "./ui.js";
import { distanceM, bearingDeg, travelTimeMin, formatDuration, formatDist, TRAVEL_LABEL } from "./geo.js";

const state = {
  pos: null,        // {lat,lng}
  posLabel: "",
  tab: "facilities",
  selected: null,   // ビュー/経路で選択中の施設
  usingDemo: true,
  // 既定はPC/スマホとも「現地目線ビュー」(sim)。HTTPローカルでも動き、カメラ許可も不要。
  // "live"(ARカメラ)はユーザーがモード切替で明示的に選んだ時のみ使う。
  arMode: "sim",
  travelMode: "foot",   // 徒歩 / 車（F-09）
  routedFacilityId: null,
  routeGeometry: null,  // OSRMの経路形状（現地目線ビューの道筋描画に渡す）
};
let arStatusMsg = "";
let headingTimer = null;

const el = {
  demoSelect: document.getElementById("demoSelect"),
  locLabel: document.getElementById("locLabel"),
  panel: document.getElementById("panel"),
  tabs: document.querySelectorAll("#tabs .tab"),
  map: document.getElementById("map"),
  stage: document.getElementById("stage"),
  travelToggle: document.getElementById("travelToggle"),
  routeSummary: document.getElementById("routeSummary"),
  arView: document.getElementById("arView"),
  arHolder: document.getElementById("arCanvasHolder"),
  arOverlay: document.getElementById("arOverlay"),
  arExit: document.getElementById("arExit"),
  arAttrib: document.getElementById("arAttrib"),
  arSimControls: document.getElementById("arSimControls"),
  arHeading: document.getElementById("arHeading"),
  arFaceBtn: document.getElementById("arFaceBtn"),
  arResetBtn: document.getElementById("arResetBtn"),
  arZoomIn: document.getElementById("arZoomIn"),
  arZoomOut: document.getElementById("arZoomOut"),
  arWalkResetBtn: document.getElementById("arWalkResetBtn"),
  arDpad: document.getElementById("arDpad"),
  arMiniMap: document.getElementById("arMiniMap"),
};

const handlers = {
  onShowRoute: (id) => showRouteFor(id),
  onSelectAr: (id) => { state.selected = facilityById(id); switchTab("ar"); },
  onPanTo: (lat, lng) => MapView.focusLatLng(lat, lng),
  onStartAR: (f) => startAR(f),
  onSetArMode: (m) => { state.arMode = m; if (state.tab === "ar") renderActiveTab(); },
};

// ---- 現在地 ----
function setPos(pos, label, { isDemo = true, recenter = true } = {}) {
  state.pos = pos;
  state.posLabel = label;
  state.usingDemo = isDemo;
  el.locLabel.textContent = label;
  MapView.setCurrentPos(pos, label, { recenter });
  MapView.clearRoute();
  state.routedFacilityId = null;
  state.routeGeometry = null;
  if (el.routeSummary) { el.routeSummary.hidden = true; el.routeSummary.innerHTML = ""; }
  renderActiveTab();
}

function initDemoSelect() {
  const opts = [
    `<option value="__map">🖱️ 地図クリックで指定</option>`,
    `<option value="__gps">📍 GPSを使う（屋外・HTTPS）</option>`,
  ].concat(demoLocations.map((d) =>
    `<option value="${d.id}">🧭 デモ: ${d.label}</option>`));
  el.demoSelect.innerHTML = opts.join("");
  // 既定は最初のデモ地点（発表・デスクトップ確認用 / CLAUDE.md: fakeGpsで開発）
  el.demoSelect.value = demoLocations[0].id;
  el.demoSelect.addEventListener("change", onDemoChange);
}

function onDemoChange() {
  const v = el.demoSelect.value;
  if (v === "__gps") return useGps();
  if (v === "__map") {
    el.locLabel.textContent = "地図上のいるあたりをクリックしてください";
    return;
  }
  const d = demoLocations.find((x) => x.id === v);
  if (d) setPos({ lat: d.lat, lng: d.lng }, `デモ: ${d.label}`, { isDemo: true });
}

// 地図クリックで現在地を指定（その地点から避難案内）
function onMapPick(lat, lng) {
  el.demoSelect.value = "__map";
  setPos({ lat, lng }, `地図で選択した地点 (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
    { isDemo: true, recenter: false });
}

function useGps() {
  if (!navigator.geolocation) {
    el.locLabel.textContent = "GPS非対応の環境です。デモ地点を選んでください。";
    return;
  }
  el.locLabel.textContent = "GPS取得中…";
  navigator.geolocation.getCurrentPosition(
    (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }, "GPS現在地", { isDemo: false }),
    () => {
      el.locLabel.textContent = "GPS取得に失敗。デモ地点に戻します。";
      el.demoSelect.value = demoLocations[0].id;
      onDemoChange();
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// ---- タブ ----
function switchTab(tab) {
  state.tab = tab;
  el.tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  renderActiveTab();
}

function renderActiveTab() {
  const p = el.panel;
  if (state.tab === "facilities") renderFacilitiesTab(p, state.pos, handlers, state.travelMode);
  else if (state.tab === "traditions") renderTraditionsTab(p, state.pos, handlers);
  else if (state.tab === "ar") renderArTab(p, state.pos, state, handlers);
  else if (state.tab === "about") renderAboutTab(p);
}

// ---- 経路 + 距離/所要時間（F-09, F-19）----
async function showRouteFor(id) {
  const f = facilityById(id);
  if (!f || !state.pos) return;
  state.selected = f;
  state.routedFacilityId = id;
  MapView.focusFacility(id);
  showRouteSummary(f, null, "計算中…");
  const r = await MapView.showRoute(state.pos, f, state.travelMode);
  // 経路形状を保持し、現地目線ビューの道筋描画に渡す
  state.routeGeometry = r?.geometry ?? null;
  showRouteSummary(f, r);
}

// 上部バーに距離・所要時間を表示（F-19）
function showRouteSummary(f, r, loading) {
  const label = TRAVEL_LABEL[state.travelMode];
  if (loading) {
    el.routeSummary.hidden = false;
    el.routeSummary.innerHTML = `<b>${f.name}</b> への経路を${loading}`;
    return;
  }
  // 距離: OSRM経路があれば道路距離、無ければ直線距離
  const straight = distanceM(state.pos.lat, state.pos.lng, f.lat, f.lng);
  const distM = r && r.distM != null ? r.distM : straight;
  // 時間: 徒歩=距離/80, 車=OSRM duration（無ければ概算）
  let min;
  if (state.travelMode === "car" && r && r.durS != null) min = Math.max(1, Math.round(r.durS / 60));
  else min = travelTimeMin(distM, state.travelMode);
  const via = r && r.mode === "straight" ? "（直線参考・道路経路は取得できず）"
    : r && r.mode === "osrm" ? "（道路距離）" : "";
  el.routeSummary.hidden = false;
  el.routeSummary.innerHTML =
    `🏁 <b>${f.name}</b>まで ${label} <b>${formatDuration(min)}</b>` +
    `・${formatDist(distM)}${via}` +
    `<button id="routeClear" type="button">×</button>`;
  el.routeSummary.querySelector("#routeClear")?.addEventListener("click", clearRouteSummary);
}

function clearRouteSummary() {
  state.routedFacilityId = null;
  state.routeGeometry = null;
  el.routeSummary.hidden = true;
  el.routeSummary.innerHTML = "";
  MapView.clearRoute();
}

function onTravelChange(mode) {
  if (state.travelMode === mode) return;
  state.travelMode = mode;
  [...el.travelToggle.querySelectorAll("button")].forEach((b) =>
    b.classList.toggle("on", b.dataset.travel === mode));
  renderActiveTab(); // カード/ARの所要時間を更新
  if (state.routedFacilityId) showRouteFor(state.routedFacilityId); // 表示中の経路を引き直す
}

// ---- AR ----
function updateArOverlay() {
  if (!state.selected) return;
  const f = state.selected;
  // 歩いて移動した後は実効現在地で距離を出す（AR.effectivePos）
  const pos = (AR.isStarted() && AR.effectivePos()) || state.pos;
  if (!pos) return;
  const dist = distanceM(pos.lat, pos.lng, f.lat, f.lng);
  const t = nearestTradition(pos);
  const statusHtml = arStatusMsg
    ? `<div class="arInfoCard" style="margin-bottom:6px;background:rgba(255,243,224,.95)">${arStatusMsg}</div>` : "";
  el.arOverlay.innerHTML = statusHtml + arOverlayHtml(f, dist, t, state.travelMode);
}

function setArStatus(msg) { arStatusMsg = msg; updateArOverlay(); }

// 画面D-padで歩く（押している間だけ移動）
function setupDpad() {
  const apply = () => {
    const f = (dpad.F ? 1 : 0) + (dpad.B ? -1 : 0);
    const s = (dpad.R ? 1 : 0) + (dpad.L ? -1 : 0);
    AR.setMoveInput?.(f, s);
  };
  const dpad = { F: 0, B: 0, L: 0, R: 0 };
  el.arDpad.querySelectorAll("button[data-move]").forEach((b) => {
    const key = b.dataset.move;
    const press = (e) => { e.preventDefault(); dpad[key] = 1; apply(); };
    const release = (e) => { e.preventDefault(); dpad[key] = 0; apply(); };
    b.addEventListener("pointerdown", press);
    b.addEventListener("pointerup", release);
    b.addEventListener("pointerleave", release);
    b.addEventListener("pointercancel", release);
  });
}

async function startAR(facility) {
  state.selected = facility;
  arStatusMsg = "";
  el.arView.hidden = false;
  // 検証モードの操作ボタン・移動D-pad・町並み(OSM)出典表示
  el.arSimControls.hidden = state.arMode !== "sim";
  el.arDpad.hidden = state.arMode !== "sim";
  el.arAttrib.hidden = state.arMode !== "sim";
  AR.setOnUpdate(() => { updateArOverlay(); updateHeadingHud(); });
  AR.setOnStatus((msg) => setArStatus(msg));
  updateArOverlay();
  try {
    // デモ現在地は fakeGps（屋内・発表・検証用）、GPSモードは実機GPS
    const fakePos = state.usingDemo ? state.pos : null;
    // 経路形状は「この施設向けに引いた経路」の時だけ渡す（別施設の形状を流用しない）
    const routeGeometry =
      state.routedFacilityId === facility.id ? state.routeGeometry : null;
    await AR.startAR(el.arHolder, { fakePos, facility, mode: state.arMode, routeGeometry });
    // 方位HUD・ミニマップを定期更新
    clearInterval(headingTimer);
    headingTimer = setInterval(updateHeadingHud, 200);
  } catch (e) {
    el.arOverlay.innerHTML =
      `<div class="arInfoCard">ビューを開始できませんでした。<br>
       ARカメラはHTTPS・カメラ/方位センサー許可が必要です。「現地目線」タブの
       現地目線ビュー（カメラ不要）をご利用ください。<br><small>${String(e)}</small></div>`;
  }
}

function updateHeadingHud() {
  const h = AR.currentHeading();
  const f = state.selected;
  const pos = (AR.isStarted() && AR.effectivePos()) || state.pos;
  // ミニマップ: 現在位置・向き・目的地を更新（liveで方位が取れない時は向き扇形なし）
  if (AR.isStarted() && pos) drawMiniMap(pos, h, f);
  if (h == null) { el.arHeading.textContent = ""; return; }
  let tgt = "";
  if (f && pos && f.lat != null) {
    const b = bearingDeg(pos.lat, pos.lng, f.lat, f.lng);
    const diff = Math.round(((b - h + 540) % 360) - 180);
    const aligned = Math.abs(diff) < 8;
    const dist = distanceM(pos.lat, pos.lng, f.lat, f.lng);
    tgt = aligned ? `　✓ この方向・あと ${Math.round(dist)}m` :
      `　${f.name}は ${diff > 0 ? "右" : "左"}へ ${Math.abs(diff)}°・あと ${Math.round(dist)}m`;
  }
  el.arHeading.innerHTML = `方位 <b>${Math.round(h)}°</b>${tgt}`;
  // 歩行中はオーバーレイの距離も更新
  updateArOverlay();
}

function exitAR() {
  clearInterval(headingTimer); headingTimer = null;
  AR.stopAR();
  el.arView.hidden = true;
  el.arSimControls.hidden = true;
  el.arDpad.hidden = true;
  el.arAttrib.hidden = true;
  el.arOverlay.innerHTML = "";
  el.arHeading.textContent = "";
  MapView.invalidate();
}

// ---- 初期化 ----
function init() {
  MapView.initMap(el.map);
  MapView.setOnMapClick(onMapPick); // 地図クリックで現在地を指定
  // 地図ポップアップの「現地目線で見る」→ 施設を選択してビューを開く
  MapView.setOnFacilityView((id) => {
    const f = facilityById(id);
    if (!f || f.lat == null) return;
    state.selected = f;
    switchTab("ar");
    startAR(f);
  });
  initMiniMap(el.arMiniMap);
  initDemoSelect();
  el.tabs.forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  el.arExit.addEventListener("click", exitAR);
  el.arFaceBtn.addEventListener("click", () => AR.faceTarget());
  el.arResetBtn.addEventListener("click", () => AR.faceNorth?.());
  el.arZoomIn.addEventListener("click", () => AR.zoomBy(1.25));
  el.arZoomOut.addEventListener("click", () => AR.zoomBy(1 / 1.25));
  el.arWalkResetBtn.addEventListener("click", () => AR.resetWalk?.());
  setupDpad();
  el.travelToggle.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => onTravelChange(b.dataset.travel)));
  onDemoChange(); // 初期デモ地点で表示
  switchTab("facilities");
  // 地図のサイズ確定（タブ・パネル配置後）
  setTimeout(() => MapView.invalidate(), 200);
}

init();
