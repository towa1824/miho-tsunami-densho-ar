# -*- coding: utf-8 -*-
"""
法務省「登記所備付地図データ」(地図XML, G空間情報センター配布) から、
津波避難タワー等の所在地番の筆ポリゴンを探し、中心座標(緯度経度)を出力する。

- 入力: 22103-0806-2026.zip（静岡市清水区、内側に地区ごとのzip/XML 570個）
- 公共座標系（平面直角座標系8系・JGD2011）の地区のみ採用。任意座標系は変換不能なので捨てる。
- 平面直角→緯度経度の変換は国土地理院の級数展開式（Gauss-Krüger逆変換）を純Pythonで実装。
- 出力: amx_results.json（id, 大字名, 地番, lat, lng, 採用ファイル, 座標系）

実行例: python tools/amx_parcel_lookup.py <path-to-22103-0806-2026.zip> <out.json>
"""
import io
import json
import math
import re
import sys
import zipfile

# 探したい筆（大字名, 地番）→ 出力キー
TARGETS = {
    ("三保", "3503-24"): "miho_tower_fureai_north",
    ("三保", "884-3"): "miho_tower_fureai_south",
    ("三保", "705-5"): "miho_tower_tsukama",
    ("三保", "3001-1"): "miho_tower_3001",
    ("三保", "760"): "miho_inochiyama",
    ("三保", "967-1"): "miho_tower_967",
    ("三保", "2055-4"): "miho_tower_2055",
    ("三保本町", "2113"): "miho_tower_honcho",
    ("宮加三", "27-1"): "miyakami_tower",
}
# 町の代表点が欲しい大字（筆中心の平均を取る）
AREA_TARGETS = {"向島町": "mukaijima_area"}

OAZA_PAT = re.compile(r"<大字名>([^<]*)</大字名>")
ZAHYO_PAT = re.compile(r"<座標系>([^<]*)</座標系>")
FUDE_PAT = re.compile(
    r'<筆 id="[^"]+">.*?<大字名>([^<]*)</大字名>\s*<地番>([^<]*)</地番>\s*'
    r'<形状 idref="([^"]+)"/>', re.S)
SURF_PAT_T = r'<zmn:GM_Surface id="{fid}">(.*?)</zmn:GM_Surface>'
GEN_PAT = re.compile(r'<zmn:GM_CompositeCurve\.generator idref="([^"]+)"/>')
CURVE_PAT_T = r'<zmn:GM_Curve id="{cid}">(.*?)</zmn:GM_Curve>'
XY_PAT = re.compile(r"<zmn:X>(-?[\d.]+)</zmn:X>\s*<zmn:Y>(-?[\d.]+)</zmn:Y>")


def xy_to_latlon(x, y, phi0_deg=36.0, lam0_deg=138.5):
    """平面直角座標系(8系: 北緯36度・東経138度30分原点) → 緯度経度(JGD2011)。
    国土地理院の計算式(河瀬2011)による級数展開。x:北(+), y:東(+) [m]"""
    m0 = 0.9999
    a = 6378137.0
    F = 298.257222101
    n = 1.0 / (2 * F - 1)
    A = [1 + n**2 / 4 + n**4 / 64,
         -(3.0 / 2) * (n - n**3 / 8 - n**5 / 64),
         (15.0 / 16) * (n**2 - n**4 / 4),
         -(35.0 / 48) * (n**3 - (5.0 / 16) * n**5),
         (315.0 / 512) * n**4,
         -(693.0 / 1280) * n**5]
    beta = [None,
            (1.0 / 2) * n - (2.0 / 3) * n**2 + (37.0 / 96) * n**3
            - (1.0 / 360) * n**4 - (81.0 / 512) * n**5,
            (1.0 / 48) * n**2 + (1.0 / 15) * n**3 - (437.0 / 1440) * n**4
            + (46.0 / 105) * n**5,
            (17.0 / 480) * n**3 - (37.0 / 840) * n**4 - (209.0 / 4480) * n**5,
            (4397.0 / 161280) * n**4 - (11.0 / 504) * n**5,
            (4583.0 / 161280) * n**5]
    delta = [None,
             2 * n - (2.0 / 3) * n**2 - 2 * n**3 + (116.0 / 45) * n**4
             + (26.0 / 45) * n**5 - (2854.0 / 675) * n**6,
             (7.0 / 3) * n**2 - (8.0 / 5) * n**3 - (227.0 / 45) * n**4
             + (2704.0 / 315) * n**5 + (2323.0 / 945) * n**6,
             (56.0 / 15) * n**3 - (136.0 / 35) * n**4 - (1262.0 / 105) * n**5
             + (73814.0 / 2835) * n**6,
             (4279.0 / 630) * n**4 - (332.0 / 35) * n**5
             - (399572.0 / 14175) * n**6,
             (4174.0 / 315) * n**5 - (144838.0 / 6237) * n**6,
             (601676.0 / 22275) * n**6]
    phi0 = math.radians(phi0_deg)
    lam0 = math.radians(lam0_deg)
    A_bar = (m0 * a / (1 + n)) * A[0]
    S_bar = (m0 * a / (1 + n)) * (A[0] * phi0 + sum(
        A[j] * math.sin(2 * j * phi0) for j in range(1, 6)))
    xi = (x + S_bar) / A_bar
    eta = y / A_bar
    xi2 = xi - sum(beta[j] * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
                   for j in range(1, 6))
    eta2 = eta - sum(beta[j] * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
                     for j in range(1, 6))
    chi = math.asin(math.sin(xi2) / math.cosh(eta2))
    lat = chi + sum(delta[j] * math.sin(2 * j * chi) for j in range(1, 7))
    lon = lam0 + math.atan2(math.sinh(eta2), math.cos(xi2))
    return math.degrees(lat), math.degrees(lon)


