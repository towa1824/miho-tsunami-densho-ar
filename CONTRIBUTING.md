# コントリビューションガイド / Contributing

ご関心ありがとうございます。本リポジトリは **平時の防災学習・避難訓練支援用の試作（研究）** です。
**実災害時の避難誘導アプリではありません。** この前提を壊さない変更をお願いします。

## 共同開発の進め方（ブランチ / fork と PR）

- **`main` への直接 push / commit は禁止**です（ruleset で保護。誰も直接 push できません）。
- 変更は次のいずれかで行い、**必ずプルリクエスト（PR）として提案**します:
  - **作業ブランチ**（リポジトリへの write 権限がある共同開発者）: `git switch -c feature/xxx` で作業し PR を作成。
  - **fork**（write 権限のない方・外部の方）: リポジトリを fork し、自分の fork のブランチで作業して PR を作成。
- **`main` への取り込み（merge）は、owner `@towa1824` の承認後にのみ**行われます
  （`.github/CODEOWNERS` ＋ ruleset「Require review from Code Owners」により、**owner のレビュー承認が必須**）。
  他の共同開発者の承認だけでは merge できません。
- **CI（`build & validate data`）が通らない PR は merge できません。** force push・branch 削除も ruleset で禁止です。
- 共同開発者に **admin 権限は付与しません**（owner のみ）。権限は最小限（write もしくは fork）に保ちます。
  - 信頼できる相手以外は collaborator（write）にせず、**fork からの PR 運用**を推奨します
    （個人アカウントの repo では collaborator は write 権限を持つため）。

## 開発の流れ

1. 上記のとおり、作業ブランチまたは fork で変更し、**PR 経由**で提案します（`main` 直接 push は不可）。
2. 変更前にローカルで動作確認:
   ```bash
   npm ci
   npm run validate:data   # データの健全性チェック（id重複・出典・座標・location_kind）
   npm run build           # 本番ビルドが通ること
   npm run dev             # 画面確認（HTTPS）／ npm run dev:http（HTTP・デスクトップ確認）
   ```
3. PR テンプレートのチェックリストをすべて満たしてください。CI（`npm ci` → `validate:data` → `build`）が通る必要があります。

## 守ってほしいこと（このプロジェクトの原則）

- **安全/危険を断定しない**: 伝承・史料だけを根拠に「この場所は安全」「この道は危険」と断定する表現を入れない。
  伝承・史料は「避難判断の決定根拠ではなく、公的情報と組み合わせて理解するための補助情報」として扱う。
- **注意文を弱めない**: 「平時の防災学習・避難訓練支援を目的とした試作」「実際の災害時は公式情報に従って避難」
  といった UI 注意文を削除・弱体化しない。
- **本番避難誘導アプリのように見せない**: 実災害時に使える正式な避難ナビであるかのような表現・機能を追加しない。

## データを追加・変更するとき（`data/*.json`）

- すべてのレコードに **`source_title` と `source_url`** を付ける（**出典のない情報は追加しない**）。
- 緯度経度は **公的資料・論文・登記所地図等に基づく場合のみ** 入れる。施設名・住所の単純なジオコーディングだけの座標は
  `confidence` を **medium 以下**にする。根拠が弱いものは `lat/lng=null` のままにする（**推測座標は不可**）。
- 伝承・史料には地点種別 **`location_kind`**（`exact_point` / `representative_point` / `area_or_line` / `unresolved`）を付ける。
  代表点・面情報は UI で「代表点・おおよその位置」と分かるようにする。
- 外部データ（OpenStreetMap / Overpass / OSRM / 国土地理院 / Nominatim / 静岡市資料 / 査読論文）の
  **出典・attribution 表記を消さない**（`NOTICE.md`・README・注意事項タブ・`#arAttrib`）。

## コーディング方針（`CLAUDE.md` に準拠）

- 最小限・外科的な変更（依頼外の整理をしない）。座標・データはソースにハードコードせず `data/*.json` に置く。
- WebAR は LocAR.js + three.js + Vite 構成を維持。経路・距離は「参考表示」とし「最短」と断定しない。
