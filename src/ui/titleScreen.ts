import { CITIES, type CityDef } from '../data/cities';
import { flagEmoji } from '../services/geo';
import { loadLastPosition } from '../store/storage';
import { h } from './dom';
import { lockInput } from './panels';
import type { UiContext } from './ctx';

export interface TitleScreen {
  show(): void;
  hide(): void;
}

export function createTitleScreen(root: HTMLElement, ctx: UiContext): TitleScreen {
  let starting = false;

  const begin = async (fn: () => Promise<void>) => {
    if (starting) return;
    starting = true;
    try {
      await ctx.audio.unlock(); // must run inside the user gesture
    } catch { /* audio is optional */ }
    ctx.audio.playSfx('click');
    hide();
    try {
      await fn();
    } catch {
      ctx.toast('移動に失敗しました');
    } finally {
      starting = false;
    }
  };

  const cityCard = (c: CityDef) =>
    h('button', { class: 'ts-card', onclick: () => void begin(() => ctx.travel({ ...c.start })) },
      h('div', { class: 'ts-head' },
        h('span', { class: 'ts-flag', text: flagEmoji(c.country) }),
        h('div', { class: 'ts-name' }, h('b', { text: c.name }), h('small', { text: `${c.nameLocal} ・ ${c.countryJa}` })),
        h('span', { class: `tier tier-${c.tier}`, text: c.tier })),
      h('p', { class: 'ts-blurb', text: c.blurb }),
      h('p', { class: 'ts-note', text: `データ: ${c.dataNote}` }));

  const group = (title: string, list: CityDef[]) =>
    h('div', { class: 'ts-group' }, h('h3', { class: 'ts-group-h', text: title }), h('div', { class: 'ts-grid' }, ...list.map(cityCard)));
  const cities = h('section', { class: 'ts-cities' }, h('h2', { text: '行き先を選ぶ' }),
    group('🌍 海外', CITIES.filter((c) => c.country !== 'JP')),
    group('🗾 日本', CITIES.filter((c) => c.country === 'JP')),
    h('p', { class: 'ts-legend', text: 'S: 実写テクスチャ付き3D都市 / A: 建物3D+航空写真 / B: OSM建物+衛星画像。地図データの精度は地域により異なります。' }));

  const last = loadLastPosition();
  const buttons = h('div', { class: 'ts-buttons' },
    h('button', { class: 'wt-btn wt-btn-accent big', text: 'ここから旅を始める', onclick: () => cities.scrollIntoView({ behavior: 'smooth', block: 'start' }) }),
    last ? h('button', { class: 'wt-btn big', text: '前回の続きから', onclick: () => void begin(() => ctx.travel({ ...last })) }) : null);

  const el = h('div', { class: 'title-screen' },
    h('div', { class: 'ts-inner' },
      h('header', { class: 'ts-hero' },
        h('h1', { text: '世界旅行3D' }),
        h('p', { class: 'ts-tag', text: '東京の街角から、アルプスの谷、ニューヨークの摩天楼まで。車で、徒歩で、飛行機で、ブラウザの中の地球を自由に旅しよう。' }),
        buttons),
      cities,
      h('footer', { class: 'ts-foot', text: '3D地形・建物・航空写真は各国のオープンデータを使用しています。詳細は 設定 > データ・クレジット' })));
  root.append(el);

  function hide() {
    el.classList.add('gone');
    lockInput('title', false);
    setTimeout(() => { el.style.display = 'none'; }, 500);
  }
  function show() {
    el.style.display = '';
    requestAnimationFrame(() => el.classList.remove('gone'));
    lockInput('title', true);
  }
  lockInput('title', true);
  return { show, hide };
}
