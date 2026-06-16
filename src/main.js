// アプリ全体の制御: タブ切替・現在地(GPS/デモ)・地図・AR起動
import "./style.css";
import { demoLocations, facilityById, traditionById, nearestTradition, nearestTsunamiFacilities } from "./data.js";
import * as MapView from "./map.js";
import * as AR from "./ar.js";
import { initMiniMap, drawMiniMap } from "./minimap.js";
import {
  renderFacilitiesTab, renderTraditionsTab, renderArTab, renderAboutTab,
  arOverlayHtml, learnOverlayHtml,
} from "./ui.js";
import { distanceM, bearingDeg, destPoint, compassLabel, travelTimeMin, formatDuration, formatDist, TRAVEL_LABEL } from "./geo.js";

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
};
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
};

const handlers = {
  onShowRoute: (id) => showRouteFor(id),
  onSelectAr: (id) => { state.selected = facilityById(id); switchTab("ar"); },
  onPanTo: (lat, lng) => MapView.focusLatLng(lat, lng),
  onStartAR: (f) => startAR(f),
  onSetArMode: (m) => { state.arMode = m; if (state.tab === "ar") renderActiveTab(); },
  onLearnTradition: (id) => startLearnAR(traditionById(id)),
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
    : r && r.mode === "osrm" ? "（参考経路・道路距離。徒歩最短ではありません）" : "";
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
    try { r = await MapView.fetchRoute(state.pos, facility, state.travelMode); } catch { /* 直線参考へ */ }
  }
  state.arRoute = r;
  state.routeGeometry = r.geometry ?? null;
  state.routedFacilityId = r.mode === "osrm" ? facility.id : null;
  try {
    // デモ現在地は fakeGps（屋内・発表・検証用）、GPSモードは実機GPS
    const fakePos = state.usingDemo ? state.pos : null;
    // 道路経路が取れた時だけ青ルートを渡す（取れなければ AR 側で灰破線の直線参考）
    await AR.startAR(el.arHolder, {
      fakePos, facility, mode: state.arMode,
      routeGeometry: r.mode === "osrm" ? r.geometry : null,
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
    drawMiniMap(pos, h, learning ? null : f, learning ? null : state.arRoute?.geometry);
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
