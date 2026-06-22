// 下部パネル（4タブ: 避難施設 / 伝承・史料 / AR案内 / 注意事項）のカードUI
import {
  sources, traditions, categoryOf, CATEGORY_LABELS, hasPos,
  nearestTsunamiFacilities, nearestShelters, nearestTradition,
  unresolvedRecords, intensityLabel, coordCaveat,
} from "./data.js";
import { formatDist, bearingDeg, distanceM, compassLabel, travelTimeMin, formatDuration, TRAVEL_LABEL } from "./geo.js";

const NOTICE =
  "このシステムは平時の防災学習・避難訓練支援を目的とした試作です。実際の災害時は自治体・気象庁・消防・警察等の公式情報に従って避難してください。";
const TRADITION_NOTE =
  "伝承・史料は避難判断の決定根拠ではなく、公的な津波避難施設情報と組み合わせて理解するための補助情報です。伝承だけで特定の場所・経路の安全/危険を断定しません。";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function badge(r) {
  const cat = categoryOf(r);
  return `<span class="badge ${cat}">${esc(CATEGORY_LABELS[cat])}</span>`;
}

function srcHtml(r) {
  return `<div class="src">出典: <a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.source_title)}</a></div>`;
}

// ---------------- 避難施設タブ ----------------
export function renderFacilitiesTab(el, pos, handlers, travelMode = "foot", presortedNear = null) {
  if (!pos) {
    el.innerHTML = `<div class="card">現在地が未取得です。上の「現在地」からGPSまたはデモ地点を選んでください。</div>`;
    return [];
  }
  // 並び順: 既定は直線距離。道路距離が取得できていれば main.js が presortedNear（道路距離順）を渡す。
  const byRoad = Array.isArray(presortedNear) && presortedNear.length > 0;
  const near = byRoad ? presortedNear : nearestTsunamiFacilities(pos, 3);
  const shelters = nearestShelters(pos, 2);
  const tLabel = TRAVEL_LABEL[travelMode];
  const cards = near.map((f, i) => {
    const h = f.evacuation_height_m != null
      ? `避難可能高さ <b>${esc(f.evacuation_height_m)}m</b> ／ ` : "";
    // 道路距離(_roadDistM)があれば道路距離・OSRM所要時間、無ければ直線距離・概算所要時間で表示。
    const useRoad = f._roadDistM != null;
    const shownDist = useRoad ? f._roadDistM : f._dist;
    const tmin = useRoad && f._roadDurS != null
      ? Math.max(1, Math.round(f._roadDurS / 60))
      : travelTimeMin(f._dist, travelMode);
    const distKind = useRoad ? "道路距離" : "直線距離";
    const cv = coordCaveat(f);
    const cvNote = cv ? `<div class="meta">📍 ${esc(cv)}</div>` : "";
    return `<div class="card">
      <h3><span class="rankNo">${i + 1}</span>${badge(f)}${esc(f.name)}</h3>
      <div class="meta">現在地から ${esc(distKind)} <span class="dist">${formatDist(shownDist)}</span>
        ・${esc(tLabel)} <span class="dist">${esc(formatDuration(tmin))}</span>
        （${esc(compassLabel(bearingDeg(pos.lat, pos.lng, f.lat, f.lng)))}方向）｜${esc(f.district)}地区</div>
      <div class="meta">${h}${esc(f.evacuation_place ?? "")}</div>
      ${cvNote}
      <div class="why">なぜここへ: ${esc(f.why)}</div>
      ${srcHtml(f)}
      <div class="btnRow">
        <button data-act="map" data-id="${esc(f.id)}">地図で経路</button>
        <button data-act="ar" data-id="${esc(f.id)}" class="primary">現地目線で案内</button>
      </div>
    </div>`;
  }).join("");

  const orderNote = byRoad
    ? `候補は<b>道路距離（${esc(tLabel)}の参考経路）</b>順です。参考表示であり、徒歩最短ルートを保証するものではありません。`
    : `候補は<b>直線距離</b>順です（道路距離は経路取得後に反映されます）。`;

  const shelterCards = shelters.map((f) => `
    <div class="card">
      <h3>${badge(f)}${esc(f.name)}</h3>
      <div class="meta">現在地から <span class="dist">${formatDist(f._dist)}</span>｜${esc(f.evacuation_place ?? "")}</div>
      <div class="meta">${esc(f.why)}</div>
      ${srcHtml(f)}
    </div>`).join("");

  el.innerHTML = `
    <div class="noteSmall">現在地から近い<b>津波からの一時避難先</b>（津波緊急避難場所・津波避難ビル優先）上位3件。${orderNote}</div>
    ${cards || `<div class="card">座標が確定している施設が近くにありません（data_quality.md参照）。</div>`}
    <div class="sectionTitle">参考: 指定避難所（津波の一時避難先とは区別）</div>
    <div class="noteSmall">指定避難所は被災後に滞在する施設です。津波警報中はまず上の一時避難先へ。</div>
    ${shelterCards}`;
  bindActs(el, handlers);
  // カード番号(rankNo 1..n)と地図マーカー番号を同期するため、表示順の配列を返す。
  // 番号を付けるのは上位の津波一時避難先(near)のみ＝カードに番号が付くものと一致。
  return near;
}

