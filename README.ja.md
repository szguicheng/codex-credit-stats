# Codex Credit Stats

[English](README.md) · [简体中文](README.zh-CN.md) · 日本語

![Codex Credit Stats の画面プレビュー](docs/dashboard-preview.jpg)

Codex Credit Stats は、実際の利用状況から Codex の週間クレジット上限を推定するローカル Web ツールです。利用サイクルごとの推定週間上限、1 日ごとの credits 使用量、現在のウィンドウに残っている credits、主要プランの参考値を表示します。

## インストール

Node.js 20 以降が必要です。

```bash
git clone https://github.com/szguicheng/codex-credit-stats.git
cd codex-credit-stats
npm install
npm start
```

ツールを起動すると、ブラウザにローカルページが開きます。「Connect ChatGPT and refresh」をクリックし、必要に応じて表示されたブラウザ画面で ChatGPT にログインしてください。

## 用途

現在の利用パターンから、Codex の週間クレジット上限がどの程度になるかを確認できます。画面には次の情報が表示されます。

- 7 日間の各利用サイクルに対する推定週間上限
- サイクルを比較する横向きの散布・折れ線グラフ
- 使用済み credits の合計と日ごとの内訳
- 現在のウィンドウの残り割合と推定残り credits
- Pro 20x、Pro 5x、Plus の参考値

## 動作の流れ

1. ローカル Web ツールを起動し、ブラウザ経由で ChatGPT に接続します。
2. ChatGPT の認証が完了すると、analytics ページから日ごとの使用量を取得します。
3. その使用量を、ローカルの Codex session 使用記録と組み合わせます。
4. 過去のクォータ更新時点を境界として、履歴を 7 日ごとのサイクルに分けます。直近の更新から現在日までを現在のサイクルとして扱います。
5. 各サイクルの週間上限を推定し、ダッシュボードに表示します。

## 読み取る情報

このツールが読み取る個人情報は、次の 2 種類です。

1. **ChatGPT analytics の利用データ** — ChatGPT analytics ページが返す、1 日ごとの Codex credits 使用量。analytics からプラン名が返された場合は、参考値との比較にのみ使用します。
2. **ローカル Codex session の利用データ** — ローカルの Codex session ファイルに記録された使用率とリセット時刻。通常は `~/.codex/sessions` にあります。

この 2 つの情報を使って、推定週間上限と現在のウィンドウに残っている credits を計算します。
