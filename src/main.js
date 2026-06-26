// アプリ全体の制御: タブ切替・現在地(GPS/デモ)・地図・AR起動
import "./style.css";
import { demoLocations, facilityById, traditionById, nearestTradition, traditionsWithin, nearestTsunamiFacilities, coordCaveat } from "./data.js";
import * as MapView from "./map.js";
import * as AR from "./ar.js";
import * as SV from "./streetview.js";
import * as SVMap from "./streetview-map.js";
import { initMiniMap, drawMiniMap } from "./minimap.js";
import {
  renderFacilitiesTab, renderTraditionsTab, renderArTab, renderAboutTab,
  arOverlayHtml, learnOverlayHtml, streetviewOverlayHtml, traditionStreetviewOverlayHtml,
} from "./ui.js";
import { distanceM, bearingDeg, destPoint, compassLabel, travelTimeMin, formatDuration, formatDist, routePositionInfo, TRAVEL_LABEL } from "./geo.js";

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
  facilityRoadOrder: null, // 道路距離で並べ替えた避難先上位（取得できた時のみ。既定は直線距離順）
  routeGeometry: null,  // OSRMの経路形状（現地目線ビューの道筋描画に渡す）
  arRoute: null,        // AR起動時に確保した道路経路 { mode, geometry, distM, durS }
  learnTradition: null, // 伝承学習ビューで深掘り中の伝承
  // "streetview": Googleストリートビューで表示中の避難施設（sim/live とは独立した追加ビュー）。
  // 既存の arMode("sim"/"live") は一切変えない。
  streetviewFacility: null,
  svRoute: null,        // Street View用に確保した現在地→避難施設の道路経路 { mode, geometry, distM, durS, travelMode }
  // 共有の #streetView を「避難所の道順案内(facility)」と「伝承の実写学習(tradition)」で使い分ける。
  // facility と tradition を取り違えない（道順HUDは facility のみ・tradition では出さない）。
  svMode: null,             // "facility" | "tradition" | null
  streetviewTradition: null, // 伝承SVで表示中の伝承（avoid: facility と兼用しない）
};
let svExpanded = false; // ストリートビューの下部カードの展開状態
let gmaps = null;       // loadGoogleMaps() で得た window.google.maps（2D地図パネルで再利用）
let svMapOpen = false;  // Street View 内の2D Google Mapパネルを開いているか
let svMapExpanded = false; // 2D地図パネルが拡大状態か
let arStatusMsg = "";
let navExpanded = false; // ナビカードの展開状態（折りたたみ）
let headingTimer = null;
// 下部シート（スワイプで高さ変更）。snapは画面サイズから算出。0=最小(地図最大) 1=中(既定) 2=最大
let sheetSnaps = { min: 0, mid: 0, max: 0 };
let sheetIndex = 1;

const el = {
  demoSelect: document.getElementById("demoSelect"),
  locLabel: document.getElementById("locLabel"),
  panel: document.getElementById("panel"),
  tabs: document.querySelectorAll("#tabs .tab"),
  map: document.getElementById("map"),
  stage: document.getElementById("stage"),
  tabBar: document.getElementById("tabs"),
  sheetHandle: document.getElementById("sheetHandle"),
  travelToggle: document.getElementById("travelToggle"),
  routeSummary: document.getElementById("routeSummary"),
  arView: document.getElementById("arView"),
  arHolder: document.getElementById("arCanvasHolder"),
  arOverlay: document.getElementById("arOverlay"),
  arExit: document.getElementById("arExit"),
  arAttrib: document.getElementById("arAttrib"),
  arToast: document.getElementById("arToast"),
  arSimControls: document.getElementById("arSimControls"),
  arHeading: document.getElementById("arHeading"),
  arFaceBtn: document.getElementById("arFaceBtn"),
  arResetBtn: document.getElementById("arResetBtn"),
  arZoomIn: document.getElementById("arZoomIn"),
  arZoomOut: document.getElementById("arZoomOut"),
  arWalkResetBtn: document.getElementById("arWalkResetBtn"),
  arDpad: document.getElementById("arDpad"),
  arMiniMap: document.getElementById("arMiniMap"),
  streetView: document.getElementById("streetView"),
  svPano: document.getElementById("svPano"),
  svOverlay: document.getElementById("svOverlay"),
  svMessage: document.getElementById("svMessage"),
  svExit: document.getElementById("svExit"),
  svGuide: document.getElementById("svGuide"),
  svArrow: document.getElementById("svArrow"),
  svArrowInner: document.getElementById("svArrowInner"),
  svMiniMap: document.getElementById("svMiniMap"),
  svMapBtn: document.getElementById("svMapBtn"),
  svGoogleMapPanel: document.getElementById("svGoogleMapPanel"),
  svGoogleMap: document.getElementById("svGoogleMap"),
  svGoogleMapExpand: document.getElementById("svGoogleMapExpand"),
  svGoogleMapClose: document.getElementById("svGoogleMapClose"),
  svgmRouteMode: document.getElementById("svgmRouteMode"),
  svgmType: document.getElementById("svgmType"),
};

// ミニマップは現地目線ビューとStreet Viewで別canvas（同時には開かない）。それぞれ独立インスタンス。
let arMini = null;
let svMini = null;
let svGuideRaf = 0; // pov_changed連発でも描画を間引く（rAFで1フレーム1回）

