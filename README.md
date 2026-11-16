# 約定強弱シミュレーター

bitFlyer Lightning 現物の BTC/JPY 約定を集計し、買い継続・拮抗・売り継続の3シナリオで到達価格帯を試算します。15分・30分・1時間・4時間の買い比率、出来高、買い／売り効率を比較できます。注文機能はありません。

## 起動

Node.js 24 以上と npm が必要です。bitFlyer の公開APIを利用するため、APIキーやデータベースの設定は不要です。

```sh
npm ci
npm run dev
```

[http://127.0.0.1:3000](http://127.0.0.1:3000) を開きます。ソース変更後は `npm run dev` を実行し直してください。ビルド済みの状態で起動する場合は `npm start` を使います。待ち受け先は環境変数 `HOST` と `PORT` で指定できます。

## 計算と設定

- 計測ウィンドウの出来高ペースと、JSTの時間帯別ウェイトを使った補正ペースを併記します。ホライズンは1時間、4時間、次の06:00 JSTです。06:00は毎日の固定時刻です。
- 約定は最大24ページ、12,000件まで取得します。約定履歴が足りないウィンドウには取得範囲のみの値を表示し、到達帯の計算から外します。
- ATRは確定した5分足14本の真の値幅の単純平均です。カバー範囲内で約定のない5分は前の終値で横ばいとします。
- 到達帯とシナリオ配分は現在の約定フローを外挿した試算です。シナリオ配分は検証済みの発生確率として校正されていません。
- 構造レベルは空、セッションウェイトは全時間帯1.00で始まります。設定はブラウザーのローカルストレージに保存されます。以前の環境にある設定は必要に応じて入力してください。
- 画面は約60秒ごとに更新します。複数タブからの同時要求はサーバーで1回にまとめ、応答を55秒間共有します。「更新」を押した時点でキャッシュが有効なら同じ更新時刻が表示されます。

## 検証

```sh
npm run typecheck
npm test
npm run build
```

## GitHubでソースを公開する

1. このZIPを展開し、`package.json` のあるディレクトリを開きます。
2. GitHubに空のリポジトリを作成し、公開範囲を選びます。第三者に利用や改変を許諾する場合は、公開者が使用するライセンスを決めて `LICENSE` を追加します。
3. 下記のURLを作成したリポジトリのURLに置き換えて実行します。

```sh
git init -b main
git add .
git status --short
git commit -m "Initial release"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

アプリをブラウザーから利用できるURLで配信する場合は、ビルド後にNode.jsサーバーを実行できるホスティングが必要です。GitHub Pagesは静的配信なので、この構成の `/api/flow` を実行できません。

[bitFlyer Lightning API](https://lightning.bitflyer.com/docs/api) · [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site) · [GitHubのライセンスガイド](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
