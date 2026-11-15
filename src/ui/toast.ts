import { h } from './dom';

export interface ToastOpts {
  duration?: number;
  action?: { label: string; onClick: () => void };
}

let host: HTMLElement | null = null;

export function initToast(root: HTMLElement): void {
  host = h('div', { class: 'wt-toasts', 'aria-live': 'polite' });
  root.append(host);
}

export function toast(msg: string, opts: ToastOpts = {}): void {
  if (!host) return;
  const el = h('div', { class: 'wt-toast' }, h('span', { text: msg }));
  const remove = () => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  };
  if (opts.action) {
    const a = opts.action;
    el.append(
      h('button', { class: 'wt-btn wt-btn-small wt-btn-accent', text: a.label, onclick: () => { a.onClick(); remove(); } }),
    );
  }
  host.append(el);
  while (host.children.length > 3) host.firstElementChild?.remove();
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(remove, opts.duration ?? (opts.action ? 7000 : 3800));
}

let loadingEl: HTMLElement | null = null;
let loadingLabel: HTMLElement | null = null;

export function initLoading(root: HTMLElement): void {
  loadingLabel = h('span', { text: '読み込み中…' });
  loadingEl = h('div', { class: 'wt-loading', role: 'status' }, h('i', { class: 'wt-spinner' }), loadingLabel);
  root.append(loadingEl);
}

export function setLoading(active: boolean, label?: string): void {
  if (!loadingEl || !loadingLabel) return;
  if (label) loadingLabel.textContent = label;
  else if (active) loadingLabel.textContent = '読み込み中…';
  loadingEl.classList.toggle('on', active);
}
