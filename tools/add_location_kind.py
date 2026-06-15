#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""伝承・史料データに location_kind（地点種別）を一度だけ付与する移行スクリプト。

地点種別は「地図/ARで点として断定してよいか」を区別するために使う。
  exact_point          … 寺社・施設など点として扱える（座標は寺社・論文の位置）
  representative_point … 旧地名・小字・範囲の代表点（おおよその位置）
  area_or_line         … 本来は面/ライン（流域の水害記憶など）。点表示は便宜的
  unresolved           … 座標なし。地図/AR非表示、注意事項の未取得一覧へ

分類根拠は各レコードの geocode_note / source_note / caution に既に明記されている
（例: 吹合=真崎の代表点・小字未特定、江湖=検潮所 分単位精度±1km、向島=日の出町quarter代表点、
 瀬織戸=ボーリング地点の代表点、巴川水害=面の情報、河内の大石=座標未入力）。

このスクリプトは id 行の直後に location_kind 行を1行挿入するだけで、他の整形・キー順は変えない。
既に location_kind を持つファイルはスキップする（再実行しても二重付与しない）。

使い方:  python tools/add_location_kind.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# id -> location_kind（現行24件の明示分類）
KIND = {
    # --- tradition_points.json（11件）---
    "miho_gohojinja_hoeiansei": "exact_point",      # 御穂神社（点）
    "miho_fukiai_ansei": "representative_point",     # 吹合 → 真崎の代表点・小字未特定
    "miho_ego_ansei": "representative_point",        # 江湖 → 清水検潮所・分単位精度±1km
    "shimizu_mukaijima_ansei": "representative_point",  # 向島 → 日の出町quarterの代表点
    "sennenji_hinan_denshou": "exact_point",         # 専念寺（点）
    "seorito_watashi": "representative_point",       # 旧水路 → ボーリング地点の代表点
    "miho_myofukuji_ansei": "exact_point",           # 妙福寺（点）
    "jissoji_ansei": "exact_point",                  # 実相寺（点）
    "baieiji_ansei": "exact_point",                  # 梅陰寺（点）
    "zensoji_ansei": "exact_point",                  # 禅叢寺（点）
    "ejiri_kojoji_ansei": "exact_point",             # 江浄寺（点）
    # --- additional_shimizu_disaster_traditions.json（13件）---
    "kaichoji_meio_record": "exact_point",           # 海長寺（点・記録継承地点）
    "miho_chokoji_ansei": "exact_point",             # 釣江寺（点）
    "myoshoji_ansei": "exact_point",                 # 妙生寺（点）
    "hoganji_ansei": "exact_point",                  # 法岸寺（点）
    "tomeiin_ansei": "exact_point",                  # 東明院（点）
    "hokyuji_ansei": "exact_point",                  # 宝久寺（点）
    "komyoji_shimomizucho_ansei": "exact_point",     # 光明寺（点）
    "keiunji_ansei": "exact_point",                  # 慶雲寺（点）
    "shinteiin_ansei": "exact_point",                # 新定院（点）
    "jojuin_ansei": "exact_point",                   # 成就院（点）
    "tokaiji_kitayabe_ansei": "exact_point",         # 東海寺（点）
    "tomoegawa_1974_2022_flood_memory": "area_or_line",  # 巴川流域＝面/ライン
    "kawachi_no_oishi_ansei": "unresolved",          # 座標未入力
}

FILES = [
    ROOT / "data" / "tradition_points.json",
    ROOT / "data" / "additional_shimizu_disaster_traditions.json",
]

ID_LINE = re.compile(r'^(?P<indent>[ \t]*)"id": "(?P<id>[^"]+)",[ \t]*$', re.MULTILINE)


def process(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if '"location_kind"' in text:
        print(f"[skip] {path.name}: already has location_kind")
        return False

    missing = []

    def repl(m: "re.Match") -> str:
        rid = m.group("id")
        indent = m.group("indent")
        kind = KIND.get(rid)
        if kind is None:
            missing.append(rid)
            return m.group(0)  # 未知idは触らない（後でエラー報告）
        return f'{m.group(0)}\n{indent}"location_kind": "{kind}",'

    new_text = ID_LINE.sub(repl, text)
    if missing:
        print(f"[ERROR] {path.name}: id に対応する location_kind が未定義: {missing}", file=sys.stderr)
        sys.exit(1)
    path.write_text(new_text, encoding="utf-8")
    print(f"[ok]   {path.name}: location_kind を付与しました")
    return True


def main() -> None:
    for f in FILES:
        if not f.exists():
            print(f"[ERROR] not found: {f}", file=sys.stderr)
            sys.exit(1)
        process(f)


if __name__ == "__main__":
    main()
