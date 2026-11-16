import type { GraphicsQuality, WeatherKind } from '../types';
import { loadSettings, loadVolumes, saveSettings, saveVolumes, type Settings, type Volumes } from '../store/storage';
import { h, pad2 } from './dom';
import { createPanel } from './panels';
import { WEATHER_LABEL } from './hud';
import type { UiContext } from './ctx';

const QUALITY_LABEL: Record<GraphicsQuality, string> = { auto: '自動', low: '低', medium: '中', high: '高', ultra: '最高' };
const WEATHERS: WeatherKind[] = ['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'storm'];

const CREDITS: [string, string][] = [
  ['CesiumJS', 'Apache-2.0'],
  ['ヘルシンキ市 3D reality mesh', 'CC BY 4.0'],
  ['国土交通省 PLATEAU', '3D都市モデル'],
  ['国土地理院 地理院タイル', '出典: 国土地理院'],
  ['swisstopo OGD', '© swisstopo'],
  ['PDOK luchtfoto', 'CC BY 4.0'],
  ['3DBAG', 'CC BY 4.0, © tudelft3d & 3DGI'],
  ['IGN Géoplateforme', 'Licence Ouverte 2.0'],
  ['USGS The National Map', 'パブリックドメイン'],
  ['Sentinel-2 cloudless by EOX', 'CC BY-NC-SA 4.0 (contains modified Copernicus Sentinel data)'],
  ['AWS Terrain Tiles / Mapzen', 'SRTM, GMTED, ETOPO1 ほか'],
  ['OpenStreetMap contributors', 'ODbL / Overpass API'],
  ['OpenFreeMap / OpenMapTiles', '© OpenMapTiles Data from OpenStreetMap'],
  ['Open-Meteo', 'CC BY 4.0'],
  ['Wikipedia / Wikimedia Commons', 'CC BY-SA'],
  ['Natural Earth', 'パブリックドメイン'],
  ['EGM96 ジオイド', ''],
];

export function createSettingsPanel(ctx: UiContext) {
  const { game, audio } = ctx;
  const panel = createPanel({ title: '設定', className: 'settings' });
  const s: Settings = loadSettings();
  const vols: Volumes = loadVolumes();

  const persist = () => saveSettings(s);
  const group = (title: string, ...kids: (Node | null)[]) =>
    h('section', { class: 'set-group' }, h('h3', { text: title }), ...kids);

  // --- quality
  const qBtns: Partial<Record<GraphicsQuality, HTMLButtonElement>> = {};
  const qualityRow = h('div', { class: 'wt-seg' });
  (Object.keys(QUALITY_LABEL) as GraphicsQuality[]).forEach((q) => {
    const b = h('button', { class: 'wt-chip', text: QUALITY_LABEL[q], onclick: () => { s.quality = q; game.setQuality(q); persist(); renderQ(); } });
    qBtns[q] = b;
    qualityRow.append(b);
  });
  const renderQ = () => (Object.keys(qBtns) as GraphicsQuality[]).forEach((q) => qBtns[q]!.classList.toggle('on', q === s.quality));

  // --- time
  const timeVal = h('span', { class: 'set-val' });
  const slider = h('input', { type: 'range', min: '0', max: '24', step: '0.25', 'aria-label': '時刻' }) as HTMLInputElement;
  const realTime = h('input', { type: 'checkbox', id: 'set-realtime' }) as HTMLInputElement;
  const fmtH = (v: number) => `${pad2(Math.floor(v) % 24)}:${pad2(Math.round((v % 1) * 60) % 60)}`;
  const renderTime = () => {
    realTime.checked = s.timeOverride == null;
    slider.disabled = s.timeOverride == null;
    if (s.timeOverride != null) slider.value = String(s.timeOverride);
    timeVal.textContent = s.timeOverride == null ? '現地時刻' : fmtH(s.timeOverride);
  };
  realTime.addEventListener('change', () => {
    s.timeOverride = realTime.checked ? null : Number(slider.value || 12);
    if (!realTime.checked && !slider.value) slider.value = '12';
    game.setTimeOverride(s.timeOverride);
    persist();
    renderTime();
  });
  slider.addEventListener('input', () => {
    s.timeOverride = Number(slider.value);
    game.setTimeOverride(s.timeOverride);
    renderTime();
  });
  slider.addEventListener('change', persist);

  // --- weather
  const realWx = h('input', { type: 'checkbox', id: 'set-realwx' }) as HTMLInputElement;
  const wxRow = h('div', { class: 'wt-seg wrap' });
  const wxBtns = new Map<WeatherKind, HTMLButtonElement>();
  WEATHERS.forEach((k) => {
    const b = h('button', { class: 'wt-chip', text: WEATHER_LABEL[k], onclick: () => { s.weatherOverride = k; game.setWeatherOverride(k); persist(); renderWx(); } });
    wxBtns.set(k, b);
    wxRow.append(b);
  });
  const renderWx = () => {
    realWx.checked = s.weatherOverride == null;
    wxBtns.forEach((b, k) => { b.classList.toggle('on', k === s.weatherOverride); b.disabled = s.weatherOverride == null; });
  };
  realWx.addEventListener('change', () => {
    s.weatherOverride = realWx.checked ? null : 'clear';
    game.setWeatherOverride(s.weatherOverride);
    persist();
    renderWx();
  });

  // --- road assist
  const road = h('input', { type: 'checkbox', id: 'set-road' }) as HTMLInputElement;
  road.addEventListener('change', () => { s.roadAssist = road.checked; game.setRoadAssist(road.checked); persist(); });

  // --- volumes
  const volRow = (key: keyof Volumes, label: string) => {
    const inp = h('input', { type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': label }) as HTMLInputElement;
    inp.value = String(vols[key]);
    inp.addEventListener('input', () => { vols[key] = Number(inp.value); audio.setVolumes({ [key]: vols[key] }); });
    inp.addEventListener('change', () => saveVolumes(vols));
    return h('label', { class: 'set-row' }, h('span', { text: label }), inp);
  };

  const li = (t: string) => h('li', { text: t });
  const help = h(
    'div', { class: 'set-help' },
    h('h4', { text: 'キーボード: 車' }),
    h('ul', {}, li('W/↑ アクセル　S/↓ ブレーキ・後退　A/D 操舵　Space ホーン')),
    h('h4', { text: 'キーボード: 徒歩' }),
    h('ul', {}, li('WASD 移動　Shift で走る　ドラッグで視線')),
    h('h4', { text: 'キーボード: 飛行機' }),
    h('ul', {},
      li('Shift/R 推力+　Ctrl/F 推力−'),
      li('↑/W 機首下げ　↓/S 機首上げ　←→ ロール'),
      li('Q/E ラダー　B ブレーキ　G ギア')),
    h('h4', { text: '共通' }),
    h('ul', {},
      li('V 視点　1/2/3 車/徒歩/飛行機　M 地図　H UI非表示'),
      li('ドラッグでカメラ　ホイールで距離　Esc でパネルを閉じる')),
    h('h4', { text: 'タッチ' }),
    h('ul', {}, li('左スティックで移動　右ペダルでアクセル/ブレーキ　画面ドラッグでカメラ')),
  );

  const credits = h('ul', { class: 'set-credits' });
  CREDITS.forEach(([n, l]) => credits.append(h('li', {}, h('b', { text: n }), l ? ` — ${l}` : '')));

  panel.body.append(
    group('グラフィック品質', qualityRow),
    group('時刻', h('label', { class: 'set-row', for: 'set-realtime' }, h('span', { text: 'リアルタイム(現地時刻)' }), realTime), h('label', { class: 'set-row' }, slider, timeVal)),
    group('天気', h('label', { class: 'set-row', for: 'set-realwx' }, h('span', { text: 'リアル天気' }), realWx), wxRow),
    group('走行', h('label', { class: 'set-row', for: 'set-road' }, h('span', { text: '道路アシスト: 道路に沿って走る' }), road)),
    group('音量', volRow('master', '全体'), volRow('music', '音楽'), volRow('sfx', '効果音'), volRow('ambient', '環境音')),
    group('操作方法', help),
    group('データ・クレジット', credits),
  );

  // Apply saved settings at startup
  game.setQuality(s.quality);
  game.setRoadAssist(s.roadAssist);
  game.setTimeOverride(s.timeOverride);
  game.setWeatherOverride(s.weatherOverride);
  audio.setVolumes(vols);
  road.checked = s.roadAssist;
  renderQ(); renderTime(); renderWx();

  return panel;
}
