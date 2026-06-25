// Google ストリートビュー（Maps JavaScript API + Street View Panorama）。
// 既存の OSM/OSRM 現地目線ビュー(ar.js)・地図(map.js)は一切置き換えず、選択した避難施設の
// 周辺を確認するための「追加ビュー」としてだけ使う。
//
// 設計方針（CLAUDE.md 準拠）:
//  - API キーはソースに直書きせず Vite の環境変数 import.meta.env.VITE_GOOGLE_MAPS_API_KEY から受ける。
//    （map.js の Google Routes と同じキー。値はコミットしない）
//  - キーが無ければ Google スクリプトを一切ロードせず、呼び出し側へ「未設定」を返す。アプリは壊さない。
//  - Google Maps JS は <script> の動的注入で必要時にのみ読み込む（新規 npm 依存を増やさない）。
//    ※ ES import に try/catch は巻かない方針なので、動的ロードはスクリプト注入で扱う。
//  - Street View 画像は保存・キャッシュしない（ライブのパノラマ widget をそのまま表示する）。
//  - Google のロゴ・帰属表示は widget の既定に従い、消さない。

let loadPromise = null;   // Maps JS API の多重ロードを防ぐ（解決済み Promise を再利用）
let panorama = null;      // 現在表示中の StreetViewPanorama
let panoHost = null;      // パノラマを描画している DOM 要素（破棄時に中身を消す）

function apiKey() {
  return import.meta.env?.VITE_GOOGLE_MAPS_API_KEY || "";
}

// API キーが設定されているか（UI のボタン有効化・事前ガードに使う）。Google は読み込まない。
export function hasApiKey() {
  return Boolean(apiKey());
}

// Maps JavaScript API を動的ロードして window.google.maps を返す。
// 既にロード済み・ロード中ならそれを再利用する。キー未設定時は reject（呼び出し側でメッセージ表示）。
export function loadGoogleMaps() {
  if (window.google?.maps?.StreetViewPanorama) return Promise.resolve(window.google.maps);
  if (loadPromise) return loadPromise;
  const key = apiKey();
  if (!key) return Promise.reject(new Error("NO_API_KEY"));

  loadPromise = new Promise((resolve, reject) => {
    const cbName = "__mihoGmapsReady";
    window[cbName] = () => {
      delete window[cbName];
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error("GOOGLE_MAPS_UNAVAILABLE"));
    };
    const s = document.createElement("script");
    // loading=async + callback は Google 推奨。Street View 関連クラスは既定の maps ライブラリに含まれる。
    s.src = "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${cbName}`;
    s.async = true;
    s.onerror = () => {
      loadPromise = null;        // 失敗したら次回は再試行できるようにする
      delete window[cbName];
      reject(new Error("GOOGLE_MAPS_LOAD_FAILED"));
    };
    document.head.appendChild(s);
  });
  return loadPromise;
}

// 指定座標の近くに公開パノラマがあるか探す。半径を段階的に広げ、見つかった最初の
// パノラマデータ（{ location: { latLng, pano }, ... }）を返す。無ければ null。
// radii: 近い順に試す検索半径(m)。一定距離以内（既定 最大 1000m）で探す。
export async function findPanorama(maps, lat, lng, radii = [50, 120, 300, 600, 1000]) {
  const svc = new maps.StreetViewService();
  for (const radius of radii) {
    const data = await getPanoramaOnce(svc, maps, { lat, lng }, radius);
    if (data) return data;
  }
  return null;
}

// StreetViewService.getPanorama を Promise 化（コールバック版でバージョン差異を避ける）。
function getPanoramaOnce(svc, maps, location, radius) {
  return new Promise((resolve) => {
    svc.getPanorama({ location, radius, preference: maps.StreetViewPreference?.NEAREST }, (data, status) => {
      if (status === maps.StreetViewStatus.OK && data?.location) resolve(data);
      else resolve(null);
    });
  });
}

// パノラマを host 要素に表示する。location は LatLng（findPanorama の data.location.latLng）。
// heading は初期方位（0=北・時計回り。現在地→避難施設の bearing を渡す）。
export function initPanorama(maps, host, { location, pano = null, heading = 0 } = {}) {
  destroyPanorama();
  panoHost = host;
  panorama = new maps.StreetViewPanorama(host, {
    position: location,
    pov: { heading: heading || 0, pitch: 0 },
    zoom: 1,
    addressControl: false,       // 住所オーバーレイは消す（自前オーバーレイで施設名等を出す）
    fullscreenControl: false,    // 既に全画面表示なので不要
    motionTracking: false,
    motionTrackingControl: false,
    showRoadLabels: true,        // 道路名は Google 由来の文脈情報として残す
    linksControl: true,          // 矢印で道沿いに移動できる
    panControl: true,
    zoomControl: true,
    // ※ Google のロゴ・著作権表記は widget が自動表示する。消さない（利用規約・帰属表示の維持）。
  });
  if (pano) panorama.setPano(pano);   // 検索で得た特定パノラマを確実に表示
  return panorama;
}

// パノラマを破棄して DOM をクリーンにする（戻る/終了時）。Google に明示的な destroy は無いので、
// 参照を切り、host の中身（widget が生成した DOM）を空にして GC に委ねる。
export function destroyPanorama() {
  if (panorama) {
    try { panorama.setVisible(false); } catch { /* 生成途中など */ }
  }
  panorama = null;
  if (panoHost) panoHost.innerHTML = "";
  panoHost = null;
}

export function isOpen() {
  return panorama != null;
}
