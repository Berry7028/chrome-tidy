# AGENTS.md

## プロジェクト

Diaブラウザの自動タブグループ機能をChromium系ブラウザで再現する拡張機能(Manifest V3 + TypeScript + esbuild)。

## コマンド

- `npm run build` — ビルド(esbuild + tsc型チェック)。成果物は `dist/`
- `npm run watch` — watch ビルド
- `npm test` — E2Eテスト(実Chrome駆動)

## 重要な注意点

- **通常のGoogle Chromeは `--load-extension` と `--disable-extensions-except` を無視する**(branded制限)。テストには Chrome for Testing が必須: `npx @puppeteer/browsers install chrome@stable` で `chrome/` に入る。`CHROME_PATH` 環境変数でも指定可
- playwright の `launchPersistentContext` では拡張機能のサービスワーカーを確実に検出できないことがある。直接起動 + `connectOverCDP` + raw CDP での evaluate が確実
- オプションページ等の `chrome-extension://` URL は起動引数では開けず(ブロックされる)、`Target.createTarget` 経由なら開ける
- `openerTabId` は新タブボタン等でも付くことがあるため、リンク起点の検知には必ず `webNavigation.onCreatedNavigationTarget` を使う
- 拡張機能IDは `--load-extension` のパスから決定的に生成される(同じパスなら同じID)

## 設計上の判断

- グループ化は `first` モード(1枚目から即座・Dia準拠)がデフォルト
- AI命名の優先順位: 設定プロバイダ → 失敗時ルールベースにフォールバック
- 手動リネームしたグループは自動命名しない(検知: 自動設定タイトルと現在タイトルの差分)
- ユーザー作成のグループには一切触らない(`managed` マーカー管理、`chrome.storage.session` 使用)