// ---------------- 伝承・史料タブ ----------------
export function renderTraditionsTab(el, pos, handlers) {
  const sorted = pos
    ? traditions.filter(hasPos)
        .map((t) => ({ ...t, _dist: distanceM(pos.lat, pos.lng, t.lat, t.lng) }))
        .sort((a, b) => a._dist - b._dist)
    : traditions.filter(hasPos);
  const noPos = traditions.filter((t) => !hasPos(t));
  const nearestId = pos && sorted.length ? sorted[0].id : null;

  const card = (t, no, highlight) => {
    const dist = t._dist != null
      ? `<span class="dist">${formatDist(t._dist)}</span>（${esc(compassLabel(bearingDeg(pos.lat, pos.lng, t.lat, t.lng)))}方向）` : "";
    const ht = t.recorded_height_m != null
      ? `<div class="meta">記録上の津波高: <b>約${esc(t.recorded_height_m)}m</b></div>` : "";
    const intenStr = intensityLabel(t);
    const inten = intenStr
      ? `<div class="meta">推定震度: <b>${esc(intenStr)}</b>（寺院被害記録による）</div>` : "";
    return `<div class="card" ${highlight ? 'style="border:2px solid #ef6c00"' : ""}>
      <h3>${no != null ? `<span class="rankNo">${no}</span>` : ""}${badge(t)}${esc(t.title)}${highlight ? " <small>← いちばん近い</small>" : ""}</h3>
      <div class="meta">関連災害: ${esc(t.disaster)}　${dist}</div>
      ${(() => { const cv = coordCaveat(t); return cv ? `<div class="meta">📍 ${esc(cv)}</div>` : ""; })()}
      ${ht}${inten}
      <div style="margin-top:4px">${esc(t.summary)}</div>
      <div class="why" style="border-left-color:#ef6c00;background:#fff7ef">避難行動への意味づけ: ${esc(t.evacuation_message)}</div>
      <div class="caution">${esc(t.caution)}</div>
      ${srcHtml(t)}
      ${hasPos(t) ? `<div class="btnRow">
        <button data-act="mapt" data-lat="${t.lat}" data-lng="${t.lng}">地図で見る</button>
        <button data-act="learn" data-id="${esc(t.id)}" class="primary">🧭 ARで深く学ぶ</button>
      </div>` : ""}
    </div>`;
  };

  el.innerHTML = `
    <div class="noteSmall">${esc(TRADITION_NOTE)}</div>
    ${sorted.map((t, i) => card(t, i + 1, t.id === nearestId)).join("")}
    ${noPos.length ? `<div class="sectionTitle">位置未取得の資料（READMEの未取得一覧参照）</div>` : ""}
    ${noPos.map((t) => card(t, null, false)).join("")}`;
  bindActs(el, handlers);
  // 表示順(=地図マーカーの番号)を共有するため、座標ありの表示リストを返す。
  // 位置未取得(noPos)はマーカーが無いので番号を振らない＝返さない。
  return sorted;
}

