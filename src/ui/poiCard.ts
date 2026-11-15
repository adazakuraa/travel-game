import { CATEGORY_ICONS, CATEGORY_LABELS } from '../data/pois';
import type { Poi } from '../types';
import { fetchSummary } from '../services/wiki';
import { haversine } from '../services/geo';
import { favourites } from './favourites';
import { recordsStore } from './tracker';
import { clear, fmtDist, h } from './dom';
import { createPanel } from './panels';
import type { CardSubject, UiContext } from './ctx';

export function poiToSubject(poi: Poi): CardSubject {
  return {
    id: poi.id,
    kind: 'poi',
    name: poi.name,
    nameLocal: poi.nameLocal,
    categoryLabel: CATEGORY_LABELS[poi.category] ?? poi.category,
    icon: CATEGORY_ICONS[poi.category] ?? '📍',
    lat: poi.lat,
    lon: poi.lon,
    heading: poi.heading,
    summary: poi.summary,
    history: poi.history,
    culture: poi.culture,
    trivia: poi.trivia,
    wikiJa: poi.wikiJa,
    wikiEn: poi.wikiEn,
    poi,
  };
}

export function createPoiCard(ctx: UiContext) {
  let seq = 0;
  const panel = createPanel({ title: '', className: 'poi-card' });

  function open(s: CardSubject): void {
    const my = ++seq;
    panel.setTitle(s.name);
    clear(panel.body);
    if (s.poi) recordsStore.markPoi(s.poi);

    const photo = h('div', { class: 'poi-photo loading' });
    const img = h('img', { alt: s.name, loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => { photo.classList.remove('loading'); photo.classList.add('ok'); });
    img.addEventListener('error', () => photo.remove());
    photo.append(img);

    const dist = haversine(ctx.game.getPlayer().lat, ctx.game.getPlayer().lon, s.lat, s.lon);
    const meta = h(
      'div', { class: 'poi-meta' },
      h('span', { class: 'wt-chip on', text: `${s.icon} ${s.categoryLabel}` }),
      s.nameLocal ? h('span', { class: 'poi-local', text: s.nameLocal }) : null,
      h('span', { class: 'poi-dist', text: `現在地から ${fmtDist(dist)}` }),
    );

    const summaryEl = h('p', { class: 'poi-summary', text: s.summary ?? '' });
    const wikiLink = h('a', { class: 'poi-link', target: '_blank', rel: 'noopener noreferrer', text: 'Wikipedia で読む ↗' });
    wikiLink.style.display = 'none';
    const credit = h('p', { class: 'poi-credit' }, '写真・出典: Wikipedia/Wikimedia Commons (CC BY-SA) ', wikiLink);
    credit.style.display = 'none';

    const sections: HTMLElement[] = [];
    const sec = (label: string, text?: string, open = false) => {
      if (!text) return;
      const d = h('details', { class: 'poi-sec' }, h('summary', { text: label }), h('p', { text }));
      if (open) d.setAttribute('open', '');
      sections.push(d);
    };
    sec('🏛 歴史', s.history);
    sec('🎎 文化・見どころ', s.culture);
    sec('💡 豆知識', s.trivia);

    const favBtn = h('button', { class: 'wt-btn' });
    const syncFav = () => { favBtn.textContent = favourites.has(s.id) ? '★ お気に入り済み' : '☆ お気に入り'; favBtn.classList.toggle('on', favourites.has(s.id)); };
    syncFav();
    favBtn.addEventListener('click', () => {
      if (favourites.has(s.id)) favourites.remove(s.id);
      else favourites.add({ id: s.id, kind: s.kind, name: s.name, lat: s.lat, lon: s.lon, heading: s.heading, mode: 'walk', poiId: s.poi?.id });
      syncFav();
    });

    const go = h('button', {
      class: 'wt-btn wt-btn-accent',
      text: '📍 ここへ移動',
      onclick: () => {
        panel.close();
        void ctx.travel({ lat: s.lat, lon: s.lon, heading: s.heading ?? 0, mode: 'walk' });
      },
    });

    panel.body.append(photo, meta, summaryEl, ...sections, h('div', { class: 'poi-actions' }, go, favBtn), credit);
    panel.open();
    panel.body.scrollTop = 0;

    void fetchSummary(s.wikiJa, s.wikiEn).then((w) => {
      if (my !== seq || !w) return;
      const src = w.image ?? w.thumbnail;
      if (src) img.src = w.thumbnail && window.innerWidth < 600 ? w.thumbnail : src;
      else photo.remove();
      wikiLink.href = w.pageUrl;
      wikiLink.style.display = '';
      credit.style.display = '';
      if (!s.summary) summaryEl.textContent = w.extract;
      else if (s.kind === 'wiki') summaryEl.textContent = w.extract;
    });
    if (!s.wikiJa && !s.wikiEn) photo.remove();
  }

  return { open, close: () => panel.close() };
}
