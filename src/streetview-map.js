// Google Street View 画面内に重ねる「2D Google Map（避難経路の参考表示）」。
// 既存の OSM/OSRM 現地目線ビュー・Leaflet 地図は置き換えず、Street View を補助する追加パネル。
//
// 今回の指摘対応:
//  - ストリートビュー上の矢印だけでは経路通りに進めない場面があるため、2D地図で「今どこか」
//    「経路はどちらか」「外れている時はどちらへ戻るか」を確認できるようにする。
//
// 設計方針（CLAUDE.md 準拠）:
//  - 2D地図は Leaflet/OSM ではなく Google Maps JavaScript API の google.maps.Map を使う。
//  - Google Maps JS は streetview.js の loadGoogleMaps() のロード結果(maps)を再利用し、loader を増やさない。
//  - API キーは直書きしない（loadGoogleMaps 側で import.meta.env.VITE_GOOGLE_MAPS_API_KEY を参照）。
//  - Google のロゴ・著作権・地図データ帰属は google.maps.Map の既定表示に従い消さない。
//  - 経路は「参考表示」。安全/正式な避難経路とは断定しない（文言は呼び出し側 UI で明示）。
//  - マーカー/ポリラインはビュー破棄・別施設切替で確実に解放（リーク・二重表示・古い参照を残さない）。

let mapsRef = null;       // google.maps（init時に受け取り、update/resizeで再利用）
let gmap = null;          // google.maps.Map
let mapHost = null;
let panoMarker = null;    // 現在表示中の Street View パノラマ位置（視線方向つき矢印）
let facilityMarker = null;// 避難施設
let routeLine = null;     // 参考経路ポリライン（Google/OSRM）または直線参考の破線
let offRouteLine = null;  // 経路から外れている時: 現在位置→経路最近点の点線
let nearestMarker = null; // 経路上の最近点（戻る目印）
let lastRouteCoords = null;// 直前に描いた経路 coords（同じなら作り直さない＝POV連発でのちらつき/GC回避）
let fitted = false;       // 初回・拡大時だけ全体にフィット（毎フレーム再フィットしてズームが暴れるのを防ぐ）

// 経路色は map.js と合わせる（徒歩=青/車=赤）。既存の地図表示に近い色にする。
const ROUTE_COLOR = { foot: "#0d47a1", car: "#c62828" };

export function isStreetViewMapOpen() { return gmap != null; }

// 2D Google Map を host に作る。maps は loadGoogleMaps() の戻り値（window.google.maps）。
export function initStreetViewMap(maps, host, { center, zoom = 16 } = {}) {
  destroyStreetViewMap();
  mapsRef = maps;
  mapHost = host;
  fitted = false;
  gmap = new maps.Map(host, {
    center: center || { lat: 34.9, lng: 138.5 },
    zoom,
    // ズーム等の標準UI・Google のロゴ・著作権/帰属は残す（消さない）。
    mapTypeControl: false,     // 地図/航空の切替はパネルが小さいので省く
    streetViewControl: false,  // ここは2D地図。Pegman は出さない（混乱回避）
    fullscreenControl: false,  // パネル自前の「拡大」を使う
    clickableIcons: false,     // 周辺POIの誤タップを防ぐ
    gestureHandling: "greedy", // 1本指パン・ピンチズーム（パネル内で操作しやすく）
    keyboardShortcuts: false,
  });
  return gmap;
}

