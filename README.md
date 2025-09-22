# Express + sharp 画像リサイズ サンプル

URL から画像を取得し、sharp でリサイズして返す最小サンプルです。Node.js 18+ を想定しています（組み込みの `fetch` を使用）。

## セットアップ

```bash
npm install
npm start
```

## 使い方

- エンドポイント: `GET /resize`
- クエリ:
  - `url` (必須): 画像の URL（http/https）
  - `w` (任意): 出力幅（px, 上限 4000）
  - `h` (任意): 出力高さ（px, 上限 4000）
  - `fit` (任意): リサイズモード（`cover` | `contain` | `fill` | `inside` | `outside`、デフォルト `cover`）
  - `format` (任意): 出力フォーマット（`jpeg|jpg|png|webp|avif|gif|tiff`、未指定なら元フォーマット維持）
  - `q` (任意): 品質（1..100、フォーマットにより有効）

### 例

- サイズ固定（幅 800, 高さ 600, cover）
```
http://localhost:3000/resize?url=https://example.com/image.jpg&w=800&h=600
```

- 幅のみ指定（アスペクト比維持）
```
http://localhost:3000/resize?url=https://example.com/image.jpg&w=1200
```

- WebP へ変換 + 品質 80
```
http://localhost:3000/resize?url=https://example.com/image.jpg&w=1200&format=webp&q=80
```

- EXIF の回転は `rotate()` で自動補正しています。

## ストリーミング対応メモ

効果・限界

- 効果がある点
  - メモリ削減: 全画像を Buffer 化しないため、同時実行時の RSS と GC 負荷が大幅に下がる
  - レイテンシ低減: バイトが到着し次第 sharp/クライアントへ流れるため、TTFB/TTI が改善
  - バックプレッシャ: Node のストリームが自動で速度調整し、スパイク時も破綻しにくい
- 限界（別対策が必要）
  - CPU負荷: リサイズ/再エンコードの計算は残る。CPU飽和時はスループットが頭打ちに
  - コンテンツ保護/SSRF/サイズ無制限: ストリーミングでも際限なく読み続ける危険はある
  - 高負荷向けの追加施策（重要度順の目安）

キャッシュ/配信

- CDN 前段（Cache-Key = 変換パラメータ + 元URL）。ヒット率が取れれば原始的に最強
- アプリ内キャッシュ（LRU/ディスク）やリバースプロキシ（nginx, varnish）併用
- 同一キーの同時要求の合流（request coalescing, singleflight）
- 並列度・キュー制御
- sharp.concurrency の調整（CPU数≒上限、サービス全体の負荷を見て最適化）
- 変換ジョブの同時実行数をアプリ側でセマフォ制御（p-limit や Bottleneck）

ガードレール
- 入力寸法の上限・withoutEnlargement、Content-Length 上限、読み取りバイト上限（閾値超で中断）
- 許可ドメイン制限、プライベートアドレス遮断など SSRF 強化
- 適切なタイムアウト・リトライ（上流/下流双方）
- 接続最適化
- Keep-Alive（Node18+のfetch/undiciは既定で接続プール使用）
- HTTP/2/3 対応（CDN/ALB 経由）で大量の短時間リクエストに有利

スケールアウト
- プロセス/コンテナを水平スケール。PM2 やコンテナオーケストレータでスケジューリング
- 必要ならワーカー分離（変換専用プロセス）で隔離と安定性向上