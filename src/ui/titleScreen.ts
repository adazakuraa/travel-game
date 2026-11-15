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
    h('button', { class: 'tc-card', onclick: () => void begin(() => ctx.travel({ ...c.start })) },
      h('div', { class: 'tc-head' },
        h('span', { class: 'tc-flag', text: flagEmoji(c.country) }),
        h('div', { class: 'tc-name' }, h('b', { text: c.name }), h('small', { text: `${c.nameLocal} ・ ${c.countryJa}` })),
        h('span', { class: `tier tier-${c.tier}`, text: c.tier })),
      h('p', { class: 'tc-blurb', text: c.blurb }),
      h('p', { class: 'tc-note', text: `データ: ${c.dataNote}` }));

  const grid = h('div', { class: 'tc-grid' }, ...CITIES.map(cityCard));
  const cities = h('section', { class: 'tc-cities' }, h('h2', { text: '行き先を選ぶ' }), grid,
    h('p', { class: 'tc-legend', text: 'S: 実写テクスチャ付き3D都市 / A: 建物3D+航空写真 / B: OSM建物+衛星画像。地図データの精度は地域により異なります。' }));

  const last = loadLastPosition();
  const buttons = h('div', { class: 'tc-buttons' },
    h('button', { class: 'wt-btn wt-btn-accent big', text: 'ここから旅を始める', onclick: () => cities.scrollIntoView({ behavior: 'smooth', block: 'start' }) }),
    last ? h('button', { class: 'wt-btn big', text: '現在の続きから', onclick: () => void begin(() => ctx.travel({ ...last })) }) : null);

  const el = h('div', { class: 'title-screen' },
    h('div', { class: 'tc-inner' },
      h('header', { class: 'tc-hero' },
        h('h1', { text: '世界旅行3D' }),
        h('p', { class: 'tc-tag', text: '東京の街角から、アルプスの谷、ニューヨークの摩天楼まで。車で、徒歩で、飛行機で、ブラウザの中の地球を自由に旅しよう。' }),
        buttons),
      cities,
      h('footer', { class: 'tc-foot', text: '3D地形・建物・航空写真は各国のオープンデータを使用しています。詳細は 設定 > データ・クレジット' })));
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