POINT_PAT = re.compile(
    r'<zmn:GM_Point id="([^"]+)">.*?<zmn:X>(-?[\d.]+)</zmn:X>\s*'
    r'<zmn:Y>(-?[\d.]+)</zmn:Y>', re.S)
PTREF_PAT = re.compile(r'idref="(P[^"]+)"')


def build_point_map(data):
    """GM_Point id -> (X,Y)。曲線が間接参照(GM_PointRef)の地区用。"""
    return {pid: (float(x), float(y))
            for pid, x, y in POINT_PAT.findall(data)}


def parcel_centroid(data, fid, point_map=None):
    """形状idref(F...)から外周リングの全頂点平均(XY)を返す。
    曲線座標はインライン(GM_Position.direct)と点参照(idref="P...")の両方に対応。"""
    m = re.search(SURF_PAT_T.format(fid=re.escape(fid)), data, re.S)
    if not m:
        return None
    xs, ys = [], []
    for cid in GEN_PAT.findall(m.group(1)):
        cm = re.search(CURVE_PAT_T.format(cid=re.escape(cid)), data, re.S)
        if not cm:
            continue
        body = cm.group(1)
        for xv, yv in XY_PAT.findall(body):
            xs.append(float(xv))
            ys.append(float(yv))
        if point_map:
            for pid in PTREF_PAT.findall(body):
                if pid in point_map:
                    x, y = point_map[pid]
                    xs.append(x)
                    ys.append(y)
    if not xs:
        return None
    return sum(xs) / len(xs), sum(ys) / len(ys)


def main():
    zip_path = sys.argv[1] if len(sys.argv) > 1 else "22103-0806-2026.zip"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "amx_results.json"
    results = {}
    area_acc = {}  # oaza -> [(x,y), ...]
    z = zipfile.ZipFile(zip_path)
    inner_names = [n for n in z.namelist() if n.endswith(".zip")]
    scanned = 0
    for name in inner_names:
        scanned += 1
        try:
            z2 = zipfile.ZipFile(io.BytesIO(z.open(name).read()))
            xmls = [n for n in z2.namelist() if n.endswith(".xml")]
            if not xmls:
                continue
            data = z2.read(xmls[0]).decode("utf-8", errors="replace")
        except Exception:
            continue
        if ("三保" not in data and "宮加三" not in data and "向島町" not in data):
            continue
        zm = ZAHYO_PAT.search(data)
        zahyo = zm.group(1) if zm else "?"
        public = "公共座標" in zahyo
        pmap = build_point_map(data) if public else None
        for oaza, chiban, fid in FUDE_PAT.findall(data):
            key = TARGETS.get((oaza, chiban))
            if key and public:
                c = parcel_centroid(data, fid, pmap)
                if c:
                    lat, lng = xy_to_latlon(c[0], c[1])
                    results[key] = {
                        "oaza": oaza, "chiban": chiban,
                        "lat": round(lat, 6), "lng": round(lng, 6),
                        "file": name, "zahyokei": zahyo,
                    }
            if oaza in AREA_TARGETS and public:
                c = parcel_centroid(data, fid, pmap)
                if c:
                    area_acc.setdefault(oaza, []).append(c)
        if scanned % 100 == 0:
            print(f"scanned {scanned}/{len(inner_names)}, hits={len(results)}")
    for oaza, pts in area_acc.items():
        x = sum(p[0] for p in pts) / len(pts)
        y = sum(p[1] for p in pts) / len(pts)
        lat, lng = xy_to_latlon(x, y)
        results[AREA_TARGETS[oaza]] = {
            "oaza": oaza, "chiban": f"(町内{len(pts)}筆の平均)",
            "lat": round(lat, 6), "lng": round(lng, 6),
            "file": "(複数)", "zahyokei": "公共座標",
        }
    with io.open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"done: {len(results)} results -> {out_path}")


if __name__ == "__main__":
    main()
