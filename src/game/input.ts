// Unified input: keyboard + mouse (Mac) and on-screen touch controls (phones).
import type { TravelMode } from '../types';

export interface InputFrame {
  /** -1..1 left/right (steer, strafe, roll) */
  x: number;
  /** -1..1 forward/back (walk) or pitch (plane, + = nose down) */
  y: number;
  throttle: number; // 0..1 (car accelerate, plane throttle up)
  brake: number; // 0..1 (car brake/reverse, plane throttle down)
  yaw: number; // -1..1 plane rudder
  run: boolean;
  lookDX: number; // pixels since last frame
  lookDY: number;
  zoom: number; // wheel delta
  pressed: Set<string>; // edge-triggered actions: view, horn, mode:car, mode:walk, mode:plane, gear, reset
}

const isTouch = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

export class Input {
  private keys = new Set<string>();
  private edges = new Set<string>();
  private lookDX = 0;
  private lookDY = 0;
  private zoom = 0;
  enabled = true;
  touch = isTouch();
  private joy = { x: 0, y: 0, id: -1 };
  private pedal = { gas: false, brake: false };
  private dragId = -1;
  private lastDrag = { x: 0, y: 0 };
  private overlay: HTMLElement | null = null;
  private mode: TravelMode = 'car';

  constructor(canvas: HTMLCanvasElement, overlayRoot: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      const k = e.code;
      if (!this.keys.has(k)) {
        if (k === 'KeyV' || k === 'KeyC') this.edges.add('view');
        if (k === 'Space' && this.mode === 'car') this.edges.add('horn');
        if (k === 'Digit1') this.edges.add('mode:car');
        if (k === 'Digit2') this.edges.add('mode:walk');
        if (k === 'Digit3') this.edges.add('mode:plane');
        if (k === 'KeyG') this.edges.add('gear');
        if (k === 'KeyR' && e.shiftKey) this.edges.add('reset');
      }
      this.keys.add(k);
      if (k.startsWith('Arrow') || k === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    // mouse drag look
    let mouseDown = false;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        mouseDown = true;
        this.lastDrag = { x: e.clientX, y: e.clientY };
      }
    });
    addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') mouseDown = false;
    });
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && mouseDown) {
        this.lookDX += e.clientX - this.lastDrag.x;
        this.lookDY += e.clientY - this.lastDrag.y;
        this.lastDrag = { x: e.clientX, y: e.clientY };
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.zoom += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );

    // touch: drag anywhere on the canvas (outside controls) to look
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.dragId !== -1) return;
      this.dragId = e.pointerId;
      this.lastDrag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragId) return;
      this.lookDX += (e.clientX - this.lastDrag.x) * 1.2;
      this.lookDY += (e.clientY - this.lastDrag.y) * 1.2;
      this.lastDrag = { x: e.clientX, y: e.clientY };
    });
    const endDrag = (e: PointerEvent) => {
      if (e.pointerId === this.dragId) this.dragId = -1;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    if (this.touch) this.buildTouchUI(overlayRoot);
  }

  setMode(mode: TravelMode) {
    this.mode = mode;
    if (!this.overlay) return;
    this.overlay.dataset.mode = mode;
    const gas = this.overlay.querySelector('.tc-gas') as HTMLElement;
    const brk = this.overlay.querySelector('.tc-brake') as HTMLElement;
    gas.textContent = mode === 'plane' ? '推力+' : mode === 'walk' ? '走る' : 'アクセル';
    brk.textContent = mode === 'plane' ? '推力−' : mode === 'walk' ? '' : 'ブレーキ';
    brk.style.display = mode === 'walk' ? 'none' : '';
  }

  private buildTouchUI(root: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'touch-controls';
    el.innerHTML = `
      <div class="tc-joy"><div class="tc-knob"></div></div>
      <div class="tc-pedals">
        <button class="tc-brake" type="button">ブレーキ</button>
        <button class="tc-gas" type="button">アクセル</button>
      </div>`;
    root.appendChild(el);
    this.overlay = el;
    const joy = el.querySelector('.tc-joy') as HTMLElement;
    const knob = el.querySelector('.tc-knob') as HTMLElement;
    const R = 56;
    const setKnob = () => (knob.style.transform = `translate(${this.joy.x * R}px, ${this.joy.y * R}px)`);
    joy.addEventListener('pointerdown', (e) => {
      this.joy.id = e.pointerId;
      joy.setPointerCapture(e.pointerId);
      move(e);
    });
    const move = (e: PointerEvent) => {
      if (e.pointerId !== this.joy.id) return;
      const r = joy.getBoundingClientRect();
      let dx = (e.clientX - (r.left + r.width / 2)) / R;
      let dy = (e.clientY - (r.top + r.height / 2)) / R;
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      this.joy.x = dx;
      this.joy.y = dy;
      setKnob();
    };
    joy.addEventListener('pointermove', move);
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.joy.id) return;
      this.joy = { x: 0, y: 0, id: -1 };
      setKnob();
    };
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);
    const hold = (btn: HTMLElement, key: 'gas' | 'brake') => {
      btn.addEventListener('pointerdown', (e) => {
        btn.setPointerCapture(e.pointerId);
        this.pedal[key] = true;
        btn.classList.add('on');
      });
      const up = () => {
        this.pedal[key] = false;
        btn.classList.remove('on');
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold(el.querySelector('.tc-gas') as HTMLElement, 'gas');
    hold(el.querySelector('.tc-brake') as HTMLElement, 'brake');
  }

  /** trigger an action from the UI (e.g. HUD buttons) */
  trigger(action: string) {
    this.edges.add(action);
  }

  frame(): InputFrame {
    const k = this.keys;
    const on = (...codes: string[]) => (this.enabled && codes.some((c) => k.has(c)) ? 1 : 0);
    let x = on('KeyD', 'ArrowRight') - on('KeyA', 'ArrowLeft');
    let y = on('KeyS', 'ArrowDown') - on('KeyW', 'ArrowUp'); // + = back / nose up handled per mode
    let throttle = 0;
    let brake = 0;
    if (this.mode === 'car') {
      throttle = on('KeyW', 'ArrowUp');
      brake = on('KeyS', 'ArrowDown');
    } else if (this.mode === 'plane') {
      throttle = on('ShiftLeft', 'ShiftRight', 'KeyR', 'Equal', 'NumpadAdd');
      brake = on('ControlLeft', 'ControlRight', 'KeyF', 'Minus', 'NumpadSubtract');
    }
    const yaw = on('KeyE') - on('KeyQ');
    let run = !!on('ShiftLeft', 'ShiftRight');
    if (this.joy.id !== -1 || this.joy.x || this.joy.y) {
      x = Math.abs(this.joy.x) > 0.08 ? this.joy.x : 0;
      y = Math.abs(this.joy.y) > 0.08 ? this.joy.y : 0;
    }
    if (this.pedal.gas) {
      throttle = 1;
      if (this.mode === 'walk') run = true;
    }
    if (this.pedal.brake) brake = 1;
    const f: InputFrame = {
      x,
      y,
      throttle,
      brake,
      yaw,
      run,
      lookDX: this.lookDX,
      lookDY: this.lookDY,
      zoom: this.zoom,
      pressed: new Set(this.edges),
    };
    this.edges.clear();
    this.lookDX = this.lookDY = this.zoom = 0;
    if (!this.enabled) {
      f.x = f.y = f.throttle = f.brake = f.yaw = 0;
      f.pressed.clear();
    }
    return f;
  }

  /** car S key means brake; walk S means backwards. Expose raw key state for brake key (plane wheel brake). */
  isDown(code: string) {
    return this.enabled && this.keys.has(code);
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
