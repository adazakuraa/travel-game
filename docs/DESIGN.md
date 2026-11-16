# 世界旅行3D — 技術調査・設計書

最終更新: 2026-11-15

## 1. 調査結果(STEP 1)

すべて実際に HTTP リクエストを送り、ステータスと CORS ヘッダを確認しています(2026-11-15、`curl -H "Origin: …"`)。「キー不要」はアカウント登録・APIキー・クレジットカードが一切不要という意味です。

### 1-1. 3D描画エンジン

| 候補 | 無料 | キー | 判定 |
|---|---|---|---|
| **CesiumJS 1.147** (Apache-2.0) | ○ | 不要(ion を使わない設定で動作) | **採用**。WGS84楕円体・3D Tiles・地形・大気・太陽位置を標準装備。地理整合性が最も高い |
| Three.js + 3d-tiles-renderer | ○ | 不要 | 見送り。地球規模の座標・地形・大気を自作する必要があり、工数とリスクが大きい |
| deck.gl / MapLibre 3D | ○ | 不要 | 見送り。地上目線のドライブには不向き |

### 1-2. 3D建物・都市メッシュ

| データ | 地域 | 品質 | キー | CORS | ライセンス | 判定 |
|---|---|---|---|---|---|---|
| Google Photorealistic 3D Tiles | 全世界 | 最高 | **APIキー+課金アカウント必須** | – | Google規約 | **不採用**(条件違反) |
| Cesium ion (OSM Buildings 等) | 全世界 | 中 | **アカウント+トークン必須** | – | ion規約 | **不採用**(条件違反) |
| **ヘルシンキ市 リアリティメッシュ** (kartta.hel.fi) | ヘルシンキ全域 | フォトグラメトリ(実写テクスチャ、KTX2) | 不要 | ○ | CC BY 4.0 | **採用(品質S)** |
| **国交省 PLATEAU** 3D Tiles | 日本の各都市 | 実写テクスチャ LOD2〜4 | 不要 | ○ | CC BY 4.0互換 | **採用(品質S)** |
| **swissBUILDINGS3D** (3d.geo.admin.ch) | スイス全土 | LOD2(屋根形状あり)、テクスチャなし | 不要 | ○ | OGD(© swisstopo) | **採用(品質A)** |
| **3DBAG** (data.3dbag.nl) | オランダ全土 | LOD2.2、テクスチャなし | 不要 | ○ | CC BY 4.0 | **採用(品質A)** |
| OpenStreetMap 建物 (Overpass) | 全世界 | 高さ情報からの押し出し(簡易形状) | 不要 | ○ | ODbL | パリ・NYのみ採用(**品質B と明示**) |
| ハンブルク/ベルリン/NRW/ウィーン等 | – | – | – | 未確認 | – | 配信URLを確認できず今回は見送り |

### 1-3. 航空写真・衛星画像(すべてキー不要・CORS可を実測)

| データ | 範囲 | 最大ズーム | ライセンス |
|---|---|---|---|
| Sentinel-2 cloudless 2024 (EOX) | 全世界 | z14 (10m) | CC BY-NC-SA 4.0 → **非商用のみ** |
| 国土地理院 シームレス空中写真 | 日本 | z18 | 出典明示で利用可 |
| swisstopo SWISSIMAGE | スイス | z20 (10cm) | OGD |
| PDOK Luchtfoto | オランダ | z20 (8cm) | CC BY 4.0 |
| IGN Géoplateforme オルソ | フランス | z19 (20cm) | Licence Ouverte 2.0 |
| USGS The National Map | 米国 | z16 (1m) | パブリックドメイン |
| Esri World Imagery | 全世界 | – | 規約上 ArcGIS アカウント前提 → **不採用** |

### 1-4. 地形

| データ | 範囲 | 解像度 | ライセンス |
|---|---|---|---|
| 国土地理院 標高タイル DEM5A / DEM10B | 日本 | 5m / 10m | 出典明示 |
| AWS Terrain Tiles (Terrarium) | 全世界 | 〜30m(米国は3DEP由来で高精細) | 帰属表示(SRTM, GMTED, ETOPO1 等) |
| swisstopo terrain (quantized-mesh) | スイス(全世界の粗データ含む) | 高精細 | OGD |

標高タイルは平均海面基準、3D Tiles は楕円体高のため、**EGM96 ジオイド高(1°格子、ビルド時に生成)を加算**して高さを一致させています。

### 1-5. 道路・地図・観光・天気

