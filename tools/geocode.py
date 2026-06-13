# -*- coding: utf-8 -*-
"""
data/evacuation_facilities.json と data/tradition_points.json の lat/lng (null) を
ジオコーディングで補完するスクリプト。

方針（CLAUDE.md / README 参照）:
- 1リクエスト/秒以下（RATE_WAIT 秒待機）。結果は tools/geocode_cache.json に永続キャッシュし、
  キャッシュがある限り再リクエストしない。
- GSI（国土地理院 住所検索API）と OSM Nominatim の両方を引き、
  - 両方成功し 300m 以内で一致 → そのまま採用（信頼度は維持）
  - 片方のみ成功 → 採用するが、粗い一致（大字センター等）なら confidence を下げる
  - 取得できない → lat/lng は null のまま（README の未取得一覧に載せる）
- 「大字センターしか取れない」住所（例: 三保3503-24 → 「三保」中心点）は
  施設位置として誤解を招くため null 扱いにする（coarse 判定）。
実行: python tools/geocode.py
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT / "tools" / "geocode_cache.json"
REPORT_PATH = ROOT / "tools" / "geocode_report.md"
RATE_WAIT = 1.2  # 秒。Nominatim 利用規約(1req/s)より緩く設定
UA = "miho-tsunami-densho-ar/0.1 (university seminar project; one-shot batch geocoding)"

# 対象地域のバウンディングボックス（清水区 三保〜清水港周辺 + 余裕）
BBOX = {"min_lat": 34.94, "max_lat": 35.07, "min_lng": 138.43, "max_lng": 138.58}

_last_request = [0.0]


def _throttle():
    wait = RATE_WAIT - (time.time() - _last_request[0])
    if wait > 0:
        time.sleep(wait)
    _last_request[0] = time.time()


def _get_json(url):
    _throttle()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def in_bbox(lat, lng):
    return (BBOX["min_lat"] <= lat <= BBOX["max_lat"]
            and BBOX["min_lng"] <= lng <= BBOX["max_lng"])


def dist_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _gsi_coarse(query, title):
    """GSIの一致が「区・大字センター等の粗い一致」かどうか判定する。

    - タイトルが市区レベルで終わる → 粗い
    - クエリに番地数字があるのにタイトルに含まれない → 粗い
    - クエリに大字より細かい語（吹合・江湖など）があるのにタイトルが大字止まり → 粗い
    """
    detail = title
    for part in ("静岡県", "静岡市", "清水区", "駿河区", "葵区"):
        detail = detail.replace(part, "")
    detail = detail.strip()
    if not detail:
        return True
    nums = re.findall(r"\d+", query)
    if nums and not any(n in title for n in nums):
        return True
    extra = query
    for part in ("静岡県", "静岡市", "清水区", "静岡", "清水"):
        extra = extra.replace(part, "")
    extra = extra.replace(detail, "").replace("市", "").replace("区", "")
    extra = re.sub(r"[\s\d\-－ー]", "", extra)
    if extra and extra not in title:
        return True
    return False


def gsi_search(query):
    """国土地理院 住所検索API。bbox 内の最初の候補を返す。"""
    url = ("https://msearch.gsi.go.jp/address-search/AddressSearch?q="
           + urllib.parse.quote(query))
    try:
        data = _get_json(url)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    for item in data or []:
        try:
            lng, lat = item["geometry"]["coordinates"][:2]
            title = item.get("properties", {}).get("title", "")
        except Exception:
            continue
        if in_bbox(lat, lng):
            return {"ok": True, "lat": lat, "lng": lng, "title": title,
                    "coarse": _gsi_coarse(query, title)}
    return {"ok": False, "error": "no result in bbox"}


def nominatim_search(query):
    """OSM Nominatim。対象地域 bbox で bounded 検索。"""
    params = urllib.parse.urlencode({
        "q": query,
        "format": "jsonv2",
        "limit": 3,
        "countrycodes": "jp",
        "viewbox": f"{BBOX['min_lng']},{BBOX['max_lat']},{BBOX['max_lng']},{BBOX['min_lat']}",
        "bounded": 1,
        "accept-language": "ja",
    })
    url = "https://nominatim.openstreetmap.org/search?" + params
    try:
        data = _get_json(url)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    for item in data or []:
        lat, lng = float(item["lat"]), float(item["lon"])
        if in_bbox(lat, lng):
            # 大字・地区そのもの（place/boundary）への一致は施設位置としては粗い
            coarse = item.get("class") in ("place", "boundary")
            return {"ok": True, "lat": lat, "lng": lng,
                    "title": item.get("display_name", ""),
                    "type": f"{item.get('class')}/{item.get('type')}",
                    "coarse": coarse}
    return {"ok": False, "error": "no result in bbox"}


def load_cache():
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    return {}


def save_cache(cache):
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2),
                          encoding="utf-8")


def geocode(query, cache):
    if query in cache:
        res = cache[query]
        # 判定ロジック更新後もキャッシュした生レスポンスから coarse を再計算する
        if res.get("gsi", {}).get("ok"):
            res["gsi"]["coarse"] = _gsi_coarse(query, res["gsi"].get("title", ""))
        return res
    result = {"gsi": gsi_search(query), "nominatim": nominatim_search(query)}
    cache[query] = result
    save_cache(cache)  # 1件ごとに保存（途中中断でもキャッシュが残る）
    return result


def decide(query, res):
    """採用座標と判定メモを返す。採用不可なら lat/lng=None。

    クエリが「静岡」で始まる住所型なら GSI を、施設名・地物名型なら Nominatim を
    優先する（乖離した場合）。
    """
    address_type = query.startswith("静岡")
    g, n = res["gsi"], res["nominatim"]
    g_ok = g.get("ok") and not g.get("coarse")
    n_ok = n.get("ok") and not n.get("coarse")
    if g_ok and n_ok:
        d = dist_m(g["lat"], g["lng"], n["lat"], n["lng"])
        if d <= 300:
            return n["lat"], n["lng"], f"GSI/Nominatim一致(差{d:.0f}m)・Nominatim採用", "keep"
        if address_type:
            # 住所型でGSIが町丁目まで一致しているなら、Nominatimの誤候補とみなす
            return g["lat"], g["lng"], f"GSI/Nominatim乖離(差{d:.0f}m)・住所型のためGSI採用", "keep_medium"
        return n["lat"], n["lng"], f"GSI/Nominatim乖離(差{d:.0f}m)・施設名型のためNominatim採用", "downgrade"
    if n_ok:
        return n["lat"], n["lng"], f"Nominatimのみ({n.get('type','')})", "keep_medium"
    if g_ok:
        return g["lat"], g["lng"], f"GSIのみ({g.get('title','')})", "keep_medium"
    # 粗い一致しかない/全滅 → null のまま
    notes = []
    if g.get("ok") and g.get("coarse"):
        notes.append("GSIは区・大字レベルのみ")
    if n.get("ok") and n.get("coarse"):
        notes.append("Nominatimは地区レベルのみ")
    if not notes:
        notes.append("両APIともヒットなし")
    return None, None, "・".join(notes), "fail"


def downgrade(conf, level):
    order = ["high", "medium", "low"]
    if level == "keep":
        return conf
    if level == "keep_medium":
        return "medium" if conf == "high" else conf
    if level == "downgrade":
        return "low" if conf != "low" else conf
    return conf


def process(path, cache, report_lines):
    records = json.loads(path.read_text(encoding="utf-8"))
    filled = failed = skipped = 0
    for rec in records:
        if rec.get("lat") is not None and rec.get("lng") is not None:
            skipped += 1
            continue
        queries = rec.get("geocode_query")
        if not queries:
            report_lines.append(f"- `{rec['id']}` : geocode_query なし（座標は手動確認待ち）")
            failed += 1
            continue
        if isinstance(queries, str):
            queries = [queries]
        lat = lng = None
        note = ""
        level = "fail"
        for query in queries:  # 候補クエリを順に試し、最初に確定したものを使う
            res = geocode(query, cache)
            lat, lng, note, level = decide(query, res)
            if lat is not None:
                note = f"[{query}] {note}"
                break
        if lat is not None:
            rec["lat"], rec["lng"] = round(lat, 6), round(lng, 6)
            rec["confidence"] = downgrade(rec.get("confidence", "medium"), level)
            rec["geocode_note"] = note
            report_lines.append(f"- `{rec['id']}` : OK ({lat:.6f}, {lng:.6f}) {note}")
            filled += 1
        else:
            rec["geocode_note"] = note
            report_lines.append(f"- `{rec['id']}` : **未取得** {note}")
            failed += 1
    path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return filled, failed, skipped


def main():
    cache = load_cache()
    report = ["# ジオコーディング結果レポート", "",
              f"- 実行日: {time.strftime('%Y-%m-%d %H:%M')}",
              f"- API: GSI住所検索 + OSM Nominatim（{RATE_WAIT}s/req, キャッシュ: tools/geocode_cache.json）",
              ""]
    total = {"filled": 0, "failed": 0, "skipped": 0}
    for name in ["evacuation_facilities.json", "tradition_points.json"]:
        path = ROOT / "data" / name
        report.append(f"## {name}")
        f, x, s = process(path, cache, report)
        report.append(f"  - 補完 {f} / 未取得 {x} / 既存座標 {s}")
        report.append("")
        total["filled"] += f
        total["failed"] += x
        total["skipped"] += s
    REPORT_PATH.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(f"done: filled={total['filled']} failed={total['failed']} "
          f"skipped={total['skipped']} -> tools/geocode_report.md")


if __name__ == "__main__":
    sys.exit(main())
