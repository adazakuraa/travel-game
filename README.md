# 世界旅行3D

実在の都市・地形を、車・徒歩・飛行機で自由に旅できるブラウザ用3D旅行シミュレーターです。
**開発もプレイも完全無料**。APIキー・アカウント登録・クレジットカードは一切不要で、オープンデータだけで動きます。

## 遊べる場所(16か所)

| 品質 | 場所 | 3Dデータ |
|---|---|---|
| S | ヘルシンキ | 市が公開する実写フォトグラメトリ(建物・地面・樹木すべて実写テクスチャ) |
| S | 東京・京都・大阪・横浜 | 国交省 PLATEAU のテクスチャ付き3D都市モデル(LOD2〜4) |
| A | チューリッヒ・ジュネーブ・ルツェルン・ベルン・ツェルマット(マッターホルン) | swisstopo 10cm航空写真+高精度地形+屋根形状付き建物 |
| A | アムステルダム・ロッテルダム | 8cm航空写真+3DBAG(全建物の屋根形状) |
| A | グランドキャニオン・富士山 | 高解像度航空写真+実地形 |
| B | パリ・ニューヨーク | 高解像度航空写真+OpenStreetMap建物(高さからの押し出し=簡易形状) |

その他の地域も、Sentinel-2 衛星画像と全球の標高データで飛び回れます。

## 主な機能

- **車**: 実際の道路網(OpenStreetMap)に沿って走る「道路アシスト」、運転席視点/車外視点
- **徒歩**: 一人称/三人称
- **飛行機**: 近くの空港の滑走路から離陸、簡易操縦、着陸判定、コックピット視点
- **地図**: 観光地(世界遺産・自然・絶景・博物館・歴史的建造物 ほか)の検索・カテゴリ絞り込み・周辺検索、地図から即移動
- **観光地カード**: 歴史・文化・豆知識(独自執筆)+ Wikipedia の写真
- **時間・天気**: 現地のリアルタイム時刻と実際の天気(Open-Meteo)を反映(雨・雪・霧・雲・夜の窓明かり)。手動変更も可能
- **訪問記録**: 訪れた国・都市・観光地、移動距離。訪問国を世界地図で色分け。お気に入り登録(すべてブラウザ内に保存)
- **音響**: エンジン音・環境音・地域ごとのBGM(すべて Web Audio で合成)
- **画質自動調整**: 端末性能とFPSに応じて解像度を自動調整

## 操作

| | Mac(キーボード・マウス) | スマホ(タッチ) |
|---|---|---|
| 車 | W/↑ アクセル、S/↓ ブレーキ・後退、A/D 操舵、Space ホーン | 左スティックで操舵、右ボタンでアクセル・ブレーキ |
| 徒歩 | WASD で移動、Shift で走る、ドラッグで視線 | 左スティックで移動、画面ドラッグで視線 |
| 飛行機 | Shift/R 推力+、Ctrl/F 推力−、↑/W 機首下げ、↓/S 機首上げ、←→ ロール、Q/E ラダー、B ブレーキ、G 脚 | スティックが操縦桿、右ボタンで推力 |
| 共通 | V 視点切替、1/2/3 移動手段、M 地図、H UI非表示、ドラッグでカメラ回転、ホイールで距離 | 画面上のボタン |

## 開発

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ に静的サイトを出力(GitHub Pages 等にそのまま置ける)
npm run data       # ジオイド格子・国境・PLATEAU一覧を再生成(要ネット接続)
node scripts/build-models.mjs   # 車・旅客機の3Dモデルを再生成
```

GitHub Pages で公開する場合は、リポジトリの Settings → Pages → Source を「GitHub Actions」にすると、`main` への push で自動デプロイされます(`.github/workflows/deploy.yml`)。

技術調査と設計の詳細は [docs/DESIGN.md](docs/DESIGN.md) を参照してください。

## データの出典とライセンス

- 3D描画: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache-2.0)。Cesium ion は使用していません
- ヘルシンキ 3D reality mesh © City of Helsinki (CC BY 4.0)
- 3D都市モデル: 国土交通省 Project PLATEAU
- 航空写真・標高: 国土地理院(地理院タイル)
- swisstopo: SWISSIMAGE / swissBUILDINGS3D / 地形 © swisstopo
- PDOK Luchtfoto (CC BY 4.0) / 3DBAG © tudelft3d & 3DGI (CC BY 4.0)
- IGN Géoplateforme オルソ画像 (Licence Ouverte Etalab 2.0)
- USGS The National Map(パブリックドメイン)
- Sentinel-2 cloudless 2024 by EOX IT Services GmbH (CC BY-NC-SA 4.0, Contains modified Copernicus Sentinel data 2024)
- 標高: AWS Terrain Tiles / Mapzen(SRTM, GMTED, ETOPO1 ほか)、ジオイド: EGM96
- 道路・建物・滑走路: © OpenStreetMap contributors (ODbL), Overpass API
- 2D地図: OpenFreeMap / © OpenMapTiles / © OpenStreetMap contributors
- 天気: Open-Meteo (CC BY 4.0)
- 写真: Wikipedia / Wikimedia Commons(各写真のライセンスに従う)
- 国境: Natural Earth(パブリックドメイン)
- 車・旅客機の3Dモデル、効果音・BGM: 本プロジェクトで手続き生成(外部素材なし)

## 制約(正直な報告)

- 全世界を写真のようにリアルにする無料・キー不要のデータは存在しません(Google Photorealistic 3D Tiles は APIキーと課金アカウントが必須)。そのため品質は都市ごとに異なり、ゲーム内で S/A/B と明示しています。
- Sentinel-2 cloudless と Open-Meteo の無料利用は**非商用に限られます**。有料化・広告掲載をする場合はデータソースの差し替えが必要です。
- 道路・建物・滑走路データは公開 Overpass API から取得します。混雑時は読み込みが遅れたり、道路アシストが一時的に効かないことがあります。
- 高架の高速道路は地形上に表現できないため走行対象外です。
- 環境音・音楽は録音ではなく合成音です。