// ---------------- AR案内タブ ----------------
export function renderArTab(el, pos, state, handlers) {
  if (!pos) {
    el.innerHTML = `<div class="card">現在地が未取得です。「現在地」から地図クリック・GPS・デモ地点のいずれかで指定してください。</div>`;
    return;
  }
  const f = state.selected ?? nearestTsunamiFacilities(pos, 1)[0];
  if (!f) {
    el.innerHTML = `<div class="card">案内できる避難施設がありません。</div>`;
    return;
  }
  const dist = distanceM(pos.lat, pos.lng, f.lat, f.lng);
  const brg = bearingDeg(pos.lat, pos.lng, f.lat, f.lng);
  const tmin = travelTimeMin(dist, state.travelMode ?? "foot");
  const tLabel = TRAVEL_LABEL[state.travelMode ?? "foot"];
  const t = nearestTradition(pos);

  const compass = `
    <svg viewBox="0 0 100 100" width="92" height="92" role="img" aria-label="方向">
      <circle cx="50" cy="50" r="46" fill="#fff" stroke="#90a0ac"/>
      <text x="50" y="14" text-anchor="middle" font-size="11" fill="#d32f2f" font-weight="bold">N</text>
      <text x="50" y="95" text-anchor="middle" font-size="10" fill="#666">S</text>
      <text x="7" y="54" font-size="10" fill="#666">W</text>
      <text x="88" y="54" font-size="10" fill="#666">E</text>
      <g transform="rotate(${brg.toFixed(0)} 50 50)">
        <polygon points="50,16 58,52 50,44 42,52" fill="#0d2b45"/>
        <line x1="50" y1="50" x2="50" y2="74" stroke="#0d2b45" stroke-width="3"/>
      </g>
    </svg>`;

  const heightLine = f.evacuation_height_m != null
    ? `避難可能高さ ${esc(f.evacuation_height_m)}m ／ ${esc(f.evacuation_place)}`
    : `避難可能場所: ${esc(f.evacuation_place)}`;

  const arMode = state.arMode ?? "sim";
  const modeToggle = `
    <div class="modeToggle">
      <button data-mode="sim" class="${arMode === "sim" ? "on" : ""}" type="button">🧭 現地目線ビュー（おすすめ）</button>
      <button data-mode="live" class="${arMode === "live" ? "on" : ""}" type="button">📷 ARカメラ（現地・上級）</button>
    </div>`;
  const startLabel = arMode === "sim"
    ? "🧭 現地目線ビューを開く"
    : "📷 ARカメラを開始（カメラ・方位センサー許可が必要）";
  const modeNote = arMode === "sim"
    ? "現地目線ビュー: その場に立った目線の3D表示。カメラも方位センサーも不要で、<b>HTTPのローカル表示でも動きます</b>。<b>実際の町並み（建物・道路・松原・海岸線）と、建物・道路・公園の名前をOpenStreetMapから立体表示</b>し、避難施設を色つきの建物、伝承を看板柱として実寸配置。目的地までの道筋・距離リング・東西南北を地面に描きます。<b>操作はGoogleストリートビュー風: ドラッグで見回し（離すと余韻）、行きたい場所をタップ/クリックで進めます。</b>矢印キー/WASD（画面の◀▶▲▼）でも歩け、距離・方向・ミニマップが連動します。（建物の形・高さ・名前はOSMによる概形/抜粋）"
    : "ARカメラ（上級）: スマホ実機のカメラ映像の上に矢印・伝承・記録高ゲージを実方位で重ねます。<b>HTTPS＋カメラ・方位センサーの許可が必要</b>（屋外推奨）。センサーが使えない場合は自動で現地目線ビュー相当の操作になります。";

  el.innerHTML = `
    <div class="card">
      <h3>${badge(f)}${esc(f.name)}</h3>
      <div class="compassWrap">
        ${compass}
        <div class="compassInfo">
          <div>→ <b>${esc(compassLabel(brg))}</b> 方向（北から${brg.toFixed(0)}°）へ
            <span class="dist">${formatDist(dist)}</span></div>
          <div class="meta">${esc(tLabel)}で <span class="dist">${esc(formatDuration(tmin))}</span>（直線距離からの目安）</div>
          <div class="meta">種別: ${esc(f.type)}（${esc(f.subtype)}）</div>
          <div class="meta">${heightLine}</div>
        </div>
      </div>
      <div class="why">理由: ${esc(f.why)}</div>
      ${modeToggle}
      <div class="noteSmall">${modeNote}</div>
      <button id="btnStartAR" class="bigStart">${startLabel}</button>
      <div class="btnRow"><button data-act="map" data-id="${esc(f.id)}">地図で経路を見る</button></div>
    </div>
    ${t ? `<div class="card">
      <h3>${badge(t)}近くの伝承・史料: ${esc(t.title)}</h3>
      <div class="meta">約 ${formatDist(t._dist)}｜${esc(t.disaster)}</div>
      <div style="margin-top:3px">${esc(t.evacuation_message)}</div>
      <div class="caution">この周辺には${esc(t.disaster)}に関する記録があります。${esc(TRADITION_NOTE)}</div>
      ${srcHtml(t)}
    </div>` : ""}`;
  bindActs(el, handlers);
  el.querySelector("#btnStartAR")?.addEventListener("click", () => handlers.onStartAR(f));
  el.querySelectorAll(".modeToggle button").forEach((b) =>
    b.addEventListener("click", () => handlers.onSetArMode(b.dataset.mode)));
}