// Street View の名前ラベル(InfoWindow)へ施設名を埋める時の最小エスケープ（データは自前JSONだが念のため）
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const handlers = {
  onShowRoute: (id) => showRouteFor(id),
  onSelectAr: (id) => { state.selected = facilityById(id); switchTab("ar"); },
  onPanTo: (lat, lng) => MapView.focusLatLng(lat, lng),
  onStartAR: (f) => startAR(f),
  onSetArMode: (m) => { state.arMode = m; if (state.tab === "ar") renderActiveTab(); },
  onLearnTradition: (id) => startLearnAR(traditionById(id)),
  onStreetView: (id) => openStreetView(facilityById(id)),
  onTraditionStreetView: (id) => openTraditionStreetView(traditionById(id)),
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
  state.facilityRoadOrder = null; // 現在地が変わったら一旦直線距離順に戻し、道路距離は取り直す
  if (el.routeSummary) { el.routeSummary.hidden = true; el.routeSummary.innerHTML = ""; }
  renderActiveTab();
  scheduleRoadOrder();
}

// 候補避難先を「道路距離（参考経路）」で並べ替える。まず直線距離順で即描画した後、
// OSRM の道路距離を非同期取得して上位を再ソート→再描画する。取得できなければ直線距離順のまま。
// カード番号・地図マーカー番号は renderActiveTab 経由で常に同じ並びに同期される。
let roadSortToken = 0;
function scheduleRoadOrder() {
  const token = ++roadSortToken;
  if (!state.pos) return;
  const mode = state.travelMode;
  const cands = nearestTsunamiFacilities(state.pos, 5); // 直線距離の上位候補に対してのみ道路距離を引く
  if (cands.length < 2) return;
  Promise.all(cands.map((f) =>
    MapView.fetchRoute(state.pos, f, mode)
      .then((r) => ({ f, r }))
      .catch(() => ({ f, r: null }))
  )).then((rows) => {
    if (token !== roadSortToken || !state.pos) return; // 現在地/移動手段が変わった→破棄
    const road = rows
      .filter((x) => x.r && x.r.mode === "osrm" && x.r.distM != null)
      .map((x) => ({ ...x.f, _roadDistM: x.r.distM, _roadDurS: x.r.durS }))
      .sort((a, b) => a._roadDistM - b._roadDistM);
    if (road.length < 3) return; // 道路距離が揃わない時は直線距離順のまま（誤解を避ける）
    state.facilityRoadOrder = road.slice(0, 3);
    if (state.tab === "facilities") renderActiveTab();
  });
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
  // カードの表示順をそのまま地図マーカーの番号へ渡す（番号生成はカード側=ui.jsに一本化）。
  if (state.tab === "facilities") {
    const ordered = renderFacilitiesTab(p, state.pos, handlers, state.travelMode, state.facilityRoadOrder);
    MapView.setNumberedMarkers("facility", ordered);
  } else if (state.tab === "traditions") {
    const ordered = renderTraditionsTab(p, state.pos, handlers);
    MapView.setNumberedMarkers("tradition", ordered);
  } else if (state.tab === "ar") {
    renderArTab(p, state.pos, state, handlers);
    MapView.clearNumbers();
  } else if (state.tab === "about") {
    renderAboutTab(p);
    MapView.clearNumbers();
  }
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
  // 時間: OSRMのduration（徒歩=footプロファイル, 車=carプロファイル）。直線時のみ概算。
  let min;
  if (r && r.durS != null) min = Math.max(1, Math.round(r.durS / 60));
  else min = travelTimeMin(distM, state.travelMode);
  const via = r && r.mode === "straight" ? "（直線参考・道路経路は取得できず）"
    : r && r.geometry ? "（参考経路・道路距離。徒歩最短ではありません）" : "";
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
  state.facilityRoadOrder = null; // 徒歩/車で道路距離が変わるため取り直す
  [...el.travelToggle.querySelectorAll("button")].forEach((b) =>
    b.classList.toggle("on", b.dataset.travel === mode));
  renderActiveTab(); // カード/ARの所要時間を更新
  scheduleRoadOrder();
  if (state.routedFacilityId) showRouteFor(state.routedFacilityId); // 表示中の経路を引き直す
}

// ---- AR ----
function updateArOverlay() {
  if (!state.selected) return;
  const f = state.selected;
  const r = state.arRoute || { mode: "straight" };
  const ns = AR.isStarted() ? AR.nextStep() : null;
  let nextText = "";
  if (ns) {
    const dir = compassLabel(ns.brg);
    nextText = ns.hasRoute ? `次は${dir}へ約${Math.round(ns.dist)}m` : `目的地は${dir}方向`;
  }
  const nav = {
    mode: r.mode,
    distM: r.distM ?? null,
    durS: r.durS ?? null,
    remainingM: ns?.remaining ?? r.distM ?? null,
    nextText,
  };
  const pos = (AR.isStarted() && AR.effectivePos()) || state.pos;
  const t = pos ? nearestTradition(pos) : null;
  el.arOverlay.innerHTML = arOverlayHtml(f, nav, t, state.travelMode, navExpanded);
}

// 一時メッセージは上部トーストに出し、数秒で自動的に消す（下部のナビカード・操作に被らない）
let toastTimer = null;
function setArStatus(msg) {
  arStatusMsg = msg;
  if (!el.arToast) return;
  el.arToast.textContent = msg || "";
  el.arToast.hidden = !msg;
  clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => { el.arToast.hidden = true; }, 5000);
}

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

// ---- 下部シート（タブ＋カードをスワイプで上下リサイズ）----
// 経路案内を見やすくするため、シートを下げると地図が広がる。snapは画面サイズから都度算出する。
function computeSheetSnaps() {
  const stageTop = el.stage.getBoundingClientRect().top;        // 上部チャーム（ヘッダ等）の下端
  const handleH = el.sheetHandle.offsetHeight || 34;
  const tabsH = el.tabBar.offsetHeight || 38;
  const avail = window.innerHeight - stageTop - handleH - tabsH; // 地図＋パネルに使える高さ
  const peek = Math.min(180, Math.max(110, Math.round(avail * 0.25))); // 最大化時に残す地図の高さ
  const max = Math.max(140, avail - peek);
  const mid = Math.min(max, Math.round(window.innerHeight * 0.44));
  sheetSnaps = { min: 0, mid, max };
}