// パノラマ位置・向き・施設・経路に合わせて地図を更新する。
//   panoPos:    {lat,lng}            現在の Street View パノラマ位置
//   pov:        number               見ている向き(0=北・時計回り)。矢印の回転に使う
//   facility:   {lat,lng,name}       避難施設
//   routeCoords:[[lng,lat],...]|null 参考経路（GeoJSON LineString の coords）。無ければ直線参考
//   routeInfo:  routePositionInfo()の戻り | null（nearestLatLng/offRouteM 等）
//   travelMode: "foot"|"car"         経路色
//   offRoute:   boolean              経路から外れている（点線・最近点を出すか）
export function updateStreetViewMap({ panoPos, pov = 0, facility, routeCoords, routeInfo, travelMode = "foot", offRoute = false } = {}) {
  const maps = mapsRef;
  if (!gmap || !maps) return;
  const color = ROUTE_COLOR[travelMode] ?? ROUTE_COLOR.foot;

  // 参考経路ポリライン（取得済みなら実線、無ければ現在位置→施設の直線参考を破線で）。
  if (Array.isArray(routeCoords) && routeCoords.length >= 2) {
    // 経路 coords が前回と同じなら作り直さない（POV連発でのちらつき・GC churn を避ける）
    if (!routeLine || routeCoords !== lastRouteCoords) {
      if (routeLine) routeLine.setMap(null);
      routeLine = new maps.Polyline({
        path: routeCoords.map(([lng, lat]) => ({ lat, lng })),
        strokeColor: color, strokeOpacity: 0.85, strokeWeight: 5, map: gmap, zIndex: 10,
      });
      lastRouteCoords = routeCoords;
    }
  } else {
    // 経路なし＝直線参考（破線）。始点が現在パノラマ位置なので位置が動いたら引き直す。
    if (routeLine) { routeLine.setMap(null); routeLine = null; }
    lastRouteCoords = null;
    if (facility && panoPos) {
      routeLine = new maps.Polyline({
        path: [{ lat: panoPos.lat, lng: panoPos.lng }, { lat: facility.lat, lng: facility.lng }],
        strokeOpacity: 0, map: gmap, zIndex: 10, // 破線（icons）＝「直線参考」
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: "#666", scale: 3 }, offset: "0", repeat: "12px" }],
      });
    }
  }

  // 避難施設マーカー（赤）。別色・別ラベルでパノラマ位置と区別する。
  if (facility) {
    const fpos = { lat: facility.lat, lng: facility.lng };
    if (!facilityMarker) {
      facilityMarker = new maps.Marker({
        position: fpos, map: gmap, title: `避難施設: ${facility.name ?? ""}`,
        icon: { path: maps.SymbolPath.CIRCLE, scale: 8, fillColor: "#d32f2f", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
        zIndex: 30,
      });
    } else {
      facilityMarker.setPosition(fpos);
    }
  }

  // 現在のパノラマ位置（青・視線方向つき矢印）。通常の「現在地」ではなく
  // 「現在表示中の Street View パノラマ位置」であることを title で示す。
  if (panoPos) {
    const ppos = { lat: panoPos.lat, lng: panoPos.lng };
    const icon = {
      path: maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 5.5, rotation: pov || 0,
      fillColor: "#1a73e8", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 1.5,
    };
    if (!panoMarker) {
      panoMarker = new maps.Marker({
        position: ppos, map: gmap, icon, zIndex: 40,
        title: "ストリートビュー現在位置（矢印＝見ている向き）",
      });
    } else {
      panoMarker.setPosition(ppos);
      panoMarker.setIcon(icon);
    }
  }

  // 経路から外れている時: 現在位置→経路最近点の点線＋最近点マーカー（戻る目印）
  if (offRouteLine) { offRouteLine.setMap(null); offRouteLine = null; }
  if (nearestMarker) { nearestMarker.setMap(null); nearestMarker = null; }
  if (offRoute && panoPos && routeInfo?.nearestLatLng) {
    const near = routeInfo.nearestLatLng;
    offRouteLine = new maps.Polyline({
      path: [{ lat: panoPos.lat, lng: panoPos.lng }, { lat: near.lat, lng: near.lng }],
      strokeOpacity: 0, map: gmap, zIndex: 20,
      icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: "#e65100", scale: 3 }, offset: "0", repeat: "10px" }],
    });
    nearestMarker = new maps.Marker({
      position: { lat: near.lat, lng: near.lng }, map: gmap, zIndex: 25,
      title: "参考経路へ戻る目印（経路上の最近点）",
      icon: { path: maps.SymbolPath.CIRCLE, scale: 5, fillColor: "#e65100", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 1.5 },
    });
  }

  // 初回・拡大直後のみ全体（現在位置・施設・経路）にフィット。以降は地図を動かさず、
  // ユーザーが自由にパン/ズームできるようにする（マーカーが動いても勝手に中心へ戻さない）。
  if (!fitted) {
    const bounds = new maps.LatLngBounds();
    if (panoPos) bounds.extend({ lat: panoPos.lat, lng: panoPos.lng });
    if (facility) bounds.extend({ lat: facility.lat, lng: facility.lng });
    if (Array.isArray(routeCoords)) routeCoords.forEach(([lng, lat]) => bounds.extend({ lat, lng }));
    if (!bounds.isEmpty()) { gmap.fitBounds(bounds, 36); fitted = true; }
  }
}

// パネルのサイズが変わった（小⇄拡大）時に呼ぶ。Google Map は表示サイズ変更を自動検知しないので
// resize を通知し、次の update で全体に再フィットさせる。
export function resizeStreetViewMap() {
  if (!gmap || !mapsRef) return;
  mapsRef.event.trigger(gmap, "resize");
  fitted = false;
}

// 地図とそのオーバーレイを破棄（ビュー終了・別施設切替・パネルを閉じた時）。
export function destroyStreetViewMap() {
  for (const o of [panoMarker, facilityMarker, nearestMarker]) {
    try { o?.setMap(null); } catch { /* 生成途中など */ }
  }
  for (const l of [routeLine, offRouteLine]) {
    try { l?.setMap(null); } catch { /* 生成途中など */ }
  }
  panoMarker = facilityMarker = nearestMarker = routeLine = offRouteLine = null;
  lastRouteCoords = null;
  if (gmap && window.google?.maps) {
    try { window.google.maps.event.clearInstanceListeners(gmap); } catch { /* 生成途中など */ }
  }
  gmap = null;
  if (mapHost) mapHost.innerHTML = "";
  mapHost = null;
  mapsRef = null;
  fitted = false;
}