// ---------------- 注意事項タブ ----------------
export function renderAboutTab(el) {
  const un = unresolvedRecords();
  const srcList = sources.map((s) =>
    `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
      <span style="color:#777">（${esc(s.publisher)}・${esc(s.accessed)}閲覧）</span></li>`).join("");
  const unList = [...un.facilities, ...un.traditions].map((r) =>
    `<li>${esc(r.name ?? r.title)} — 位置未取得（${esc(r.geocode_note ?? "ジオコーディング不可")}）</li>`).join("");
  el.innerHTML = `
    <div class="card" style="border:2px solid var(--c-warn-bd)">
      <h3>⚠ 必ずお読みください</h3>
      <div>${esc(NOTICE)}</div>
    </div>
    <div class="card">
      <h3>本システムの位置づけ（研究上の新規性）</h3>
      <div>本システムは、単に現在地から避難先への経路やAR矢印を表示するだけでなく、静岡市清水区三保〜清水港周辺に残る災害伝承・史料情報を、現在の津波避難施設情報と結びつけて提示します。これにより、利用者が「どこへ逃げるか」だけでなく、<b>「なぜその方向へ避難するのか」</b>を理解できる防災学習支援を目指しています。</div>
      <div class="caution">${esc(TRADITION_NOTE)}</div>
    </div>
    <div class="card">
      <h3>使用資料一覧（出典）</h3>
      <ul style="margin:4px 0 0 16px;padding:0">${srcList}</ul>
    </div>
    <div class="card">
      <h3>データの限界・位置未取得の項目</h3>
      <div class="noteSmall">緯度経度が公的資料・論文から確定できなかった項目は地図・ARに表示されません（詳細は data_quality.md / README）。</div>
      <ul style="margin:4px 0 0 16px;padding:0;font-size:11px">${unList || "<li>なし</li>"}</ul>
    </div>
    <div class="card">
      <div class="noteSmall">地図・現地目線ビューの町並み3D: © OpenStreetMap contributors（ODbL・Overpass API経由。
      建物の形と高さはタグからの推定を含む概形）／ 経路: OSRM（参考表示）／
      避難施設・伝承データの出典は各カードに記載。本試作は研究・学習目的であり、最新の指定状況は必ず静岡市の公式情報で確認してください。</div>
    </div>`;
}

