// データ読込と分類・近傍探索。
// 座標・施設・伝承は data/*.json に分離（ハードコード禁止 / CLAUDE.md）。
import facilities from "../data/evacuation_facilities.json";
import traditions from "../data/tradition_points.json";
import sources from "../data/sources.json";
import demoLocations from "../data/demo_locations.json";
import { distanceM } from "./geo.js";

export { facilities, traditions, sources, demoLocations };

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
