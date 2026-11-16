import type { EnvironmentState, TravelMode, ViewMode, WeatherKind } from '../types';
import { CITIES } from '../data/cities';
import { countryAt } from '../services/geo';
import { h, pad2 } from './dom';
import type { UiContext } from './ctx';

const WEATHER_ICON: Record<WeatherKind, string> = {
  clear: '☀️', partly: '⛅', cloudy: '☁️', fog: '🌫️', rain: '🌧️', snow: '❄️', storm: '⛈️',
};
export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: '晴れ', partly: '晴れ時々曇り', cloudy: '曇り', fog: '霧', rain: '雨', snow: '雪', storm: '雷雨',
};

export interface Hud {
  el: HTMLElement;
  toggleHidden(): void;
}

export function createHud(root: HTMLElement, ctx: UiContext): Hud {
  const { game } = ctx;
  const placeName = h('div', { class: 'hud-place-name', text: '—' });
  const placeSub = h('div', { class: 'hud-place-sub' });
  const timeEl = h('span', { class: 'hud-time', text: '--:--' });
  const wxEl = h('span', { class: 'hud-wx', text: '' });
  const place = h('div', { class: 'hud-card hud-place' }, placeName, placeSub, h('div', { class: 'hud-place-row' }, timeEl, wxEl));

  const speedEl = h('span', { class: 'hud-speed-num', text: '0' });
  const altEl = h('span', { class: 'hud-alt', text: '' });
  const speed = h('div', { class: 'hud-speed' }, h('span', { class: 'hud-speed-box' }, speedEl, h('small', { text: ' km/h' })), altEl);

  const modeBtns = new Map<TravelMode, HTMLButtonElement>();
  const mk = (mode: TravelMode, icon: string, label: string) => {
    const b = h('button', { class: 'wt-icon-btn hud-mode', 'aria-label': label, title: label, text: icon, onclick: () => game.setMode(mode) });
    modeBtns.set(mode, b);
    return b;
  };
  const viewBtn = h('button', { class: 'wt-icon-btn hud-mode', 'aria-label': '視点切替', title: '視点切替 (V)', text: '👁', onclick: () => game.toggleView() });
  const modes = h('div', { class: 'hud-card hud-modes' }, mk('car', '🚗', '車 (1)'), mk('walk', '🚶', '徒歩 (2)'), mk('plane', '✈️', '飛行機 (3)'), viewBtn);

  const top = h(
    'div',
    { class: 'hud-card hud-top' },
    h('button', { class: 'wt-icon-btn', 'aria-label': '地図 (M)', title: '地図 (M)', text: '🗺', onclick: () => ctx.openMap() }),
    h('button', { class: 'wt-icon-btn', 'aria-label': 'お気に入り・記録', title: 'お気に入り・記録', text: '⭐', onclick: () => ctx.openRecords() }),
    h('button', { class: 'wt-icon-btn', 'aria-label': '設定', title: '設定', text: '⚙', onclick: () => ctx.openSettings() }),
  );

  const el = h('div', { class: 'hud' }, place, speed, modes, top);
  root.append(el);

  let cityId: string | null = null;
  let countryName = '';
  let lastCountryQuery = { lat: 999, lon: 999 };

  const renderPlace = () => {
    const c = CITIES.find((x) => x.id === cityId);
    placeName.textContent = c ? c.name : countryName || '旅の途中';
    placeSub.textContent = c ? c.countryJa : '';
  };

  const renderEnv = (e: EnvironmentState) => {
    const d = e.localWallClock;
    timeEl.textContent = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    const w = e.weather;
    const kind = e.weatherOverride ?? w.kind;
    const hour = d.getUTCHours();
    const night = hour < 5 || hour >= 19;
    const icon = night && kind === 'clear' ? '🌙' : night && kind === 'partly' ? '☁️' : WEATHER_ICON[kind] ?? '';
    const t = w.temperature != null && !e.weatherOverride ? ` ${Math.round(w.temperature)}°C` : '';
    wxEl.textContent = `${icon}${t}`;
    wxEl.title = WEATHER_LABEL[kind] ?? '';
  };

  const setMode = (mode: TravelMode, view: ViewMode) => {
    modeBtns.forEach((b, m) => b.classList.toggle('active', m === mode));
    viewBtn.classList.toggle('active', view === 'first');
    el.dataset.mode = mode;
  };

  game.on('city', (e) => { cityId = e.cityId; renderPlace(); });
  game.on('environment', renderEnv);
  game.on('mode', (e) => setMode(e.mode, e.view));
  game.on('position', (p) => {
    speedEl.textContent = String(Math.round(p.speed * 3.6));
    altEl.textContent = p.mode === 'plane' ? `高度 ${Math.round(p.agl).toLocaleString('ja-JP')} m` : '';
    if (Math.abs(p.lat - lastCountryQuery.lat) + Math.abs(p.lon - lastCountryQuery.lon) > 0.05) {
      lastCountryQuery = { lat: p.lat, lon: p.lon };
      countryAt(p.lat, p.lon).then((c) => {
        countryName = c?.nameJa ?? '';
        renderPlace();
      });
    }
  });

  try {
    const p = game.getPlayer();
    setMode(p.mode, p.view);
    renderEnv(game.getEnvironment());
  } catch { /* core not ready yet */ }
  // keep the clock ticking even if the core emits environment rarely
  setInterval(() => { try { renderEnv(game.getEnvironment()); } catch { /* ignore */ } }, 5000);

  return {
    el,
    toggleHidden() {
      const hidden = el.classList.toggle('hidden');
      ctx.toast(hidden ? 'HUDを隠しました (H で再表示)' : 'HUDを表示しました', { duration: 2200 });
    },
  };
}
