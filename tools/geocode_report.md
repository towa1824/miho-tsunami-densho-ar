# ジオコーディング結果レポート

- 実行日: 2026-06-10 14:02
- API: GSI住所検索 + OSM Nominatim（1.2s/req, キャッシュ: tools/geocode_cache.json）

## evacuation_facilities.json
- `miho_tower_fureai_north` : OK (35.004398, 138.517874) [三保ふれあい広場] Nominatimのみ(None/park)
- `miho_tower_fureai_south` : OK (35.004398, 138.517874) [三保ふれあい広場] Nominatimのみ(None/park)
- `miho_tower_tsukama` : **未取得** GSIは区・大字レベルのみ
- `miho_tower_3001` : **未取得** GSIは区・大字レベルのみ
- `miho_inochiyama` : **未取得** 両APIともヒットなし
- `miho_tower_honcho` : **未取得** GSIは区・大字レベルのみ
- `miho_tower_967` : **未取得** GSIは区・大字レベルのみ
- `miho_tower_2055` : **未取得** GSIは区・大字レベルのみ
- `miyakami_tower` : **未取得** GSIは区・大字レベルのみ
- `hagoromo_danchi` : **未取得** 両APIともヒットなし
- `port_godochosha` : **未取得** 両APIともヒットなし
- `dream_plaza_p1` : **未取得** 両APIともヒットなし
- `suzuyo_head_office` : OK (35.016882, 138.443356) [鈴与] Nominatimのみ(None/company)
- `shimizu_port_bc` : **未取得** GSIは区・大字レベルのみ
- `hinode_parking` : **未取得** 両APIともヒットなし
  - 補完 3 / 未取得 12 / 既存座標 10

## tradition_points.json
- `miho_gohojinja_hoeiansei` : OK (35.000086, 138.520848) [御穂神社] GSI/Nominatim一致(差213m)・Nominatim採用
- `miho_fukiai_ansei` : OK (35.020276, 138.520535) [真崎 三保] Nominatimのみ(None/beach_resort)
- `miho_ego_ansei` : OK (35.014530, 138.530194) [三保飛行場] Nominatimのみ(None/aerodrome)
- `shimizu_mukaijima_ansei` : OK (35.026545, 138.484739) [静岡市清水区向島町] Nominatimのみ(None/school)
  - 補完 4 / 未取得 0 / 既存座標 7

