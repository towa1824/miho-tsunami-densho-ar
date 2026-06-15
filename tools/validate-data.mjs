// data/*.json の軽量検証スクリプト（依存なし・Node 18+）。
//   node tools/validate-data.mjs   /   npm run validate:data
//
// 検証内容:
//  - JSON が壊れていない（パースできる）
//  - id 重複がない（施設内・伝承内）
//  - source_title / source_url が全レコードにある
//  - confidence=high なのに lat/lng=null のものは、理由（geocode_note / source_note）が明記されている
//  - 伝承に location_kind があり、許可値のいずれかである
//  - location_kind と座標有無が整合している（unresolved↔座標なし / それ以外↔座標あり）
//  - 代表点・面情報（representative_point / area_or_line）には説明（caution / source_note）がある
//  - 施設の座標あり/なし件数、伝承の件数・location_kind 内訳を表示
//
// エラーがあれば終了コード 1（ビルド前のデータ健全性チェックに使える）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const LOCATION_KINDS = ["exact_point", "representative_point", "area_or_line", "unresolved"];

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function load(name) {
  const path = join(DATA, name);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    err(`${name}: JSON を読み込めません（${e.message}）`);
    return null;
  }
}

const hasPos = (r) => r.lat != null && r.lng != null;
const nonEmpty = (s) => typeof s === "string" && s.trim() !== "";
const label = (r) => r.id ?? r.name ?? r.title ?? "(no id)";

function checkSources(records, file) {
  for (const r of records) {
    if (!nonEmpty(r.source_title)) err(`${file}: ${label(r)} に source_title がありません`);
    if (!nonEmpty(r.source_url)) err(`${file}: ${label(r)} に source_url がありません`);
    else if (!/^https?:\/\//.test(r.source_url)) warn(`${file}: ${label(r)} の source_url が http(s) で始まっていません`);
  }
}

function checkDupIds(records, file) {
  const seen = new Set();
  for (const r of records) {
    if (r.id == null) { err(`${file}: id の無いレコードがあります（${label(r)}）`); continue; }
    if (seen.has(r.id)) err(`${file}: id 重複 "${r.id}"`);
    seen.add(r.id);
  }
}

// confidence=high で座標が無いものは、理由が明記されていること（task 要件）。
function checkHighWithoutCoords(records, file) {
  for (const r of records) {
    if (r.confidence === "high" && !hasPos(r)) {
      const documented = nonEmpty(r.geocode_note) || nonEmpty(r.source_note);
      if (!documented) {
        err(`${file}: ${label(r)} は confidence=high なのに座標が無く、理由（geocode_note/source_note）も未記載`);
      } else {
        warn(`${file}: ${label(r)} は confidence=high・座標なし（理由は記載あり: 存在は確実だが座標未確定）`);
      }
    }
  }
}

function main() {
  const facilities = load("evacuation_facilities.json");
  const base = load("tradition_points.json");
  const additional = load("additional_shimizu_disaster_traditions.json");
  if (!facilities || !base || !additional) finish();

  const traditions = [...base, ...additional];

  // --- 施設 ---
  checkDupIds(facilities, "evacuation_facilities.json");
  checkSources(facilities, "evacuation_facilities.json");
  checkHighWithoutCoords(facilities, "evacuation_facilities.json");
  for (const f of facilities) {
    if (hasPos(f) && f.confidence !== "high" && !nonEmpty(f.source_note)) {
      warn(`evacuation_facilities.json: ${label(f)} は座標ありで confidence≠high なのに source_note（代表点/推定の説明）が未記載`);
    }
  }

  // --- 伝承（2ファイル合算で重複・整合を確認）---
  checkDupIds(traditions, "tradition(統合)");
  checkSources(traditions, "tradition(統合)");
  checkHighWithoutCoords(traditions, "tradition(統合)");
  for (const t of traditions) {
    const k = t.location_kind;
    if (k === undefined) { err(`tradition: ${label(t)} に location_kind がありません`); continue; }
    if (!LOCATION_KINDS.includes(k)) { err(`tradition: ${label(t)} の location_kind "${k}" は不正（許可: ${LOCATION_KINDS.join("/")}）`); continue; }
    if (k === "unresolved" && hasPos(t)) err(`tradition: ${label(t)} は location_kind=unresolved なのに座標があります`);
    if (k !== "unresolved" && !hasPos(t)) err(`tradition: ${label(t)} は location_kind=${k} なのに座標がありません`);
    if ((k === "representative_point" || k === "area_or_line") && !nonEmpty(t.caution) && !nonEmpty(t.source_note)) {
      warn(`tradition: ${label(t)} は ${k} なのに代表点/面情報である説明（caution/source_note）が未記載`);
    }
  }

  // --- 件数サマリ ---
  const facWith = facilities.filter(hasPos).length;
  const traWith = traditions.filter(hasPos).length;
  const kindCounts = {};
  for (const t of traditions) kindCounts[t.location_kind] = (kindCounts[t.location_kind] ?? 0) + 1;

  console.log("=== データ件数 ===");
  console.log(`避難施設: 総数 ${facilities.length} / 座標あり ${facWith} / 座標なし ${facilities.length - facWith}`);
  console.log(`伝承・史料: 総数 ${traditions.length} / 座標あり ${traWith} / 座標なし ${traditions.length - traWith}`);
  console.log(`location_kind 内訳: ${JSON.stringify(kindCounts)}`);
  console.log("");

  finish();
}

function finish() {
  if (warnings.length) {
    console.log(`--- 警告 ${warnings.length} 件 ---`);
    warnings.forEach((w) => console.log("  ⚠ " + w));
    console.log("");
  }
  if (errors.length) {
    console.log(`=== エラー ${errors.length} 件（要修正）===`);
    errors.forEach((e) => console.log("  ✖ " + e));
    process.exit(1);
  }
  console.log("✓ データ検証 OK（エラーなし）");
  process.exit(0);
}

main();
