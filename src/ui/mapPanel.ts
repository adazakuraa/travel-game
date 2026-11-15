import 'maplibre-gl/dist/maplibre-gl.css';
// bundle the MapLibre worker explicitly so it also works under vite dev pre-bundling
import mlWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Map as MlMap, Marker, Popup } from 'maplibre-gl';
import type { PoiCategory } from '../types';
import { CITIES } from '../data/cities';
import { CATEGORY_ICONS, CATEGORY_LABELS, POIS } from '../data/pois';
import { flagEmoji, haversine, loadCountriesGeoJSON } from '../services/geo';
import { geosearch, type WikiNearby } from '../services/wiki';
import { recordsStore } from './tracker';
import { clear, fmtDist, h } from './dom';
import { createPanel } from './panels';
import type { CardSubject, UiContext } from './ctx';

type MlModule = typeof import('maplibre-gl');
type Tab = 'cities' | 'pois' | 'nearby';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const CATS = Object.keys(CATEGORY_LABELS) as PoiCategory[];

export function createMapPanel(ctx: UiContext) {
  const { game } = ctx;
  let ml: MlModule | null = null;
  let map: MlMap | null = null;
  let ready = false;
  let visitedMode = false;
  let tab: Tab = 'cities';
  let query = '';
  const activeCats = new Set<PoiCategory>();
  let playerMarker: Marker | null = null;
  let popup: Popup | null = null;
  const poiMarkers = new Map<string, HTMLElement>();
  const cityMarkers: HTMLElement[] = [];
  let wikiItems: WikiNearby[] = [];
  let wikiState: 'idle' | 'loading' | 'done' = 'idle';
  let wikiAt: { lat: number; lon: number } | null = null;
  let lastHeading = 0;

  const panel = createPanel({
    title: '地図',
    className: 'map-panel',
    onOpen: () => void onOpen(),
    onClose: () => popup?.remove(),
  });

  // ---------- layout
  const mapEl = h('div', { class: 'mp-map' });
  const visitedBtn = h('button', { class: 'wt-chip mp-visited', text: '🌍 訪問記録マップ', onclick: () => setVisited(!visitedMode) });
  const locBtn = h('button', { class: 'wt-chip mp-loc', text: '◎ 現在地', onclick: () => centerOnPlayer(true) });
  const mapWrap = h('div', { class: 'mp-mapwrap' }, mapEl, h('div', { class: 'mp-overlay' }, visitedBtn, locBtn));
  const search = h('input', { class: 'wt-input', type: 'search', placeholder: '名前・都市で検索', 'aria-label': '検索' }) as HTMLInputElement;
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); applyFilters(); renderList(); });
  const tabsEl = h('div', { class: 'wt-tabs' });
  const chipsEl = h('div', { class: 'wt-chips' });
  const listEl = h('div', { class: 'mp-list' });
  const handle = h('button', { class: 'mp-handle', 'aria-label': '一覧を広げる/縮める', onclick: () => side.classList.toggle('expanded') });
  const side = h('div', { class: 'mp-side' }, handle, search, tabsEl, chipsEl, listEl);
  search.addEventListener('focus', () => side.classList.add('expanded'));
  panel.body.append(h('div', { class: 'mp-layout' }, mapWrap, side));

  // ---------- helpers
  const player = () => game.getPlayer();
  const cityName = (id: string) => CITIES.find((c) => c.id === id);

  function matchPoi(p: (typeof POIS)[number]): boolean {
    if (activeCats.size && !activeCats.has(p.category)) return false;
    if (!query) return true;
    const c = cityName(p.cityId);
    return [p.name, p.nameLocal ?? '', c?.name ?? '', c?.nameLocal ?? ''].some((t) => t.toLowerCase().includes(query));
  }

  function applyFilters(): void {
    for (const p of POIS) poiMarkers.get(p.id)?.classList.toggle('filtered', !matchPoi(p));
  }

  function flyTo(lat: number, lon: number, zoom?: number): void {
    map?.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 13), essential: true });
  }

  function centerOnPlayer(animate: boolean): void {
    if (!map) return;
    const p = player();
    if (animate) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 12) });
    else map.jumpTo({ center: [p.lon, p.lat], zoom: 12 });
  }

  function poiSubject(p: (typeof POIS)[number]): void { ctx.openPoi(p); }

  function wikiSubject(w: WikiNearby): CardSubject {
    return {
      id: `wiki:${w.lang}:${w.title}`,
      kind: 'wiki',
      name: w.title,
      categoryLabel: CATEGORY_LABELS.landmark,
      icon: CATEGORY_ICONS.landmark,
      lat: w.lat,
      lon: w.lon,
      wikiJa: w.lang === 'ja' ? w.title : undefined,
      wikiEn: w.lang === 'en' ? w.title : undefined,
    };
  }

  // ---------- lists
  function renderTabs(): void {
    clear(tabsEl);
    ([['cities', '都市'], ['pois', '観光地'], ['nearby', '周辺']] as const).forEach(([k, l]) =>
      tabsEl.append(h('button', { class: `wt-tab${tab === k ? ' on' : ''}`, text: l, onclick: () => { tab = k; renderTabs(); renderList(); if (k === 'nearby') void loadNearby(); } })),
    );
    clear(chipsEl);
    chipsEl.style.display = tab === 'pois' ? '' : 'none';
    for (const c of CATS) {
      chipsEl.append(h('button', {
        class: `wt-chip${activeCats.has(c) ? ' on' : ''}`,
        text: `${CATEGORY_ICONS[c]} ${CATEGORY_LABELS[c]}`,
        onclick: () => { if (activeCats.has(c)) activeCats.delete(c); else activeCats.add(c); renderTabs(); applyFilters(); renderList(); },
      }));
    }
  }

  const row = (icon: string, title: string, sub: string, onClick: () => void, action?: HTMLElement) =>
    h('div', { class: 'wt-item clickable', role: 'button', tabindex: '0', onclick: onClick, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') onClick(); } },
      h('span', { class: 'wt-item-ic', text: icon }),
      h('div', { class: 'wt-item-main' }, h('span', { text: title }), sub ? h('small', { text: sub }) : null),
      action ?? null);

  const goBtn = (t: { lat: number; lon: number; heading?: number }) =>
    h('button', { class: 'wt-btn wt-btn-small wt-btn-accent', text: '移動', onclick: (e: Event) => { e.stopPropagation(); void go({ lat: t.lat, lon: t.lon, heading: t.heading ?? 0, mode: 'walk' }); } });

  function renderList(): void {
    clear(listEl);
    const p = player();
    if (tab === 'cities') {
      const items = CITIES.filter((c) => !query || [c.name, c.nameLocal, c.countryJa].some((t) => t.toLowerCase().includes(query)));
      for (const c of items) {
        const visited = !!recordsStore.get().cities[c.id];
        listEl.append(row(flagEmoji(c.country), c.name, `${c.countryJa} ・ ${c.nameLocal}${visited ? ' ・ 訪問済み' : ''}`,
          () => flyTo(c.start.lat, c.start.lon, 11),
          h('span', { class: 'wt-inline' }, h('span', { class: `tier tier-${c.tier}`, text: c.tier }), goBtn({ ...c.start }))));
      }
      if (!items.length) listEl.append(h('p', { class: 'wt-empty', text: '見つかりません' }));
    } else if (tab === 'pois') {
      const items = POIS.filter(matchPoi).map((x) => ({ x, d: haversine(p.lat, p.lon, x.lat, x.lon) })).sort((a, b) => a.d - b.d);
      for (const { x, d } of items.slice(0, 200)) {
        listEl.append(row(CATEGORY_ICONS[x.category], x.name, `${cityName(x.cityId)?.name ?? ''} ・ ${fmtDist(d)}`, () => { flyTo(x.lat, x.lon, 15); poiSubject(x); }, goBtn(x)));
      }
      if (!items.length) listEl.append(h('p', { class: 'wt-empty', text: '見つかりません' }));
    } else {
      const near = POIS.map((x) => ({ x, d: haversine(p.lat, p.lon, x.lat, x.lon) })).filter((e) => e.d <= 30000 && matchPoi(e.x)).sort((a, b) => a.d - b.d);
      listEl.append(h('div', { class: 'mp-sub' }, h('b', { text: '周辺の観光地 (30km以内)' }), h('button', { class: 'wt-btn wt-btn-small', text: '↻ 更新', onclick: () => void loadNearby(true) })));
      for (const { x, d } of near) listEl.append(row(CATEGORY_ICONS[x.category], x.name, fmtDist(d), () => { flyTo(x.lat, x.lon, 15); poiSubject(x); }, goBtn(x)));
      if (!near.length) listEl.append(h('p', { class: 'wt-empty', text: '30km圏内に登録された観光地はありません' }));
      listEl.append(h('div', { class: 'mp-sub' }, h('b', { text: 'Wikipedia: 周辺のスポット (10km以内)' })));
      if (wikiState === 'loading') listEl.append(h('p', { class: 'wt-empty', text: '検索中…' }));
      const known = new Set(POIS.flatMap((x) => [x.wikiJa, x.wikiEn, x.name].filter(Boolean) as string[]));
      const items = wikiItems.filter((w) => !known.has(w.title)).map((w) => ({ w, d: haversine(p.lat, p.lon, w.lat, w.lon) })).sort((a, b) => a.d - b.d);
      for (const { w, d } of items) listEl.append(row(CATEGORY_ICONS.landmark, w.title, fmtDist(d), () => { flyTo(w.lat, w.lon, 15); ctx.openCard(wikiSubject(w)); }, goBtn(w)));
      if (wikiState === 'done' && !items.length) listEl.append(h('p', { class: 'wt-empty', text: 'Wikipediaの記事が見つかりませんでした' }));
    }
  }

  async function loadNearby(force = false): Promise<void> {
    const p = player();
    if (!force && wikiAt && haversine(wikiAt.lat, wikiAt.lon, p.lat, p.lon) < 800 && wikiState !== 'idle') return;
    wikiAt = { lat: p.lat, lon: p.lon };
    wikiState = 'loading';
    if (tab === 'nearby') renderList();
    try { wikiItems = await geosearch(p.lat, p.lon, 10000, 30); } catch { wikiItems = []; }
    wikiState = 'done';
    if (tab === 'nearby' && panel.isOpen()) renderList();
  }

  async function go(t: { lat: number; lon: number; heading?: number; mode?: 'car' | 'walk' | 'plane' }): Promise<void> {
    popup?.remove();
    panel.close();
    await ctx.travel(t);
  }

  // ---------- map
  function markerEl(cls: string, text: string, title: string, onClick: () => void): HTMLElement {
    const el = h('div', { class: cls, title, text });
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return el;
  }

  function visitedKeys(): string[] {
    const r = recordsStore.get();
    return Object.keys(r.countries);
  }

  function applyVisited(): void {
    if (!map || !ready) return;
    const vis = visitedMode ? 'visible' : 'none';
    for (const id of ['visited-fill', 'visited-line', 'visited-cities']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    mapEl.classList.toggle('visited-mode', visitedMode);
    visitedBtn.classList.toggle('on', visitedMode);
    refreshVisitedData();
  }

  function refreshVisitedData(): void {
    if (!map || !ready) return;
    const keys = visitedKeys();
    if (map.getLayer('visited-fill')) {
      map.setFilter('visited-fill', ['any', ['in', ['get', 'iso'], ['literal', keys]], ['in', ['get', 'name'], ['literal', keys]]]);
    }
    const src = map.getSource('visited-cities-src') as { setData?: (d: unknown) => void } | undefined;
    const r = recordsStore.get();
    src?.setData?.({
      type: 'FeatureCollection',
      features: CITIES.filter((c) => r.cities[c.id]).map((c) => ({ type: 'Feature', properties: { name: c.name }, geometry: { type: 'Point', coordinates: [c.start.lon, c.start.lat] } })),
    });
  }

  function setVisited(on: boolean): void {
    visitedMode = on;
    applyVisited();
    if (on) map?.flyTo({ center: [player().lon, player().lat], zoom: 1.6 });
  }

  let mapPromise: Promise<void> | null = null;
  function ensureMap(): Promise<void> {
    mapPromise ??= buildMap().catch((e) => { mapPromise = null; throw e; });
    return mapPromise;
  }

  async function buildMap(): Promise<void> {
    ml = await import('maplibre-gl');
    try { ml.setWorkerUrl(mlWorkerUrl); } catch { /* keep default worker */ }
    const p = player();
    map = new ml.Map({
      container: mapEl,
      style: STYLE_URL,
      center: [p.lon, p.lat],
      zoom: 12,
      attributionControl: { compact: false },
    });
    map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
    const m = map;

    // markers
    const pe = h('div', { class: 'mk-player' }, h('i'));
    playerMarker = new ml.Marker({ element: pe, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([p.lon, p.lat]).setRotation(p.heading).addTo(m);
    for (const poi of POIS) {
      const el = markerEl('mk mk-poi', CATEGORY_ICONS[poi.category], poi.name, () => poiSubject(poi));
      poiMarkers.set(poi.id, el);
      new ml.Marker({ element: el }).setLngLat([poi.lon, poi.lat]).addTo(m);
    }
    for (const c of CITIES) {
      const el = markerEl('mk mk-city', c.name, `${c.name} (${c.countryJa})`, () => flyTo(c.start.lat, c.start.lon, 11));
      cityMarkers.push(el);
      new ml.Marker({ element: el }).setLngLat([c.start.lon, c.start.lat]).addTo(m);
    }
    const zoomClass = () => { const z = m.getZoom(); mapEl.classList.toggle('z-far', z < 7.5); };
    m.on('zoom', zoomClass);
    zoomClass();
    applyFilters();

    m.on('click', (e) => {
      popup?.remove();
      const { lat, lng } = e.lngLat;
      const box = h('div', { class: 'mp-pop' },
        h('div', { class: 'mp-pop-t', text: `${lat.toFixed(4)}, ${lng.toFixed(4)}` }),
        h('button', { class: 'wt-btn wt-btn-small wt-btn-accent', text: '📍 ここへ移動', onclick: () => void go({ lat, lon: lng, heading: lastHeading, mode: 'walk' }) }));
      popup = new ml!.Popup({ closeButton: true, offset: 8, maxWidth: '240px' }).setLngLat(e.lngLat).setDOMContent(box).addTo(m);
    });

    m.once('style.load', async () => {
      const gj = await loadCountriesGeoJSON();
      if (gj) {
        m.addSource('countries', { type: 'geojson', data: gj });
        m.addLayer({ id: 'visited-fill', type: 'fill', source: 'countries', filter: ['==', ['get', 'iso'], '__none__'], paint: { 'fill-color': '#1fd1bd', 'fill-opacity': 0.7 }, layout: { visibility: 'none' } });
        m.addLayer({ id: 'visited-line', type: 'line', source: 'countries', paint: { 'line-color': '#ffffff', 'line-width': 0.8, 'line-opacity': 0.8 }, layout: { visibility: 'none' } });
      }
      m.addSource('visited-cities-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'visited-cities', type: 'circle', source: 'visited-cities-src', paint: { 'circle-radius': 6, 'circle-color': '#ffd166', 'circle-stroke-color': '#222', 'circle-stroke-width': 2 }, layout: { visibility: 'none' } });
      ready = true;
      applyVisited();
    });
    m.on('error', () => { /* tile / style fetch failures are non-fatal */ });
  }

  async function onOpen(): Promise<void> {
    renderTabs();
    renderList();
    try {
      await ensureMap();
    } catch {
      ctx.toast('地図ライブラリの読み込みに失敗しました');
      return;
    }
    requestAnimationFrame(() => {
      map?.resize();
      if (!visitedMode) centerOnPlayer(false);
    });
    if (tab === 'nearby') void loadNearby();
  }

  game.on('position', (p) => {
    lastHeading = p.heading;
    if (!map || !playerMarker) return;
    playerMarker.setLngLat([p.lon, p.lat]).setRotation(p.heading);
  });
  recordsStore.subscribe(() => { if (panel.isOpen()) refreshVisitedData(); });

  return {
    open(opts?: { visited?: boolean }) {
      if (opts?.visited !== undefined) visitedMode = opts.visited;
      panel.open();
      void ensureMap().then(() => { applyVisited(); if (visitedMode) setVisited(true); }).catch(() => undefined);
    },
    toggle() { if (panel.isOpen()) panel.close(); else this.open(); },
    isOpen: () => panel.isOpen(),
  };
}
