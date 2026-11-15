import './styles.css';
import type { AudioAPI, GameAPI, Poi } from '../types';
import { CATEGORY_ICONS } from '../data/pois';
import { startTracker } from './tracker';
import { initToast, initLoading, setLoading, toast } from './toast';
import { anyPanelOpen, initPanels } from './panels';
import { createHud } from './hud';
import { createPoiCard, poiToSubject } from './poiCard';
import { createMapPanel } from './mapPanel';
import { createRecordsPanel } from './recordsPanel';
import { createSettingsPanel } from './settingsPanel';
import { createTitleScreen } from './titleScreen';
import { isTypingTarget } from './dom';
import type { CardSubject, TeleportTarget, UiContext } from './ctx';

export function initUI(opts: { root: HTMLElement; game: GameAPI; audio: AudioAPI }): {
  showToast(msg: string): void;
  setLoading(active: boolean, label?: string): void;
} {
  const { root, game, audio } = opts;
  root.classList.add('wt-ui');
  initPanels(root, game);
  initToast(root);
  initLoading(root);

  // late-bound handles (panels reference each other through ctx)
  let card: ReturnType<typeof createPoiCard>;
  let map: ReturnType<typeof createMapPanel>;
  let records: ReturnType<typeof createRecordsPanel>;
  let settings: ReturnType<typeof createSettingsPanel>;

  const ctx: UiContext = {
    game,
    audio,
    toast,
    setLoading,
    async travel(t: TeleportTarget) {
      audio.playSfx('teleport');
      setLoading(true, '移動中…');
      try {
        await game.teleport(t);
      } catch {
        toast('移動に失敗しました');
      } finally {
        setLoading(false);
      }
    },
    openPoi: (poi: Poi) => card.open(poiToSubject(poi)),
    openCard: (s: CardSubject) => card.open(s),
    openMap: (o) => map.open(o),
    openRecords: (t) => records.open(t),
    openSettings: () => settings.open(),
  };

  startTracker(game, {
    onCountry: (c) => toast(`🌏 新しい国を訪問しました: ${c.nameJa || c.name}`),
    onCity: (c) => toast(`🏙 ${c.name} を訪問しました`),
  });

  settings = createSettingsPanel(ctx);
  card = createPoiCard(ctx);
  map = createMapPanel(ctx);
  records = createRecordsPanel(ctx);
  const hud = createHud(root, ctx);
  const title = createTitleScreen(root, ctx);

  game.on('status', (e) => toast(e.level === 'error' ? `⚠ ${e.message}` : e.message));
  game.on('loading', (e) => setLoading(e.active, e.label));
  game.on('poiNearby', ({ poi }) =>
    toast(`📍 ${poi.name} に到着 ${CATEGORY_ICONS[poi.category] ?? ''}`, { action: { label: '詳しく', onClick: () => card.open(poiToSubject(poi)) } }),
  );

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    if (document.querySelector('.title-screen:not(.gone)')) return;
    const k = e.key.toLowerCase();
    if (k === 'm') {
      e.preventDefault();
      if (map.isOpen()) map.toggle();
      else if (!anyPanelOpen()) map.open();
    } else if (k === 'h' && !anyPanelOpen()) {
      hud.toggleHidden();
    }
  });

  void title;
  return { showToast: (m) => toast(m), setLoading };
}