function bindActs(el, handlers) {
  el.querySelectorAll("button[data-act]").forEach((b) => {
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "map") handlers.onShowRoute(b.dataset.id);
      if (act === "ar") handlers.onSelectAr(b.dataset.id);
      if (act === "mapt") handlers.onPanTo(+b.dataset.lat, +b.dataset.lng);
      if (act === "learn") handlers.onLearnTradition(b.dataset.id);
    });
  });
}

// AR画面の下部オーバーレイ（折りたたみ式ナビカード）。
// nav: { mode:"osrm"|"straight"|"none", distM, durS, remainingM, nextText, aligned }
export function arOverlayHtml(f, nav, t, travelMode = "foot", expanded = false) {
  const heightLine = f.evacuation_height_m != null
    ? `避難可能高さ ${esc(f.evacuation_height_m)}m ／ ${esc(f.evacuation_place)}`
    : `避難可能場所: ${esc(f.evacuation_place)}`;
  const hasRoad = nav.mode === "osrm" || nav.mode === "google";
  const tLabel = TRAVEL_LABEL[travelMode];
  const min = nav.durS != null ? Math.max(1, Math.round(nav.durS / 60)) : travelTimeMin(nav.distM, travelMode);
  const totalStr = nav.distM != null ? formatDist(nav.distM) : "-";
  const remainStr = nav.remainingM != null ? formatDist(nav.remainingM) : totalStr;
  const via = nav.mode === "google" ? "Google経路・参考"
    : hasRoad ? "OSM道路経路・参考" : "直線参考（道路経路なし）";
  // 折りたたみ時に常時見える1行サマリ（次アクション＋残り）
  const head = `→ ${esc(f.name)}　のこり<b>${remainStr}</b>${nav.nextText ? `　${esc(nav.nextText)}` : ""}`;
  const body = `
    <div class="navRow">距離 <b>${totalStr}</b>・${esc(tLabel)}<b> ${esc(formatDuration(min))}</b>
      <span class="navVia">（${via}）</span></div>
    <div class="navRow">種別: ${esc(f.type)}｜${heightLine}</div>
    <div class="why">理由: ${esc(f.why)}</div>
    ${t ? `<div class="caution">📜 近くの伝承: ${esc(t.title)}（約${formatDist(t._dist)}）— 補助情報です。</div>` : ""}
    <div class="navSrc">経路は ${nav.mode === "google" ? "Google Routes" : "OpenStreetMap / OSRM"} 由来の<b>参考表示</b>です（${esc(tLabel)}）。
      徒歩避難の正式経路ではありません。実際の避難は公式情報に従ってください。</div>`;
  return `<div class="arNavCard${expanded ? " expanded" : ""}">
    <button class="arNavToggle" type="button" data-act="toggleNav">
      <span class="navHead">${head}</span><span class="navChev">${expanded ? "▾" : "▸"}</span>
    </button>
    <div class="arNavBody">${body}</div>
  </div>`;
}

// 伝承学習ビューの下部オーバーレイ（当時の状況・教訓・出典をじっくり読む）
export function learnOverlayHtml(t) {
  const ht = t.recorded_height_m != null
    ? `<span class="chip">🌊 記録 約${esc(t.recorded_height_m)}m</span>` : "";
  const intenStr = intensityLabel(t);
  const inten = intenStr
    ? `<span class="chip">推定震度 ${esc(intenStr)}</span>` : "";
  const cv = coordCaveat(t);
  const cvBanner = cv ? `<div class="caution">📍 ${esc(cv)}</div>` : "";
  return `<div class="arLearnCard">
    <h3>📜 ${esc(t.title)}</h3>
    <div class="learnChips">${esc(t.disaster)}${ht}${inten}</div>
    ${cvBanner}
    <div class="learnBody">${esc(t.summary)}</div>
    <div class="why" style="border-left-color:#ef6c00;background:#fff7ef">🧭 避難への意味づけ: ${esc(t.evacuation_message)}</div>
    <div class="caution">${esc(t.caution)}</div>
    ${srcHtml(t)}
  </div>`;
}
