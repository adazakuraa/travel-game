import { CITIES } from '../data/cities';
import { POIS } from '../data/pois';
import { flagEmoji } from '../services/geo';
import { clear, fmtDist, h } from './dom';
import { createPanel } from './panels';
import { favourites } from './favourites';
import { recordsStore } from './tracker';
import type { UiContext } from './ctx';

export function createRecordsPanel(ctx: UiContext) {
  const panel = createPanel({ title: 'お気に入り・訪問記録', className: 'records', onOpen: () => render() });
  let tab: 'fav' | 'records' = 'fav';
  const tabs = h('div', { class: 'wt-tabs' });
  const content = h('div', { class: 'rec-content' });
  panel.body.append(tabs, content);

  const render = () => {
    clear(tabs);
    ([['fav', '⭐ お気に入り'], ['records', '📊 訪問記録']] as const).forEach(([k, l]) =>
      tabs.append(h('button', { class: `wt-tab${tab === k ? ' on' : ''}`, text: l, onclick: () => { tab = k; render(); } })),
    );
    clear(content);
    if (tab === 'fav') renderFav(); else renderRecords();
  };

  function renderFav() {
    const nameInp = h('input', { class: 'wt-input', type: 'text', maxlength: '40', placeholder: '現在地の名前', 'aria-label': '現在地の名前' }) as HTMLInputElement;
    const save = () => {
      const p = ctx.game.getPlayer();
      const name = nameInp.value.trim() || `保存した場所 ${new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      favourites.add({ id: `place:${Date.now()}`, kind: 'place', name, lat: p.lat, lon: p.lon, heading: p.heading, mode: p.mode });
      ctx.toast('現在地を保存しました');
      nameInp.value = '';
    };
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    content.append(h('div', { class: 'rec-save' }, nameInp, h('button', { class: 'wt-btn wt-btn-accent', text: '現在地を保存', onclick: save })));

    const list = favourites.all();
    if (!list.length) {
      content.append(h('p', { class: 'wt-empty', text: 'まだお気に入りがありません。観光地カードの「☆お気に入り」や現在地の保存で追加できます。' }));
      return;
    }
    const ul = h('ul', { class: 'wt-list' });
    for (const f of list) {
      const nameEl = h('input', { class: 'wt-input inline', type: 'text', value: f.name, maxlength: '40', 'aria-label': '名前' }) as HTMLInputElement;
      nameEl.addEventListener('change', () => favourites.rename(f.id, nameEl.value.trim() || f.name));
      nameEl.addEventListener('click', (e) => e.stopPropagation());
      ul.append(
        h('li', { class: 'wt-item' },
          h('span', { class: 'wt-item-ic', text: f.kind === 'place' ? '📌' : '⭐' }),
          h('div', { class: 'wt-item-main' }, nameEl, h('small', { text: `${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}` })),
          h('button', { class: 'wt-btn wt-btn-small wt-btn-accent', text: '移動', onclick: () => { panel.close(); void ctx.travel({ lat: f.lat, lon: f.lon, heading: f.heading ?? 0, mode: f.mode ?? 'walk' }); } }),
          h('button', { class: 'wt-icon-btn small', 'aria-label': '削除', text: '🗑', onclick: () => { favourites.remove(f.id); render(); } }),
        ),
      );
    }
    content.append(ul);
  }

  function renderRecords() {
    const r = recordsStore.get();
    const countries = Object.entries(r.countries);
    const cities = CITIES.filter((c) => r.cities[c.id]);
    const pois = POIS.filter((p) => r.pois[p.id]);
    const stat = (v: string, l: string) => h('div', { class: 'stat' }, h('b', { text: v }), h('span', { text: l }));
    const total = r.distance.car + r.distance.walk + r.distance.plane;

    content.append(
      h('div', { class: 'stats' },
        stat(String(countries.length), '訪問した国'),
        stat(`${cities.length}/${CITIES.length}`, '訪問した都市'),
        stat(`${pois.length}/${POIS.length}`, '訪れた観光地'),
        stat(fmtDist(total), '総移動距離'),
      ),
      h('div', { class: 'stats small' },
        stat(`🚗 ${fmtDist(r.distance.car)}`, 'ドライブ'),
        stat(`🚶 ${fmtDist(r.distance.walk)}`, '徒歩'),
        stat(`✈️ ${fmtDist(r.distance.plane)}`, '飛行'),
      ),
      h('button', { class: 'wt-btn', text: '🗺 訪問記録マップを見る', onclick: () => { panel.close(); ctx.openMap({ visited: true }); } }),
    );

    const section = (title: string, items: HTMLElement[]) => {
      content.append(h('h3', { class: 'rec-h', text: title }));
      content.append(items.length ? h('ul', { class: 'wt-list compact' }, ...items) : h('p', { class: 'wt-empty', text: 'まだありません' }));
    };
    section('国', countries.sort((a, b) => a[1].at - b[1].at).map(([iso, c]) =>
      h('li', { class: 'wt-item' }, h('span', { class: 'wt-item-ic', text: flagEmoji(iso) }), h('div', { class: 'wt-item-main' }, h('span', { text: c.nameJa || c.name })))));
    section('都市', cities.map((c) =>
      h('li', { class: 'wt-item' }, h('span', { class: 'wt-item-ic', text: flagEmoji(c.country) }), h('div', { class: 'wt-item-main' }, h('span', { text: c.name }), h('small', { text: c.countryJa })))));
    section('観光地', pois.map((p) =>
      h('li', { class: 'wt-item clickable', onclick: () => ctx.openPoi(p) }, h('span', { class: 'wt-item-ic', text: '📍' }), h('div', { class: 'wt-item-main' }, h('span', { text: p.name })))));

    const reset = h('button', { class: 'wt-btn danger', text: '記録をリセット' }) as HTMLButtonElement;
    reset.addEventListener('click', () => {
      if (reset.dataset.armed) {
        recordsStore.reset();
        render();
        ctx.toast('訪問記録をリセットしました');
      } else {
        reset.dataset.armed = '1';
        reset.textContent = '本当にリセットしますか? もう一度タップ';
        setTimeout(() => { delete reset.dataset.armed; reset.textContent = '記録をリセット'; }, 4000);
      }
    });
    content.append(h('div', { class: 'rec-reset' }, reset));
  }

  favourites.subscribe(() => { if (panel.isOpen() && tab === 'fav') render(); });
  let lastRec = 0;
  recordsStore.subscribe(() => {
    if (!panel.isOpen() || tab !== 'records' || Date.now() - lastRec < 3000) return;
    lastRec = Date.now();
    render();
  });

  return {
    open(t: 'fav' | 'records' = 'fav') { tab = t; panel.open(); render(); },
    panel,
  };
}
