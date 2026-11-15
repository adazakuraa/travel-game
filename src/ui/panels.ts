import type { GameAPI } from '../types';
import { h } from './dom';

export interface PanelOpts {
  title: string;
  className?: string;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface Panel {
  el: HTMLElement;
  body: HTMLElement;
  setTitle(t: string): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

let rootEl: HTMLElement;
let gameRef: GameAPI;
const stack: Panel[] = [];
const locks = new Set<string>();
let lastInput: boolean | null = null;

function syncInput(): void {
  const enabled = stack.length === 0 && locks.size === 0;
  if (enabled !== lastInput) {
    lastInput = enabled;
    gameRef.setInputEnabled(enabled);
  }
}

/** Used by non-panel overlays (title screen) to block game input. */
export function lockInput(id: string, on: boolean): void {
  if (on) locks.add(id);
  else locks.delete(id);
  syncInput();
}

export function anyPanelOpen(): boolean {
  return stack.length > 0;
}

export function initPanels(root: HTMLElement, game: GameAPI): void {
  rootEl = root;
  gameRef = game;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && stack.length) {
        e.preventDefault();
        e.stopPropagation();
        stack[stack.length - 1].close();
      }
    },
    true,
  );
}

export function createPanel(opts: PanelOpts): Panel {
  const titleEl = h('h2', { class: 'pn-title', text: opts.title });
  const body = h('div', { class: 'pn-body' });
  const closeBtn = h('button', { class: 'wt-icon-btn pn-close', 'aria-label': '閉じる', text: '✕', onclick: () => panel.close() });
  const dialog = h('div', { class: `pn-dialog ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'pn-head' }, titleEl, closeBtn), body);
  const el = h('div', {
    class: 'pn',
    onpointerdown: (e: PointerEvent) => {
      if (e.target === el) panel.close();
    },
  }, dialog);
  rootEl.append(el);

  const panel: Panel = {
    el,
    body,
    setTitle: (t) => { titleEl.textContent = t; },
    open() {
      if (stack.includes(panel)) return;
      stack.push(panel);
      el.style.zIndex = String(40 + stack.length);
      el.classList.add('open');
      syncInput();
      opts.onOpen?.();
    },
    close() {
      const i = stack.indexOf(panel);
      if (i < 0) return;
      stack.splice(i, 1);
      el.classList.remove('open');
      syncInput();
      opts.onClose?.();
    },
    toggle() {
      if (stack.includes(panel)) panel.close();
      else panel.open();
    },
    isOpen: () => stack.includes(panel),
  };
  return panel;
}
