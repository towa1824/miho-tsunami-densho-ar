// AR/Street View 画面のミニマップ（Canvas・自分中心・北上固定）。
// 施設(種別色)・伝承(橙/発見済みは金の星)・目的地(赤)・道筋(青破線)・視野の扇形を描く。
// タップでサイズ切替。Street View のミニマップに相当する現在地の手がかり。
// 現地目線ビューとStreet Viewは別々のcanvasに同時には開かないが、それぞれ独立したインスタンスを
// 持てるよう initMiniMap はインスタンスを返す（モジュール共有の状態に依存しない）。
import {
  facilities, traditions, hasPos, categoryOf, CATEGORY_COLORS,
} from "./data.js";
import { toEastNorth, distanceM } from "./geo.js";

// canvas要素ごとに独立したミニマップ。返り値を drawMiniMap の第1引数へ渡す。
export function initMiniMap(el) {
  const inst = { canvas: el, ctx: el.getContext("2d"), size: 132, expanded: false };
  applySize(inst);
  el.addEventListener("click", () => { inst.expanded = !inst.expanded; applySize(inst); });
  return inst;
}

function applySize(inst) {
  inst.size = inst.expanded ? 248 : 132;
  inst.canvas.width = inst.size * 2;   // Retina
  inst.canvas.height = inst.size * 2;
  inst.canvas.style.width = `${inst.size}px`;
  inst.canvas.style.height = `${inst.size}px`;
  inst.ctx.setTransform(2, 0, 0, 2, 0, 0);
}

export function drawMiniMap(inst, pos, headingDeg, target, routeGeometry, discoveredSet) {
  if (!inst || !inst.ctx || !pos) return;
  const ctx = inst.ctx, size = inst.size;
  const R = size / 2;
  // 表示範囲: 目的地が収まるよう自動調整
  let range = 300;
  if (target && target.lat != null) {
    const d = distanceM(pos.lat, pos.lng, target.lat, target.lng);
    range = Math.min(900, Math.max(160, d * 1.25));
  }
  const sc = (R - 12) / range;
  const toXY = (lat, lng) => {
    const { east, north } = toEastNorth(lat, lng, pos.lat, pos.lng);
    return [R + east * sc, R - north * sc];
  };
  const inside = (x, y, m = 6) => (x - R) ** 2 + (y - R) ** 2 <= (R - m) ** 2;

  ctx.clearRect(0, 0, size, size);
  // 背景円
  ctx.beginPath(); ctx.arc(R, R, R - 2, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(11,28,43,.82)"; ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.65)"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.save();
  ctx.beginPath(); ctx.arc(R, R, R - 3, 0, Math.PI * 2); ctx.clip();

  // 距離リング（1/2, 1倍）
  ctx.strokeStyle = "rgba(255,255,255,.15)"; ctx.lineWidth = 1;
  for (const f of [0.5, 1]) {
    ctx.beginPath(); ctx.arc(R, R, range * sc * f, 0, Math.PI * 2); ctx.stroke();
  }

  // 経路: 道路経路(routeGeometry)があれば実経路のポリライン(青・実線)、
  // 無ければ目的地への直線を灰色破線（直線参考）で描く。
  const coords = routeGeometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    ctx.strokeStyle = "#1a73e8"; ctx.lineWidth = 2.8; ctx.setLineDash([]);
    ctx.lineJoin = "round";
    ctx.beginPath();
    coords.forEach(([lng, lat], i) => {
      const [x, y] = toXY(lat, lng);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  } else if (target && target.lat != null) {
    const [tx, ty] = toXY(target.lat, target.lng);
    ctx.strokeStyle = "rgba(160,160,160,.9)"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(R, R); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 避難施設（種別色の丸）
  for (const f of facilities) {
    if (!hasPos(f)) continue;
    const [x, y] = toXY(f.lat, f.lng);
    if (!inside(x, y)) continue;
    ctx.fillStyle = CATEGORY_COLORS[categoryOf(f)];
    ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 0.8; ctx.stroke();
  }

  // 伝承（橙の星 / 発見済みは金の大きい星）
  for (const t of traditions) {
    if (!hasPos(t)) continue;
    const [x, y] = toXY(t.lat, t.lng);
    if (!inside(x, y)) continue;
    const found = discoveredSet?.has(t.id);
    ctx.fillStyle = found ? "#ffd54f" : CATEGORY_COLORS.tradition;
    star(ctx, x, y, found ? 6 : 4.2);
  }

  // 目的地（赤・白縁）
  if (target && target.lat != null) {
    const [x, y] = toXY(target.lat, target.lng);
    ctx.fillStyle = "#ff5252";
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.3; ctx.stroke();
  }

  // 自分: 視野の扇形＋青ドット（北上固定なので headingDeg をそのまま回す）
  if (headingDeg != null) {
    const a = ((headingDeg - 90) * Math.PI) / 180;
    ctx.fillStyle = "rgba(100,181,246,.30)";
    ctx.beginPath(); ctx.moveTo(R, R);
    ctx.arc(R, R, Math.min(40, R * 0.45), a - 0.48, a + 0.48);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = "#42a5f5";
  ctx.beginPath(); ctx.arc(R, R, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.restore();

  // N・スケール表示
  ctx.fillStyle = "#ff8a80"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("N", R, 13);
  ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.font = "9px sans-serif";
  ctx.fillText(`半径${Math.round(range)}m`, R, size - 5);
}

function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const b = a + Math.PI / 5;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.lineTo(x + Math.cos(b) * r * 0.45, y + Math.sin(b) * r * 0.45);
  }
  ctx.closePath(); ctx.fill();
}