// スナップ位置 i (0/1/2) へシートを移動。高さは CSS変数 --panel-h で反映（transitionで吸着）。
function setSheetSnap(i) {
  sheetIndex = Math.max(0, Math.min(2, i));
  computeSheetSnaps();
  const h = [sheetSnaps.min, sheetSnaps.mid, sheetSnaps.max][sheetIndex];
  document.body.classList.toggle("sheet-collapsed", sheetIndex === 0);
  el.sheetHandle.setAttribute("aria-expanded", String(sheetIndex !== 0));
  el.panel.style.setProperty("--panel-h", `${h}px`);
}

// タブをタップしたとき最小化されていたら中段へ広げる（カードが見えるように）
function expandSheetIfCollapsed() {
  if (sheetIndex === 0) setSheetSnap(1);
}

function setupSheet() {
  const handle = el.sheetHandle, panel = el.panel;
  let dragging = false, startY = 0, startH = 0, moved = 0, raf = 0;
  // ドラッグ中はトランジションを切っているので、地図はrAFで間引いて再計測し追従させる
  const liveInvalidate = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; MapView.invalidate(); });
  };
  const onDown = (e) => {
    dragging = true; moved = 0; startY = e.clientY;
    computeSheetSnaps();
    startH = panel.getBoundingClientRect().height;
    document.body.classList.add("sheet-dragging");
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;                 // 上方向ドラッグで＋（高くなる）
    moved = Math.max(moved, Math.abs(dy));
    const h = Math.min(sheetSnaps.max, Math.max(0, startH + dy));
    document.body.classList.toggle("sheet-collapsed", h < 6);
    panel.style.setProperty("--panel-h", `${h}px`);
    liveInvalidate();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sheet-dragging");
    if (moved < 6) { setSheetSnap((sheetIndex + 1) % 3); return; } // ほぼ動かさなければタップ＝次の段へ
    const h = panel.getBoundingClientRect().height;
    const arr = [sheetSnaps.min, sheetSnaps.mid, sheetSnaps.max];   // ドラッグ終点に最も近い段へ吸着
    let best = 0, bestD = Infinity;
    arr.forEach((v, i) => { const d = Math.abs(v - h); if (d < bestD) { bestD = d; best = i; } });
    setSheetSnap(best);
  };
  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  handle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { setSheetSnap(sheetIndex + 1); e.preventDefault(); }
    else if (e.key === "ArrowDown") { setSheetSnap(sheetIndex - 1); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === " ") { setSheetSnap((sheetIndex + 1) % 3); e.preventDefault(); }
  });
  // スナップ完了（高さのトランジション終了）で地図を再計測＝タイル/経路が欠けない
  panel.addEventListener("transitionend", (e) => { if (e.propertyName === "height") MapView.invalidate(); });
  window.addEventListener("resize", () => setSheetSnap(sheetIndex));
  setSheetSnap(1); // 既定は中段
}

