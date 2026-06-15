// データ読込と分類・近傍探索。
// 座標・施設・伝承は data/*.json に分離（ハードコード禁止 / CLAUDE.md）。
import facilities from "../data/evacuation_facilities.json";
import traditionsBase from "../data/tradition_points.json";
import traditionsAdditional from "../data/additional_shimizu_disaster_traditions.json";
import sources from "../data/sources.json";
import demoLocations from "../data/demo_locations.json";
import { distanceM } from "./geo.js";

// 既存の伝承・史料と追加分（清水区の災害伝承）をマージ。
// 表示・近傍探索・地図/ARはすべてこの統合済み traditions を参照する。
const traditions = [...traditionsBase, ...traditionsAdditional];

// 開発時のみ: マージで id が重複していたら気づけるよう警告する（本番ビルドでは出さない）。
if (import.meta.env?.DEV) {
  const seen = new Set();
  const dups = new Set();
  for (const t of traditions) {
    if (seen.has(t.id)) dups.add(t.id);
    seen.add(t.id);
  }
  if (dups.size) {
    console.warn("[data] 伝承データのid重複:", [...dups],
      "— tradition_points.json と additional_shimizu_disaster_traditions.json を確認してください");
  }
}

export { facilities, traditions, sources, demoLocations };

// 推定震度の表示文字列。任意の intensity_label があれば優先（例: 「5以下」）、
// なければ数値を整形（6.5 ⇒「6〜7」）。intensity が無ければ null（=表示しない）。
// ui.js / map.js / ar.js で重複していた表示ロジックをここに集約。
export function intensityLabel(t) {
  if (t.intensity == null) return null;
  if (t.intensity_label) return t.intensity_label;
  if (t.intensity === 6.5) return "6〜7";
  return String(t.intensity);
}

// 津波からの一時避難に使う種別（指定避難所はこれに含めない）
const TSUNAMI_TYPES = ["津波緊急避難場所", "津波避難ビル", "津波避難施設"];

export function isTsunamiFacility(f) {
  return TSUNAMI_TYPES.some((t) => f.type.includes(t));
}

export function hasPos(r) {
  return r.lat != null && r.lng != null;
}

// マーカー・バッジの色分けキー
// タワー:青 / 命山:緑 / 津波避難ビル:紫 / 指定避難所:濃灰青 / 伝承:橙 / 未確認(low):灰
export function categoryOf(r) {
  if (r.confidence === "low") return "unsure";
  if (r.category) return "tradition";
  if (r.subtype === "命山") return "inochiyama";
  if (r.type === "津波緊急避難場所") return "tower";
  if (r.type === "津波避難ビル") return "building";
  return "shelter";
}

export const CATEGORY_COLORS = {
  tower: "#1565c0",
  inochiyama: "#2e7d32",
  building: "#6a1b9a",
  shelter: "#455a64",
  tradition: "#ef6c00",
  unsure: "#8d8d8d",
};

export const CATEGORY_LABELS = {
  tower: "津波避難タワー",
  inochiyama: "命山",
  building: "津波避難ビル",
  shelter: "指定避難所",
  tradition: "伝承・史料",
  unsure: "注意・位置未確認",
};

// 伝承・史料の地点種別（地図/ARで「点として断定してよいか」を区別する）。
//   exact_point          … 寺社・施設など点として扱える
//   representative_point … 旧地名・小字・範囲の代表点（おおよその位置）
//   area_or_line         … 本来は面/ライン（流域の水害記憶など）。点表示は便宜的
//   unresolved           … 座標なし。地図/ARに出さず、注意事項の未取得一覧へ
export const LOCATION_KINDS = ["exact_point", "representative_point", "area_or_line", "unresolved"];

// 明示の location_kind を優先し、未設定時は座標有無から保守的に推定する。
export function locationKindOf(t) {
  if (t.location_kind && LOCATION_KINDS.includes(t.location_kind)) return t.location_kind;
  return hasPos(t) ? "exact_point" : "unresolved";
}

// 地図ポップアップ／カードに添える「位置の確かさ」注記。点として断定できない地点にだけ
// 短い文言を返す（確かな点・非表示の地点は null）。伝承は location_kind、施設は confidence で判断。
export function coordCaveat(r) {
  if (r.category) { // 伝承・史料
    const k = locationKindOf(r);
    if (k === "representative_point") return "代表点（旧地名・範囲のおおよその位置。正確な被害地点ではありません）";
    if (k === "area_or_line") return "代表点・本来は面/ライン情報（流域規模の記録で、特定地点の被害ではありません）";
    return null;
  }
  // 施設: 座標があり confidence が high でない＝施設名・住所ジオコーディングの概略位置
  if (hasPos(r) && r.confidence !== "high") return "おおよその位置（施設名・住所からの推定）";
  return null;
}

function withDist(list, pos) {
  return list
    .filter(hasPos)
    .map((r) => ({ ...r, _dist: distanceM(pos.lat, pos.lng, r.lat, r.lng) }))
    .sort((a, b) => a._dist - b._dist);
}

// 現在地から近い津波避難先（タワー/命山/ビル優先）上位n件
export function nearestTsunamiFacilities(pos, n = 3) {
  return withDist(facilities.filter(isTsunamiFacility), pos).slice(0, n);
}

// 指定避難所（津波一時避難とは区別して表示する）
export function nearestShelters(pos, n = 2) {
  return withDist(facilities.filter((f) => !isTsunamiFacility(f)), pos).slice(0, n);
}

export function nearestTradition(pos) {
  return withDist(traditions, pos)[0] ?? null;
}

export function traditionsWithin(pos, radiusM = 1200) {
  return withDist(traditions, pos).filter((t) => t._dist <= radiusM);
}

export function facilityById(id) {
  return facilities.find((f) => f.id === id) ?? null;
}

export function traditionById(id) {
  return traditions.find((t) => t.id === id) ?? null;
}

// 位置未取得（lat/lng が null）の一覧 — READMEの未取得一覧と対応
export function unresolvedRecords() {
  return {
    facilities: facilities.filter((f) => !hasPos(f)),
    traditions: traditions.filter((t) => !hasPos(t)),
  };
}
