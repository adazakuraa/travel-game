import type { QualityTier, Region, TravelMode } from '../types';

export interface CityDef {
  id: string;
  name: string; // 日本語
  nameLocal: string;
  country: string; // ISO 3166-1 alpha-2
  countryJa: string;
  region: Region;
  tier: QualityTier;
  /** honest one-line description of the data quality available here */
  dataNote: string;
  /** IANA timezone (used before live weather/time data arrives) */
  timezone: string;
  /** spawn point – chosen on a drivable road where possible */
  start: { lat: number; lon: number; heading: number; mode: TravelMode };
  /** rough radius in km used to decide "current city" */
  radiusKm: number;
  /** building 3D Tiles source key, see world/buildings.ts */
  buildings: 'plateau' | 'swisstopo' | '3dbag' | 'osm' | 'helsinki' | 'none';
  /** terrain source key, see world/terrain.ts */
  terrain: 'gsi' | 'swisstopo' | 'terrarium' | 'flat';
  /** PLATEAU ward codes (only when buildings === 'plateau') */
  plateauWards?: string[];
  blurb: string;
}

export const CITIES: CityDef[] = [
  {
    id: 'helsinki',
    name: 'ヘルシンキ',
    nameLocal: 'Helsinki',
    country: 'FI',
    countryJa: 'フィンランド',
    region: 'eu',
    tier: 'S',
    dataNote: 'ヘルシンキ市 フォトグラメトリ・リアリティメッシュ(実写テクスチャの建物・地面・樹木、CC BY 4.0)',
    timezone: 'Europe/Helsinki',
    start: { lat: 60.16865, lon: 24.9452, heading: 260, mode: 'car' },
    radiusKm: 12,
    buildings: 'helsinki',
    terrain: 'flat',
    blurb: '航空写真から作られた街全体の実写3Dメッシュ。大聖堂、港、エスプラナーディ通り。',
  },
  {
    id: 'zurich',
    name: 'チューリッヒ',
    nameLocal: 'Zürich',
    country: 'CH',
    countryJa: 'スイス',
    region: 'eu',
    tier: 'A',
    dataNote: 'swisstopo 10cm航空写真+高精度地形+swissBUILDINGS3D(屋根形状付き、外壁テクスチャなし)',
    timezone: 'Europe/Zurich',
    start: { lat: 47.36655, lon: 8.54485, heading: 200, mode: 'car' },
    radiusKm: 10,
    buildings: 'swisstopo',
    terrain: 'swisstopo',
    blurb: 'リマト川と旧市街、チューリッヒ湖畔。スイス最大の都市。',
  },
  {
    id: 'zermatt',
    name: 'ツェルマット(マッターホルン)',
    nameLocal: 'Zermatt / Matterhorn',
    country: 'CH',
    countryJa: 'スイス',
    region: 'alps',
    tier: 'A',
    dataNote: 'swisstopo 10cm航空写真+高精度地形+swissBUILDINGS3D',
    timezone: 'Europe/Zurich',
    start: { lat: 45.98365, lon: 7.7848, heading: 245, mode: 'walk' },
    radiusKm: 15,
    buildings: 'swisstopo',
    terrain: 'swisstopo',
    blurb: 'ゴルナーグラート展望台からマッターホルンを望む。アルプスの絶景。',
  },
  {
    id: 'amsterdam',
    name: 'アムステルダム',
    nameLocal: 'Amsterdam',
    country: 'NL',
    countryJa: 'オランダ',
    region: 'eu',
    tier: 'A',
    dataNote: 'PDOK 8cm航空写真+3DBAG(全建物の屋根形状LOD2.2、外壁テクスチャなし)',
    timezone: 'Europe/Amsterdam',
    start: { lat: 52.3772, lon: 4.8975, heading: 180, mode: 'car' },
    radiusKm: 10,
    buildings: '3dbag',
    terrain: 'terrarium',
    blurb: '運河と切妻屋根の街並み。ダム広場から国立美術館へ。',
  },
  {
    id: 'paris',
    name: 'パリ',
    nameLocal: 'Paris',
    country: 'FR',
    countryJa: 'フランス',
    region: 'eu',
    tier: 'B',
    dataNote: 'IGN 20cm航空写真+OpenStreetMap建物(高さ情報からの押し出し=簡易形状)',
    timezone: 'Europe/Paris',
    start: { lat: 48.8698, lon: 2.3078, heading: 295, mode: 'car' },
    radiusKm: 10,
    buildings: 'osm',
    terrain: 'terrarium',
    blurb: 'シャンゼリゼ通りから凱旋門、エッフェル塔、セーヌ河岸へ。',
  },
  {
    id: 'newyork',
    name: 'ニューヨーク',
    nameLocal: 'New York',
    country: 'US',
    countryJa: 'アメリカ',
    region: 'us',
    tier: 'B',
    dataNote: 'USGS 航空写真+OpenStreetMap建物(高さ情報からの押し出し=簡易形状)',
    timezone: 'America/New_York',
    start: { lat: 40.7566, lon: -73.9862, heading: 29, mode: 'car' },
    radiusKm: 12,
    buildings: 'osm',
    terrain: 'terrarium',
    blurb: 'タイムズスクエア、5番街、セントラルパーク。摩天楼の谷間を走る。',
  },
  {
    id: 'grandcanyon',
    name: 'グランドキャニオン',
    nameLocal: 'Grand Canyon',
    country: 'US',
    countryJa: 'アメリカ',
    region: 'us',
    tier: 'A',
    dataNote: 'USGS 航空写真+USGS 3DEP由来の実地形(建物データなし)',
    timezone: 'America/Phoenix',
    start: { lat: 36.0578, lon: -112.1251, heading: 0, mode: 'walk' },
    radiusKm: 40,
    buildings: 'none',
    terrain: 'terrarium',
    blurb: 'コロラド川が刻んだ大峡谷。展望台から眺め、飛行機で谷の上空を飛ぶ。',
  },
  {
    id: 'tokyo',
    name: '東京',
    nameLocal: 'Tokyo',
    country: 'JP',
    countryJa: '日本',
    region: 'jp',
    tier: 'S',
    dataNote: '国交省PLATEAU テクスチャ付き3D都市モデル(LOD2/3)+国土地理院 航空写真・5mDEM',
    timezone: 'Asia/Tokyo',
    start: { lat: 35.68075, lon: 139.76345, heading: 270, mode: 'car' },
    radiusKm: 18,
    buildings: 'plateau',
    terrain: 'gsi',
    plateauWards: ['13101', '13102', '13103', '13104', '13105', '13106', '13107', '13108', '13113', '13116'],
    blurb: '丸の内・銀座・新宿・渋谷・浅草。実写テクスチャの高層ビル街をドライブ。',
  },
  {
    id: 'kyoto',
    name: '京都',
    nameLocal: 'Kyoto',
    country: 'JP',
    countryJa: '日本',
    region: 'jp',
    tier: 'S',
    dataNote: '国交省PLATEAU テクスチャ付き3D都市モデル+国土地理院 航空写真・5mDEM',
    timezone: 'Asia/Tokyo',
    start: { lat: 35.00375, lon: 135.7745, heading: 90, mode: 'car' },
    radiusKm: 14,
    buildings: 'plateau',
    terrain: 'gsi',
    plateauWards: ['26101', '26102', '26103', '26104', '26105', '26106', '26108', '26109'],
    blurb: '祇園・清水寺・金閣寺・伏見稲荷。千年の古都を巡る。',
  },
  {
    id: 'osaka',
    name: '大阪',
    nameLocal: 'Osaka',
    country: 'JP',
    countryJa: '日本',
    region: 'jp',
    tier: 'S',
    dataNote: '国交省PLATEAU テクスチャ付き3D都市モデル(LOD2/3)+国土地理院 航空写真・5mDEM',
    timezone: 'Asia/Tokyo',
    start: { lat: 34.6905, lon: 135.4985, heading: 180, mode: 'car' },
    radiusKm: 14,
    buildings: 'plateau',
    terrain: 'gsi',
    plateauWards: ['27103', '27104', '27106', '27109', '27111', '27127', '27128'],
    blurb: '御堂筋・道頓堀・大阪城・通天閣。食い倒れの街を走る。',
  },
  {
    id: 'yokohama',
    name: '横浜',
    nameLocal: 'Yokohama',
    country: 'JP',
    countryJa: '日本',
    region: 'jp',
    tier: 'S',
    dataNote: '国交省PLATEAU テクスチャ付き3D都市モデル+国土地理院 航空写真・5mDEM',
    timezone: 'Asia/Tokyo',
    start: { lat: 35.4560, lon: 139.6335, heading: 300, mode: 'car' },
    radiusKm: 10,
    buildings: 'plateau',
    terrain: 'gsi',
    plateauWards: ['14103', '14104'],
    blurb: 'みなとみらい・赤レンガ倉庫・中華街。港町の夜景ドライブ。',
  },
  {
    id: 'fuji',
    name: '富士山',
    nameLocal: 'Mount Fuji',
    country: 'JP',
    countryJa: '日本',
    region: 'jp',
    tier: 'A',
    dataNote: '国土地理院 航空写真+5m/10mDEMによる実地形(建物データなし)',
    timezone: 'Asia/Tokyo',
    start: { lat: 35.39555, lon: 138.73245, heading: 200, mode: 'walk' },
    radiusKm: 25,
    buildings: 'none',
    terrain: 'gsi',
    blurb: '標高3,776m。五合目から山頂を仰ぎ、飛行機で山の周りを周遊。',
  },
];

export function cityById(id: string): CityDef | undefined {
  return CITIES.find((c) => c.id === id);
}
