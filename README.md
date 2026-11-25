# Chrome Tidy

Diaブラウザの自動タブグループ機能をChromium系ブラウザ(Chrome / Edge / Brave)で再現する拡張機能です。

## 機能

リンクを新しいタブで開く(⌘+click / 中クリック / target=_blank)と、**開いた元のタブと一緒に**自動でタブグループを作成します。Diaと同じく「新しいタブで開く」というジェスチャーがそのまま軽量なプロジェクト空間になります。

- **即座にグループ化**: 1枚目のリンクを開いた時点で、元タブ+新タブでグループ作成(Diaと同じ)。「2枚目を開いたら」に変更も可能
- **グループ内のタブから開いたリンク**は同じグループに自動追加
- **AIによる自動命名**: グループの中身を見て名前を付け、構成が変わると名前も進化(Diaと同じ)
  - Gemini Nano(ブラウザ内蔵・オフライン・無料)
  - OpenAI互換API(OpenAI / OpenRouter / ローカルLLMなど)
  - Anthropic(Claude)
  - AIが使えない場合は元タブのタイトルによるルールベース命名にフォールバック
- **手動リネームを尊重**: 自分で名前を付けたグループは自動命名の対象外になります
- **1枚だけになったグループは自動解除**
- ピン留めタブから開いた場合: ピン留めタブ自身はグループに入らず(Chromeの制約)、子タブ同士が2枚以上でグループ化
- 除外ドメイン設定

## インストール

```sh
npm install
npm run build
```

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をオン
3. 「パッケージ化されていない拡張機能を読み込む」で `dist/` フォルダを選択

## 開発

```sh
npm run build      # ビルド(tsc型チェック込み)
npm run watch      # 差分ビルド(watch)
npm run typecheck  # 型チェックのみ
npm test           # E2Eテスト(Chrome for Testing使用)
```

### E2Eテストについて

テストは実際のChromeで拡張機能を動かして検証します。ただし**通常のGoogle Chromeは `--load-extension` を無視する**ため、[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)が必要です:

```sh
npx @puppeteer/browsers install chrome@stable
```

`chrome/` 以下にバイナリがあればテストスクリプトが自動で検出します。環境変数 `CHROME_PATH` で明示指定も可能です。

## 技術メモ

- **検知**: `chrome.webNavigation.onCreatedNavigationTarget` を使用。リンク起点の新規タブだけを精密に拾える(`openerTabId` は新タブボタン等でも付くことがあり不正確)
- **グループ化**: `chrome.tabs.group()` + `chrome.tabGroups.update()`。グループ内タブの子タブが同グループに入るのはChromeのネイティブ挙動だが、漏れに備えて拡張側でも担保
- **命名**: Gemini Nanoは `LanguageModel` API(Chrome 138+で拡張機能から利用可・権限不要)。クラウドAI利用時は `optional_host_permissions` で保存時にホスト権限をリクエスト
- **手動リネーム検知**: 自動命名したタイトルを `chrome.storage.session` に記録し、現在のタイトルとずれたらユーザーがリネームしたと判断
- **対象外**: Arc(tabGroups API非対応)、Dia(ネイティブ機能あり)、Safari(APIなし)

## ライセンス

MIT