async function startAR(facility) {
  state.selected = facility;
  arStatusMsg = "";
  navExpanded = false;
  el.arView.hidden = false;
  el.arView.classList.remove("navExpanded");
  // 検証モードの操作ボタン・移動D-pad・町並み(OSM)出典表示
  el.arSimControls.hidden = state.arMode !== "sim";
  el.arDpad.hidden = state.arMode !== "sim";
  el.arAttrib.hidden = state.arMode !== "sim";
  el.arFaceBtn.textContent = "🎯 進行方向";
  AR.setOnUpdate(() => { updateArOverlay(); updateHeadingHud(); });
  AR.setOnStatus((msg) => setArStatus(msg));
  // 「現地目線で案内」から直接来ても、まず必ず道路経路を確保してからARを開く。
  el.arOverlay.innerHTML = `<div class="arNavCard"><div class="arNavBody" style="display:block">経路を計算中…</div></div>`;
  let r = { mode: "straight" };
  if (state.pos) {
    // 「現地目線で案内」で表示する1本 → Google Routes を許可（キー無し/失敗時は OSRM→直線）
    try { r = await MapView.fetchRoute(state.pos, facility, state.travelMode, { allowGoogle: true }); } catch { /* 直線参考へ */ }
  }
  state.arRoute = r;
  state.routeGeometry = r.geometry ?? null;
  state.routedFacilityId = r.geometry ? facility.id : null;
  try {
    // デモ現在地は fakeGps（屋内・発表・検証用）、GPSモードは実機GPS
    const fakePos = state.usingDemo ? state.pos : null;
    // 道路経路が取れた時だけ青ルートを渡す（取れなければ AR 側で灰破線の直線参考）
    await AR.startAR(el.arHolder, {
      fakePos, facility, mode: state.arMode,
      routeGeometry: r.geometry ?? null,
    });
    updateArOverlay();
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

// 伝承学習ビューを開く（避難ナビとは切り離し、選んだ伝承スポットを深掘り）
async function startLearnAR(t) {
  if (!t || t.lat == null) return;
  state.learnTradition = t;
  arStatusMsg = "";
  el.arView.hidden = false;
  el.arSimControls.hidden = false; // 見回し・出発地点へ戻る
  el.arDpad.hidden = false;        // 歩いて移動
  el.arAttrib.hidden = false;      // OSM出典
  el.arFaceBtn.textContent = "📜 伝承";
  AR.setOnUpdate(() => { updateLearnOverlay(); updateHeadingHud(); });
  AR.setOnStatus((msg) => setArStatus(msg));
  updateLearnOverlay();
  try {
    // 伝承スポットの少し手前（南25m）に立って、正面にスポットを見る
    const stand = destPoint(t.lat, t.lng, 180, 25);
    await AR.startAR(el.arHolder, { fakePos: stand, mode: "learn", tradition: t });
    clearInterval(headingTimer);
    headingTimer = setInterval(updateHeadingHud, 200);
  } catch (e) {
    el.arOverlay.innerHTML =
      `<div class="arInfoCard">学習ビューを開始できませんでした。<br><small>${String(e)}</small></div>`;
  }
}

function updateLearnOverlay() {
  const t = state.learnTradition;
  if (!t) return;
  el.arOverlay.innerHTML = learnOverlayHtml(t);
}

// 200msごと: 方位HUD（次アクション）とミニマップ（実経路）を更新する。
// オーバーレイカードはここでは書き換えない（移動時=onUpdateで更新。読書中のスクロールを保つ）。
function updateHeadingHud() {
  const h = AR.currentHeading();
  const learning = AR.isStarted() && AR.getMode() === "learn";
  const f = learning ? state.learnTradition : state.selected;
  const pos = (AR.isStarted() && AR.effectivePos()) || state.pos;
  // ミニマップ: 学習時は経路なし。案内時は実経路ポリラインを渡す。
  if (AR.isStarted() && pos) {
    drawMiniMap(arMini, pos, h, learning ? null : f, learning ? null : state.arRoute?.geometry);
  }
  if (h == null) { el.arHeading.textContent = ""; return; }
  let tgt = "";
  if (!learning) {
    const ns = AR.isStarted() ? AR.nextStep() : null;
    if (ns) {
      const diff = Math.round(((ns.brg - h + 540) % 360) - 180);
      const aligned = Math.abs(diff) < 12;
      const turn = aligned ? "✓ この向き" : `${diff > 0 ? "右" : "左"}へ${Math.abs(diff)}°`;
      tgt = `　${ns.hasRoute ? "次は" : "目的地は"}${turn}・約${Math.round(ns.dist)}m`;
    }
  }
  el.arHeading.innerHTML = `方位 <b>${Math.round(h)}°</b>${tgt}`;
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
  if (el.arToast) el.arToast.hidden = true;
  clearTimeout(toastTimer);
  el.arView.classList.remove("navExpanded");
  state.learnTradition = null;
  state.arRoute = null;
  navExpanded = false;
  MapView.invalidate();
}

// ---- Googleストリートビュー（追加ビュー）----
// 既存の sim/live 現地目線ビューは置き換えず、選択した避難施設の周辺確認用に別の全画面ビューを開く。
// キー未設定・パノラマ未提供・読込失敗時はメッセージを出し、現地目線ビュー(OSM)へ戻れるようにする。
function svDirInfo(facility) {
  if (!state.pos) return null;
  const brg = bearingDeg(state.pos.lat, state.pos.lng, facility.lat, facility.lng);
  const distM = distanceM(state.pos.lat, state.pos.lng, facility.lat, facility.lng);
  return { compass: compassLabel(brg), brg, distM };
}

function renderSvOverlay(facility) {
  const dir = svDirInfo(facility);
  // 「避難先周辺」の伝承を優先（施設座標の近傍）。一定距離内に無ければ表示しない（遠い記録を「近く」と誤認させない）。
  const t = traditionsWithin({ lat: facility.lat, lng: facility.lng }, 1500)[0] ?? null;
  el.svOverlay.innerHTML = streetviewOverlayHtml(facility, dir, t, state.svRoute, svExpanded);
}

// パノラマの現在位置・POVの向きから案内を更新する（道順案内の中核）。
//  - 遠い間: 道路経路(state.svRoute)の道なり look-ahead 方位を指す（道に沿って前進）。
//  - 避難先が近い/経路なし: 避難先“そのもの”への直線方位を指す（到着付近でも手がかりを消さない＝
//    どの建物が避難先かは別途パノラマ上のマーカー/ラベルで固定表示している）。
//  - その方位を POV heading（見ている向き）と比べ「右へ◯° / ✓ 正面」と見ている向き基準で出す。
//  - 中央の矢印は (方位 − POV) だけ回し、ミニマップは経路線＋現パノラマ位置＋視野を描く。
// position_changed / pov_changed で呼ばれる（Googleの矢印で歩く・見回すと発火）。
const SV_NEAR_M = 60; // これより近い／経路が無い時は避難先そのものを指す
const SV_OFFROUTE_M = 40; // 参考経路からこれ以上離れたら「経路から外れ」警告＋戻る案内（30〜50m目安）
function updateSvGuidance() {
  if (state.svMode !== "facility") return; // 道順ガイドは避難所モードのみ（伝承モードでは出さない）
  const f = state.streetviewFacility;
  if (!f) return;
  const panoPos = SV.getPanoramaPosition();
  const pov = SV.getPanoramaHeading();
  if (!panoPos || pov == null) return;
  // ミニマップ（経路線＋現パノラマ位置＋視野の扇形）。経路が無ければ避難施設への直線破線になる。
  drawMiniMap(svMini, panoPos, pov, f, state.svRoute?.geometry ?? null);

  // 避難先そのものへの直線方位・距離（到着付近・経路なしはこれを指す）
  const facBrg = bearingDeg(panoPos.lat, panoPos.lng, f.lat, f.lng);
  const facDist = distanceM(panoPos.lat, panoPos.lng, f.lat, f.lng);
  // 道路経路があれば道なりの look-ahead と「経路からの外れ具合(offRouteM)・戻る方位」を得る。
  const info = routePositionInfo(state.svRoute?.geometry?.coordinates, panoPos, 25);
  const remainingM = info ? info.remainingM : facDist;
  const aimFacility = !info || remainingM < SV_NEAR_M;
  // 経路から大きく外れている（矢印では道なりに進めず迂回した等）＝戻る案内に切替える（避難先付近を除く）。
  const offRoute = Boolean(info) && info.offRouteM > SV_OFFROUTE_M && !aimFacility;
  const cav = Boolean(coordCaveat(f)); // 推定座標なら「おおよその位置」を併記

  let diff, aligned;
  if (offRoute) {
    // 経路へ戻る方向（最近点へ向かう方位）を POV 基準で出す。look-ahead より優先。
    diff = Math.round(((info.returnBearing - pov + 540) % 360) - 180);
    aligned = Math.abs(diff) < 15;
    const turn = aligned ? "✓ この向き" : `${diff > 0 ? "右" : "左"}へ${Math.abs(diff)}°`;
    el.svGuide.innerHTML =
      `⚠ 参考経路から約<b>${formatDist(info.offRouteM)}</b>離れています。2D地図で経路を確認してください（経路へ戻るには<b>${turn}</b>）`;
    el.svGuide.classList.remove("aligned");
    el.svGuide.classList.add("warn");
  } else {
    el.svGuide.classList.remove("warn");
    const brg = aimFacility ? facBrg : info.brg;
    const dist = aimFacility ? facDist : info.distAhead;
    // POV(見ている向き)基準の左右差。Street Viewに端末方位は無いので getPov().heading を基準にする。
    diff = Math.round(((brg - pov + 540) % 360) - 180);
    aligned = Math.abs(diff) < 15;
    const behind = Math.abs(diff) > 150;
    if (aimFacility) {
      // 避難先そのものを指す（到着付近で手がかりが消えない）
      const where = aligned ? "✓ 正面（ピンの建物）"
        : behind ? `うしろ（${diff > 0 ? "右" : "左"}へ${Math.abs(diff)}°）`
          : `${diff > 0 ? "右" : "左"}へ${Math.abs(diff)}°`;
      el.svGuide.innerHTML =
        `🚩 避難先「<b>${escHtml(f.name)}</b>」は${where}・約${Math.round(dist)}m${cav ? "（おおよその位置）" : ""}`;
    } else {
      const turn = aligned ? "✓ この向き" : `${diff > 0 ? "右" : "左"}へ${Math.abs(diff)}°`;
      el.svGuide.innerHTML =
        `🧭 この道を<b>${turn}</b>・約${Math.round(dist)}m　のこり<b>${formatDist(remainingM)}</b>`;
    }
    el.svGuide.classList.toggle("aligned", aligned);
  }

  // 中央の進行方向矢印（POV基準で回転。0°=正面＝この向き）。外れている時は経路へ戻る方向を指す。
  el.svArrow.hidden = false;
  el.svArrow.classList.toggle("aligned", aligned);
  if (el.svArrowInner) el.svArrowInner.style.transform = `rotate(${diff}deg)`;

  // 2D Google Map パネルが開いていれば、現在位置・向き・経路外れの点線を同期更新する。
  if (svMapOpen) updateSvMapPanel();
}

// pov_changed が連発しても1フレーム1回に間引く（カーソルドラッグ中の過剰再描画を防ぐ）。
function scheduleSvGuidance() {
  if (svGuideRaf) return;
  svGuideRaf = requestAnimationFrame(() => { svGuideRaf = 0; updateSvGuidance(); });
}

// ---- Street View 内の 2D Google Map パネル（避難所モードのみ・参考経路の確認）----
// 経路ソース（Google/OSRM/直線）が分かる短いラベル。パネル内に小さく出す。
function svRouteModeLabel() {
  const m = state.svRoute?.mode;
  if (m === "google") return "Google経路・参考";
  if (m === "osrm") return "OSM道路経路・参考";
  return "直線参考";
}

// パネルが開いている間、現在パノラマ位置・向き・経路・経路外れを2D地図へ同期する。
function updateSvMapPanel() {
  if (!svMapOpen || state.svMode !== "facility") return;
  const f = state.streetviewFacility;
  if (!f) return;
  const panoPos = SV.getPanoramaPosition();
  const pov = SV.getPanoramaHeading() ?? 0;
  const coords = state.svRoute?.geometry?.coordinates ?? null;
  const info = coords ? routePositionInfo(coords, panoPos, 25) : null;
  const offRoute = Boolean(info) && info.offRouteM > SV_OFFROUTE_M;
  if (el.svgmRouteMode) el.svgmRouteMode.textContent = svRouteModeLabel(); // 経路取得後にラベルを更新
  SVMap.updateStreetViewMap({
    panoPos, pov, facility: f,
    routeCoords: coords, routeInfo: info,
    travelMode: state.svRoute?.travelMode ?? state.travelMode,
    offRoute,
  });
}

// 2D地図パネルを開く（避難所モードかつ Google Maps ロード済みの時のみ）。
function openSvMap() {
  if (state.svMode !== "facility" || !gmaps) return;
  svMapOpen = true;
  svMapExpanded = false;
  el.svGoogleMapPanel.hidden = false;
  el.svGoogleMapPanel.classList.remove("expanded");
  if (el.svGoogleMapExpand) el.svGoogleMapExpand.textContent = "⤢"; // 小サイズは省スペースのアイコンのみ
  if (el.svgmRouteMode) el.svgmRouteMode.textContent = svRouteModeLabel();
  el.svMapBtn.hidden = true;   // 開いている間は起動ボタンを隠す
  el.svMiniMap.hidden = true;  // 簡易ミニマップは隠し、2D地図に集約（重複表示を避ける）
  const panoPos = SV.getPanoramaPosition();
  const center = panoPos ?? { lat: f0().lat, lng: f0().lng };
  SVMap.initStreetViewMap(gmaps, el.svGoogleMap, { center });
  syncSvMapTypeBtn();   // 前回の地図/空撮の選択を引き継いでボタン表示を合わせる
  updateSvMapPanel();
}
// パネルの中心初期値に使う施設（null安全のための小ヘルパ）
function f0() { return state.streetviewFacility ?? { lat: 34.9, lng: 138.5 }; }

// 2D地図パネルを閉じて Street View へ戻る。
function closeSvMap() {
  svMapOpen = false;
  svMapExpanded = false;
  SVMap.destroyStreetViewMap();
  el.svGoogleMapPanel.hidden = true;
  el.svGoogleMapPanel.classList.remove("expanded");
  if (state.svMode === "facility") { // 避難所モードなら起動ボタン・ミニマップを復帰
    el.svMapBtn.hidden = false;
    el.svMiniMap.hidden = false;
  }
}

// 小⇄拡大の切替。Google Map にサイズ変更を通知して再フィットする。
function toggleSvMapExpand() {
  svMapExpanded = !svMapExpanded;
  el.svGoogleMapPanel.classList.toggle("expanded", svMapExpanded);
  if (el.svGoogleMapExpand) el.svGoogleMapExpand.textContent = svMapExpanded ? "⤡ 縮小" : "⤢";
  SVMap.resizeStreetViewMap();
  updateSvMapPanel();
}

// 地図 ⇄ 空撮(航空写真) トグル。ボタンは「次に切り替わる方」を示す（空撮中は🗺、地図中は🛰）。
function syncSvMapTypeBtn() {
  if (!el.svgmType) return;
  const aerial = SVMap.getStreetViewMapType() === "hybrid";
  el.svgmType.textContent = aerial ? "🗺" : "🛰";
  el.svgmType.title = aerial ? "地図に切替" : "空撮（航空写真）に切替";
}
function toggleSvMapType() {
  const next = SVMap.getStreetViewMapType() === "hybrid" ? "roadmap" : "hybrid";
  SVMap.setStreetViewMapType(next);
  syncSvMapTypeBtn();
}

// パノラマ領域に重ねるメッセージ（読込中スピナー／未設定・未提供・失敗の案内）。
// 文言はすべて固定文字列なのでエスケープ不要。spinner時はボタンを出さない。
function showSvMessage(title, desc, { spinner = false } = {}) {
  // フォールバック導線はモードで切替: facility=避難所の現地目線ビュー(3D)、tradition=伝承の合成3D学習。
  let fallbackBtn = "";
  if (!spinner) {
    if (state.svMode === "tradition" && state.streetviewTradition) {
      fallbackBtn = `<button id="svToLearn" type="button" class="primary">🏙 3D（OSM）で深く学ぶ</button>`;
    } else if (state.streetviewFacility) {
      fallbackBtn = `<button id="svToSim" type="button" class="primary">🧭 現地目線ビュー（OSM）を開く</button>`;
    }
  }
  const buttons = spinner ? "" : `
    <div class="svMsgBtns">
      ${fallbackBtn}
      <button id="svMsgClose" type="button">✕ 閉じる</button>
    </div>`;
  el.svMessage.innerHTML = `
    <div class="svMsgBox">
      ${spinner ? `<div class="svSpinner" aria-hidden="true"></div>` : ""}
      <div class="svMsgTitle">${title}</div>
      ${desc ? `<div class="svMsgDesc">${desc}</div>` : ""}
      ${buttons}
    </div>`;
  el.svMessage.hidden = false;
  el.svMessage.querySelector("#svMsgClose")?.addEventListener("click", closeStreetView);
  el.svMessage.querySelector("#svToSim")?.addEventListener("click", () => {
    const fac = state.streetviewFacility;
    closeStreetView();
    if (fac) { state.arMode = "sim"; switchTab("ar"); startAR(fac); } // 既存のOSM現地目線ビューへフォールバック
  });
  el.svMessage.querySelector("#svToLearn")?.addEventListener("click", () => {
    const tr = state.streetviewTradition;
    closeStreetView();
    if (tr) startLearnAR(tr); // 既存の合成3D学習ビューへフォールバック
  });
}

function hideSvMessage() {
  el.svMessage.hidden = true;
  el.svMessage.innerHTML = "";
}

async function openStreetView(facility) {
  if (!facility || facility.lat == null) return; // 座標の無い施設はStreet View対象外
  state.svMode = "facility";
  state.streetviewTradition = null; // 伝承モードと取り違えない
  state.selected = facility;
  state.streetviewFacility = facility;
  state.svRoute = null;
  svExpanded = false;
  el.streetView.hidden = false;
  el.svPano.innerHTML = "";
  el.svGuide.textContent = "";
  el.svGuide.classList.remove("aligned", "warn");
  el.svArrow.hidden = true;
  el.svMiniMap.hidden = false; // 避難所の道順案内では経路ミニマップを出す（伝承SVで隠した状態から戻す）
  // 2D地図パネルは初期状態（閉じる）。起動ボタンはパノラマ表示後に出す（読込/失敗中は隠す）。
  svMapOpen = false; svMapExpanded = false;
  SVMap.destroyStreetViewMap();
  el.svGoogleMapPanel.hidden = true;
  el.svGoogleMapPanel.classList.remove("expanded");
  el.svMapBtn.hidden = true;
  renderSvOverlay(facility); // 施設名・種別・理由・方向・伝承・注意文は最初から読める

  if (!SV.hasApiKey()) {
    showSvMessage("Google Street View APIキーが未設定です。",
      "OSM/OSRM の現地目線ビュー（カメラ不要）はそのままご利用いただけます。");
    return;
  }
  showSvMessage("Googleストリートビューを読み込み中…", "", { spinner: true });

  let maps;
  try {
    maps = await SV.loadGoogleMaps();
  } catch {
    showSvMessage("Googleストリートビューを読み込めませんでした。",
      "ネットワークまたはAPIキー設定をご確認ください。現地目線ビュー（OSM）をご利用ください。");
    return;
  }
  gmaps = maps; // 2D Google Map パネルでも同じロード結果を再利用する（loaderを増やさない）
  if (state.streetviewFacility !== facility) return; // 読込中に閉じた/別施設へ切替えた

  // パノラマは経路取得を待たずに先に開く（表示を速く）。
  // 開始位置は「現在地側」（避難所へ向かって歩く体験＝設計案A）。現在地が無ければ避難所付近で開く。
  let found = null;
  try {
    const start = state.pos ?? { lat: facility.lat, lng: facility.lng };
    found = await SV.findPanorama(maps, start.lat, start.lng);
    // 現在地周辺にパノラマが無ければ避難所周辺で開く（少なくとも避難先の様子は確認できる）
    if (!found && state.pos) found = await SV.findPanorama(maps, facility.lat, facility.lng);
  } catch {
    found = null;
  }
  if (state.streetviewFacility !== facility) return;
  if (!found) {
    showSvMessage("この地点周辺のGoogleストリートビューが見つかりませんでした。",
      "現地目線ビュー（OSM）なら同じ場所を確認できます。");
    return;
  }
  try {
    const panoPos = { lat: found.location.latLng.lat(), lng: found.location.latLng.lng() };
    // 初期方位は避難施設への直線方位（最初から避難先側を向く）。経路取得後は左右案内を矢印/HUDで補う。
    const heading = bearingDeg(panoPos.lat, panoPos.lng, facility.lat, facility.lng);
    hideSvMessage();
    SV.initPanorama(maps, el.svPano, {
      location: found.location.latLng, pano: found.location.pano, heading,
    });
    // 避難先（目的地）をパノラマ上にマーカー＋名前ラベルで固定表示（「どの建物が避難先か」を直接示す）。
    // 推定座標の施設は「おおよその位置」を併記し、ピンポイントを断定しない（CLAUDE.md）。
    const cav = coordCaveat(facility);
    const typeNote = facility.type ? `（${facility.type}）` : "";
    SV.setFacilityMarker(maps, {
      position: { lat: facility.lat, lng: facility.lng },
      title: `避難先: ${facility.name}${typeNote}${cav ? "・おおよその位置" : ""}`,
      labelHtml:
        `<div style="font:700 12px sans-serif;color:#0d2b45">🚩 避難先: ${escHtml(facility.name)}</div>` +
        `<div style="font:11px sans-serif;color:#41505b">${escHtml(facility.type ?? "")}${cav ? "・おおよその位置（推定）" : ""}</div>`,
    });
    SV.onPanoramaUpdate(scheduleSvGuidance); // Google矢印で前進/見回し→道順ガイド更新
    updateSvGuidance();                      // 経路取得前は施設への直線方位で案内
    el.svMapBtn.hidden = false;              // パノラマ表示成功 → 2D地図の起動ボタンを出す
  } catch {
    showSvMessage("Googleストリートビューの表示中に問題が発生しました。",
      "現地目線ビュー（OSM）をご利用ください。");
    return;
  }

  // 現在地→避難施設の道路経路(OSRM/任意でGoogle)を取得し、道なりの道順ガイドへ更新する。
  // 取得できなくても直線案内のまま動く（キー無し・HTTPローカルでも壊れない）。
  if (state.pos) {
    let route = null;
    try { route = await MapView.fetchRoute(state.pos, facility, state.travelMode, { allowGoogle: true }); }
    catch { route = null; }
    if (state.streetviewFacility !== facility) return; // 取得中に閉じた/別施設へ切替えた
    if (route?.geometry) {
      state.svRoute = {
        mode: route.mode, geometry: route.geometry,
        distM: route.distM ?? null, durS: route.durS ?? null, travelMode: state.travelMode,
      };
      renderSvOverlay(facility); // カードに道順の総距離・所要時間を反映
      updateSvGuidance();        // 道なりの「次にどっちへ」へ切替
    }
  }
}

// ---- Googleストリートビュー（伝承学習モード・案B）----
// 「ARで深く学ぶ」(合成3D=startLearnAR)はそのまま。これは伝承カードの別ボタンから開く追加ビューで、
// 伝承スポットの実写パノラマを背景に解説を読む。避難ナビではないので道順ガイド
// （#svGuide / #svArrow / 経路ミニマップ / 経路取得）は出さない（facilityモードのみ動かす）。
// キー未設定・パノラマ未提供・失敗時は #svMessage で案内し、合成3D学習(startLearnAR)へフォールバックする。
function renderTraditionSvOverlay(t) {
  el.svOverlay.innerHTML = traditionStreetviewOverlayHtml(t, svExpanded);
}

async function openTraditionStreetView(t) {
  if (!t || t.lat == null) return; // 座標の無い伝承はSV対象外（合成3Dも開けない）
  state.svMode = "tradition";
  state.streetviewTradition = t;
  state.streetviewFacility = null;  // facilityモードと取り違えない
  state.svRoute = null;
  svExpanded = false;
  el.streetView.hidden = false;
  el.svPano.innerHTML = "";
  // 道順HUDは伝承モードでは一切出さない（学習であってナビではない）
  el.svGuide.textContent = "";
  el.svGuide.classList.remove("aligned", "warn");
  el.svArrow.hidden = true;
  el.svMiniMap.hidden = true;       // 経路ミニマップも出さない（地点中心の参考も省く）
  // 2D地図（避難経路の参考）は学習モードでは出さない。起動ボタン・パネルを隠して破棄する。
  svMapOpen = false; svMapExpanded = false;
  SVMap.destroyStreetViewMap();
  el.svGoogleMapPanel.hidden = true;
  el.svGoogleMapPanel.classList.remove("expanded");
  el.svMapBtn.hidden = true;
  renderTraditionSvOverlay(t);      // 解説カード（出典・注意文）は最初から開閉して読める

  if (!SV.hasApiKey()) {
    showSvMessage("Google Street View APIキーが未設定です。",
      "「🏙 3D（OSM）で深く学ぶ」では同じ伝承スポットを合成3Dで学べます。");
    return;
  }
  showSvMessage("Googleストリートビューを読み込み中…", "", { spinner: true });

  let maps;
  try {
    maps = await SV.loadGoogleMaps();
  } catch {
    showSvMessage("Googleストリートビューを読み込めませんでした。",
      "ネットワークまたはAPIキー設定をご確認ください。「🏙 3D（OSM）で深く学ぶ」をご利用ください。");
    return;
  }
  if (state.streetviewTradition !== t) return; // 読込中に閉じた/別スポットへ切替えた

  let found = null;
  try {
    found = await SV.findPanorama(maps, t.lat, t.lng); // 伝承スポット付近のパノラマを探す
  } catch {
    found = null;
  }
  if (state.streetviewTradition !== t) return;
  if (!found) {
    showSvMessage("この伝承スポット周辺のGoogleストリートビューが見つかりませんでした。",
      "「🏙 3D（OSM）で深く学ぶ」なら同じ場所を3Dで確認できます。");
    return;
  }
  try {
    const panoPos = { lat: found.location.latLng.lat(), lng: found.location.latLng.lng() };
    // 初期方位は伝承スポット方向（最初からスポット側を向く）
    const heading = bearingDeg(panoPos.lat, panoPos.lng, t.lat, t.lng);
    hideSvMessage();
    SV.initPanorama(maps, el.svPano, {
      location: found.location.latLng, pano: found.location.pano, heading,
    });
    // 伝承の代表地点を「伝承色＝オレンジ」の円マーカー＋ラベルで固定表示（避難所の赤ピンと区別）。
    // 代表点/面・線・推定は coordCaveat で必ず併記し、パノラマ地点＝実地点と断定しない（CLAUDE.md）。
    const cav = coordCaveat(t);
    const sub = cav ? `・${cav}` : "";
    SV.setFacilityMarker(maps, {
      position: { lat: t.lat, lng: t.lng },
      icon: { path: maps.SymbolPath.CIRCLE, scale: 9, fillColor: "#ef6c00", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
      title: `伝承の代表地点（参考）: ${t.title}${sub}`,
      labelHtml:
        `<div style="font:700 12px sans-serif;color:#7a3b00">📜 伝承の代表地点（参考）: ${escHtml(t.title)}</div>` +
        `<div style="font:11px sans-serif;color:#41505b">${escHtml(t.disaster ?? "")}${cav ? `・${escHtml(cav)}` : ""}</div>`,
    });
    // 伝承モードは道順ガイドを購読しない（onPanoramaUpdate/updateSvGuidanceを呼ばない＝HUDなし）。
  } catch {
    showSvMessage("Googleストリートビューの表示中に問題が発生しました。",
      "「🏙 3D（OSM）で深く学ぶ」をご利用ください。");
  }
}

function closeStreetView() {
  if (svGuideRaf) { cancelAnimationFrame(svGuideRaf); svGuideRaf = 0; }
  SV.destroyPanorama();
  // 2D Google Map パネルも破棄（マーカー/ポリライン/リスナを残さない）
  svMapOpen = false; svMapExpanded = false;
  SVMap.destroyStreetViewMap();
  el.svGoogleMapPanel.hidden = true;
  el.svGoogleMapPanel.classList.remove("expanded");
  el.svMapBtn.hidden = true;
  el.streetView.hidden = true;
  el.svOverlay.innerHTML = "";
  el.svGuide.textContent = "";
  el.svGuide.classList.remove("aligned", "warn");
  el.svArrow.hidden = true;
  el.svMiniMap.hidden = false; // 次の避難所SV（道順案内）のために戻す
  hideSvMessage();
  state.streetviewFacility = null;
  state.streetviewTradition = null;
  state.svMode = null;
  state.svRoute = null;
  svExpanded = false;
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
  arMini = initMiniMap(el.arMiniMap);
  svMini = initMiniMap(el.svMiniMap); // Street Viewの経路ミニマップ（現地目線ビューとは別canvas）
  initDemoSelect();
  el.tabs.forEach((b) => b.addEventListener("click", () => { switchTab(b.dataset.tab); expandSheetIfCollapsed(); }));
  el.arExit.addEventListener("click", exitAR);
  el.arFaceBtn.addEventListener("click", () => AR.faceGuide?.());
  el.arResetBtn.addEventListener("click", () => AR.faceNorth?.());
  // ナビカードの折りたたみトグル（カードは200ms毎に再生成されるためデリゲートで配線）
  el.arOverlay.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="toggleNav"]')) {
      navExpanded = !navExpanded;
      // 展開中は読書モード: 移動D-pad・操作列を隠してカードを読みやすくする（終了は残す）
      el.arView.classList.toggle("navExpanded", navExpanded);
      updateArOverlay();
    }
  });
  el.arZoomIn.addEventListener("click", () => AR.zoomBy(1.25));
  el.arZoomOut.addEventListener("click", () => AR.zoomBy(1 / 1.25));
  el.arWalkResetBtn.addEventListener("click", () => AR.resetWalk?.());
  // ストリートビュー: 終了ボタンと下部カードの折りたたみトグル
  el.svExit.addEventListener("click", closeStreetView);
  el.svOverlay.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="toggleSv"]')) {
      svExpanded = !svExpanded;
      // モードに応じて該当オーバーレイだけ再生成（facility と tradition を取り違えない）
      if (state.svMode === "tradition" && state.streetviewTradition) renderTraditionSvOverlay(state.streetviewTradition);
      else if (state.streetviewFacility) renderSvOverlay(state.streetviewFacility);
    }
  });
  // Street View 内の2D Google Map: 開く／拡大・縮小／地図⇄空撮／閉じる
  el.svMapBtn.addEventListener("click", openSvMap);
  el.svGoogleMapExpand.addEventListener("click", toggleSvMapExpand);
  el.svgmType.addEventListener("click", toggleSvMapType);
  el.svGoogleMapClose.addEventListener("click", closeSvMap);
  setupDpad();
  setupSheet();
  el.travelToggle.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => onTravelChange(b.dataset.travel)));
  onDemoChange(); // 初期デモ地点で表示
  switchTab("facilities");
  // 地図のサイズ確定（タブ・パネル配置後）
  setTimeout(() => MapView.invalidate(), 200);
}

init();
