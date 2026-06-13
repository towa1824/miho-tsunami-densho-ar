# CLAUDE.md

## Part 1: General Guidelines (Karpathy)

1. **Think Before Coding** — 前提を明示。曖昧なら推測せず質問する。
2. **Simplicity First** — 最小のコードで解く。50行で済むものを500行にしない。
3. **Surgical Changes** — 依頼されていないコードを変更しない。ついでの整理はしない。
4. **Goal-Driven Execution** — 「何が達成されれば成功か」を先に合意してから実装する。

## Part 2: Project-Specific

- このアプリは **平時の防災学習・避難訓練支援用の試作**。実災害時の避難誘導には使わない。
  UIの注意文（「実際の災害時は公式情報に従って避難」）を削除・弱体化しない。
- WebARは **LocAR.js + three.js + Vite で固定**（バニラJSでのセンサー再発明・AR.js旧版は禁止）。
- **HTTPS必須**。開発は `@vitejs/plugin-basic-ssl`。iOSのDeviceOrientationは
  ユーザータップ内で `requestPermission()` を呼ぶ（自動起動不可。「開始」ボタン必須）。
- GPSは屋内で精度が出ない。開発・発表は **fakeGps()（デモモード）** で行い、屋外で実機確認。
- 座標・施設・伝承データは `data/*.json` に分離。**ソースコードへのハードコード禁止**。
- データの全レコードに `source_title` / `source_url` を必ず入れる。**出典のない情報は追加しない**。
  伝承・史料だけを根拠に「安全/危険」を断定する文言を書かない。
- 緯度経度が公的資料・論文由来でない場合は `confidence` を `medium` 以下にする。
- ジオコーディングは `tools/geocode.py`。Nominatim/GSIは1リクエスト/秒、結果は
  `tools/geocode_cache.json` にキャッシュし、キャッシュがある限り再リクエストしない。
- 新規ライブラリは「何を・なぜ」を1行で示してから install する。
- 主導線は「現地目線ビュー」(sim: 合成3D＋fakeGps・HTTPローカルでも動く)。PC/スマホとも既定はsim、
  「ARカメラ」(live: HTTPS＋カメラ＋方位センサー必要)はユーザーが明示的に選んだ時のみ。liveは壊さない。
- LocAR 0.1.x の `gpsupdate` ペイロードは `{ position: GeolocationPosition, distMoved }`。
  `data.position.coords.latitude` で読む（`data.coords` ではない）。
- AR表示は全画面（`#arView` を position:fixed）。表示直後は clientWidth=0 になりうるので、
  サイズは `clientWidth || window.innerWidth` でフォールバックし、次フレームで再調整する。
- 世界座標は 北=-Z / 東=+X（LocARが northing を反転）。方位カードやcardinal標識はこれに合わせる。
- 町並み3D（src/town.js）は OSM Overpass API（無料・APIキー不要）。結果は localStorage に7日
  キャッシュし連続リクエストしない。「© OpenStreetMap contributors」表記（#arAttrib・注意事項タブ）を
  消さない。建物の形・高さはタグからの推定を含む概形（=正確な実形ではない）として扱う。
