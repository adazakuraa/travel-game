// Cesium must know where its static assets (workers, etc.) are served from.
(window as any).CESIUM_BASE_URL = new URL('./cesium/', document.baseURI).href;

import './game/controls.css';
import { createAudio } from './audio';
import { Game } from './game/game';
import { initUI } from './ui';
import { loadGeoid } from './world/geoid';

async function main() {
  const container = document.getElementById('cesium')!;
  const uiRoot = document.getElementById('ui')!;
  const audio = createAudio();
  await loadGeoid();
  const game = new Game(container, uiRoot, audio);
  try {
    await game.init();
  } catch (e) {
    console.error(e);
    uiRoot.innerHTML =
      '<div class="fatal">3D表示を初期化できませんでした。WebGL2 に対応したブラウザ(Safari / Chrome 最新版)でお試しください。</div>';
    return;
  }
  const ui = initUI({ root: uiRoot, game, audio });
  game.on('status', (s) => ui.showToast(s.message));
  (window as any).__game = game; // debugging / automated tests
}

void main();