| 用途 | データ | キー | 備考 |
|---|---|---|---|
| 道路網・滑走路・OSM建物 | OpenStreetMap / Overpass API | 不要 | 約1km区画ごとに逐次取得、直列化・キャッシュ・2系統のミラーで切替 |
| 2D地図 | OpenFreeMap (MapLibre GL JS) | 不要 | 帰属表示必須 |
| 観光地 | 独自執筆の説明文 + Wikipedia REST(写真) + Wikipedia geosearch(周辺検索) | 不要 | 写真は CC BY-SA 等、出典リンク表示 |
| 天気・現地時刻 | Open-Meteo | 不要 | **非商用のみ無料**、CC BY 4.0 |
| 国境 | Natural Earth 1:110m | 不要 | パブリックドメイン |

## 2. 技術構成の決定(STEP 2)

- **描画**: CesiumJS(ion 不使用) + Vite + TypeScript。静的サイトとして GitHub Pages 等で無料公開可能
- **世界**: 国別の高解像度航空写真を重ね、残りを Sentinel-2 で補完。地形は日本=地理院、スイス=swisstopo、その他=Terrarium
- **建物**: 都市ごとに最良のオープンデータを読み込み。テクスチャのない建物には独自シェーダーで窓・壁・屋根・夜間照明を描く
- **車**: 物理エンジンは使わず、アーケード寄りの自転車モデル。OSM道路網の線分インデックスで「道路アシスト」(車道からはみ出さない・道路方向に自動で向きを揃える)
- **音**: すべて Web Audio API で合成(録音素材ゼロ=ライセンス問題なし)

### 実現できない/制約のある要件(正直な報告)

1. **全世界をフォトリアルにすることは、無料・キー不要の条件では不可能です。** 唯一の全球フォトリアルデータ(Google 3D Tiles)はAPIキーと課金アカウントが必須です。そのため、オープンデータの質が高い都市に絞っています。品質S/A/Bはゲーム内に明示します。
2. EOX Sentinel-2 と Open-Meteo は**非商用利用のみ**無料です。このゲームを有料化・広告化する場合は差し替えが必要です。
3. 高架の高速道路は地形上に表現できないため、走行対象から除外しています(一般道は走れます)。
4. 現地の環境音や音楽は録音ではなく合成音です(雰囲気に合わせた音色・音階で生成)。
5. 夜景は窓明かりを独自シェーダーで描いています。実際の街灯データはありません。

## 3. 全体設計(STEP 3)

```
src/
  main.ts            起動(Cesium資産パス、ジオイド読込、Game/UI/Audio 結線)
  types.ts           モジュール間の契約(GameAPI / AudioAPI / イベント / POI 型)
  core/events.ts     型付きイベント
  data/              cities.ts(16都市) / pois.ts(観光地) / plateau.generated.json
  world/             viewer / terrain / imagery / buildings / osm / osmBuildings / environment / geoid
  game/              game.ts(ループ・カメラ・テレポート) / vehicles.ts / roads.ts / input.ts
  ui/                タイトル・HUD・地図・観光地カード・お気に入り・訪問記録・設定
  audio/             エンジン音・環境音・地域別BGM・効果音(すべて合成)
  services/          wiki.ts / geo.ts / weather.ts
  store/             localStorage(設定・お気に入り・訪問記録・最終位置)
scripts/
  build-data.mjs     ジオイド格子・国境・PLATEAUタイル一覧を生成
  build-models.mjs   車・旅客機の glTF を three.js で手続き生成
```

### 操作

| | Mac | スマホ |
|---|---|---|
| 車 | W/↑ アクセル, S/↓ ブレーキ・後退, A/D 操舵, Space ホーン | 左スティック操舵 / 右ボタン アクセル・ブレーキ |
| 徒歩 | WASD 移動, Shift 走る, ドラッグで視線 | 左スティック移動 / 画面ドラッグで視線 |
| 飛行機 | Shift/R 推力+, Ctrl/F 推力−, ↑/W 機首下げ, ↓/S 機首上げ, ←→ ロール, Q/E ラダー, B ブレーキ, G ギア | スティック=操縦桿 / 右ボタン=推力 |
| 共通 | V 視点切替, 1/2/3 移動手段, M 地図, H UI非表示, ドラッグ=カメラ回転, ホイール=距離 | HUDボタン |

### データ保存

localStorage(`wt3d.` プレフィックス): 設定、お気に入り、訪問記録(国・都市・観光地・移動距離)、最終位置。アカウント不要です。
