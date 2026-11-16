// Arcade vehicle models in a local metric frame (x = east, y = north, z = ellipsoidal height).
// Headings are compass degrees (0 = north, clockwise).
import type { InputFrame } from './input';
import type { RoadNetwork } from './roads';

export interface Ground {
  /** ground (or deck) height at local x/y; `fromZ` = current height (used to avoid snapping onto roofs/canopies) */
  height(x: number, y: number, fromZ?: number): number | undefined;
  /** true when samples may hit walls/roofs/trees (photogrammetry mesh) and need outlier filtering */
  noisy: boolean;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number; // deg
  pitch: number; // deg, nose up +
  roll: number; // deg, right side down +
}

const D2R = Math.PI / 180;
const wrap360 = (a: number) => ((a % 360) + 360) % 360;
const angDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ car
export class Car {
  pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 };
  speed = 0; // m/s, negative = reverse
  steer = 0; // -1..1 smoothed
  rpm = 0.1;
  throttle = 0;
  gear = 1;
  roadAssist = true;
  onRoad = false;
  private zVel = 0;
  private rejectT = 0;
  readonly wheelBase = 2.65;
  readonly maxSpeed = 50;

  place(x: number, y: number, z: number, heading: number) {
    this.pose = { x, y, z, heading, pitch: 0, roll: 0 };
    this.speed = 0;
    this.zVel = 0;
  }

  update(dt: number, inp: InputFrame, roads: RoadNetwork, ground: Ground) {
    const p = this.pose;
    // steering (smoothed, speed-sensitive)
    this.steer = lerp(this.steer, inp.x, Math.min(1, dt * 6));
    const v = this.speed;
    // longitudinal
    let acc = 0;
    if (inp.throttle > 0) {
      if (v < -0.5) acc = 9; // braking out of reverse
      else acc = inp.throttle * (v < 15 ? 4.2 : v < 30 ? 3.0 : v < 40 ? 1.8 : 0.9);
    }
    if (inp.brake > 0) {
      if (v > 0.5) acc -= inp.brake * 9;
      else acc -= inp.brake * 2.5; // reverse
    }
    acc -= 0.0009 * v * Math.abs(v) + 0.25 * Math.sign(v) * (inp.throttle || inp.brake ? 0.3 : 1); // drag + rolling
    // gravity along slope
    acc -= 9.81 * Math.sin(p.pitch * D2R);
    let nv = v + acc * dt;
    if (Math.sign(nv) !== Math.sign(v) && v !== 0 && !(inp.brake && v <= 0.5) && !(inp.throttle && v >= -0.5)) nv = 0;
    if (Math.abs(nv) < 0.05 && !inp.throttle && !inp.brake) nv = 0;
    this.speed = clamp(nv, -10, this.maxSpeed);
    // yaw
    const maxSteer = 0.62 / (1 + Math.abs(this.speed) / 14);
    const yawRate = (this.speed / this.wheelBase) * Math.tan(this.steer * maxSteer); // rad/s, + = right turn
    p.heading = wrap360(p.heading + (yawRate / D2R) * dt);
    // move
    const h = p.heading * D2R;
    p.x += Math.sin(h) * this.speed * dt;
    p.y += Math.cos(h) * this.speed * dt;

    // road assist: stay on the carriageway, align with road when not steering
    this.onRoad = false;
    let deck: number | undefined;
    const mathHeading = Math.PI / 2 - h;
    const n = roads.nearest(p.x, p.y, mathHeading, 45);
    if (n) {
      const lim = n.seg.half - 0.6;
      this.onRoad = n.dist <= n.seg.half + 0.5;
      if (this.roadAssist) {
        if (n.dist > lim && n.dist - lim < 8) {
          const k = lim / n.dist;
          p.x = n.px + (p.x - n.px) * k;
          p.y = n.py + (p.y - n.py) * k;
          this.speed *= 1 - Math.min(0.5, dt * 0.8);
          this.onRoad = true;
        }
        if (Math.abs(inp.x) < 0.15 && Math.abs(this.speed) > 2) {
          let roadHdg = 90 - n.dir / D2R; // convert math angle to compass
          if (Math.abs(angDiff(roadHdg, p.heading)) > 90) roadHdg += 180;
          const d = angDiff(roadHdg, p.heading);
          if (Math.abs(d) < 35) p.heading = wrap360(p.heading + d * Math.min(1, dt * 1.6));
        }
      }
      const br = n.seg.bridge;
      if (br) {
        const hs = ground.height(br.sx, br.sy);
        const he = ground.height(br.ex, br.ey);
        if (hs !== undefined && he !== undefined) {
          const ex = br.ex - br.sx;
          const ey = br.ey - br.sy;
          const t = clamp(((p.x - br.sx) * ex + (p.y - br.sy) * ey) / (ex * ex + ey * ey || 1), 0, 1);
          deck = lerp(hs, he, t);
        }
      }
    }

    // vertical: follow ground with suspension-like smoothing
    const hf = Math.sin(h) * 1.4;
    const hn = Math.cos(h) * 1.4;
    // reject samples that jump too far from the current height: on photogrammetry meshes these are
    // walls, roofs, trees or parked vehicles rather than the road surface
    // on regular terrain only absurd jumps (tile skirts while LODs swap) are rejected
    const ok = (v: number | undefined, tol: number) => (v !== undefined && Math.abs(v - p.z) < (ground.noisy ? tol : 50) ? v : undefined);
    const raw0 = ground.height(p.x, p.y, p.z);
    let g0 = ok(raw0, 1.2 + Math.abs(this.speed) * 0.05);
    // if the surface keeps disagreeing for a while, we were placed on a roof/canopy (or below the road): resnap
    if (raw0 !== undefined && g0 === undefined) {
      this.rejectT += dt;
      if (ground.noisy && this.rejectT > 1.0 && Math.abs(raw0 - p.z) < 40) {
        g0 = raw0;
        p.z = raw0;
        this.rejectT = 0;
      }
    } else this.rejectT = 0;
    const gF = ok(ground.height(p.x + hf, p.y + hn, p.z), 1.0);
    const gB = ok(ground.height(p.x - hf, p.y - hn, p.z), 1.0);
    const gR = ok(ground.height(p.x + Math.cos(h) * 0.8, p.y - Math.sin(h) * 0.8, p.z), 0.5);
    const gL = ok(ground.height(p.x - Math.cos(h) * 0.8, p.y + Math.sin(h) * 0.8, p.z), 0.5);
    let target = g0 ?? p.z;
    if (deck !== undefined) target = Math.max(target, deck);
    if (g0 === undefined && deck === undefined) {
      // ground not streamed in yet: hold height instead of falling through the world
      this.zVel = 0;
    } else if (target > p.z) {
      p.z = lerp(p.z, target, Math.min(1, dt * 18));
      this.zVel = 0;
    } else {
      this.zVel -= 9.81 * dt;
      p.z += this.zVel * dt;
      if (p.z < target) {
        p.z = target;
        this.zVel = 0;
      }
    }
    if (deck === undefined && gF !== undefined && gB !== undefined) {
      p.pitch = lerp(p.pitch, clamp(Math.atan2(gF - gB, 2.8) / D2R, -15, 15), Math.min(1, dt * 8));
    } else p.pitch = lerp(p.pitch, 0, Math.min(1, dt * 4));
    if (gR !== undefined && gL !== undefined) {
      const bodyRoll = -this.steer * clamp(Math.abs(this.speed) / 30, 0, 1) * 2.5; // lean out of turns
      p.roll = lerp(p.roll, clamp(Math.atan2(gL - gR, 1.6) / D2R, -10, 10) + bodyRoll, Math.min(1, dt * 8));
    }

    // engine rpm with simulated automatic gearbox
    const kmh = Math.abs(this.speed) * 3.6;
    const gears = [0, 18, 38, 62, 90, 125, 999];
    let g = 1;
    while (g < gears.length - 1 && kmh > gears[g]) g++;
    this.gear = g;
    const lo = gears[g - 1];
    const hi = Math.min(gears[g], 200);
    const r = (kmh - lo) / Math.max(1, hi - lo);
    const target01 = clamp(0.12 + r * 0.75 + inp.throttle * 0.1, 0.12, 1);
    this.rpm = lerp(this.rpm, target01, Math.min(1, dt * 5));
    this.throttle = lerp(this.throttle, inp.throttle, Math.min(1, dt * 8));
  }
}

// ------------------------------------------------------------------ walker
export class Walker {
  pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 };
  speed = 0;
  lookPitch = -5;

  place(x: number, y: number, z: number, heading: number) {
    this.pose = { x, y, z, heading, pitch: 0, roll: 0 };
    this.speed = 0;
  }

  update(dt: number, inp: InputFrame, ground: Ground, touch: boolean) {
    const p = this.pose;
    // keyboard A/D turn slowly when not strafing on touch; on desktop A/D strafe
    const run = inp.run ? 4.2 : 1.6;
    const fwd = -inp.y;
    let side = inp.x;
    if (touch) {
      // joystick: x turns, y moves
      p.heading = wrap360(p.heading + inp.x * 70 * dt);
      side = 0;
    }
    const h = p.heading * D2R;
    const vx = (Math.sin(h) * fwd + Math.cos(h) * side) * run;
    const vy = (Math.cos(h) * fwd - Math.sin(h) * side) * run;
    p.x += vx * dt;
    p.y += vy * dt;
    this.speed = Math.hypot(vx, vy);
    const g = ground.height(p.x, p.y, p.z + 1.0);
    // ignore absurd jumps (globe tile skirts while LODs load; roofs/canopies on photogrammetry)
    if (g !== undefined && Math.abs(g - p.z) < (ground.noisy ? 1.5 : 50)) p.z = lerp(p.z, g, Math.min(1, dt * 12));
  }
}

// ------------------------------------------------------------------ plane
export type PlaneEvent = 'touchdown' | 'crash' | 'liftoff' | null;

export class Plane {
  pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 };
  speed = 0; // airspeed m/s
  throttle = 0;
  vz = 0;
  onGround = true;
  gearDown = true;
  readonly vRotate = 72; // ~140 kt
  readonly vStall = 58;
  agl = 0;

  place(x: number, y: number, z: number, heading: number, airborne: boolean) {
    this.pose = { x, y, z, heading, pitch: airborne ? 2 : 0, roll: 0 };
    this.onGround = !airborne;
    this.speed = airborne ? 120 : 0;
    this.throttle = airborne ? 0.6 : 0;
    this.vz = 0;
    this.gearDown = !airborne;
  }

  update(dt: number, inp: InputFrame, ground: Ground, wheelBrake: boolean): PlaneEvent {
    const p = this.pose;
    let ev: PlaneEvent = null;
    this.throttle = clamp(this.throttle + (inp.throttle - inp.brake) * dt * 0.45, 0, 1);
    if (inp.pressed.has('gear') && !this.onGround) this.gearDown = !this.gearDown;
    const thrustAcc = this.throttle * 3.0;
    const drag = 0.000105 * this.speed * this.speed * (this.gearDown ? 1.25 : 1);
    const g = ground.height(p.x, p.y) ?? 0;
    this.agl = p.z - g;

    if (this.onGround) {
      const rolling = 0.12 + (wheelBrake || (inp.brake > 0 && this.throttle === 0) ? 2.8 : 0);
      this.speed = Math.max(0, this.speed + (thrustAcc - drag - rolling * Math.sign(this.speed)) * dt);
      // nose wheel steering: x / rudder
      const steer = (inp.x + inp.yaw) * clamp(18 / (1 + this.speed / 8), 1.5, 18);
      p.heading = wrap360(p.heading + steer * dt);
      // rotation: pull back (y > 0) above Vr
      const wantPitch = this.speed > this.vRotate - 6 && inp.y > 0.1 ? 10 * inp.y : 0;
      p.pitch = lerp(p.pitch, wantPitch, Math.min(1, dt * 1.5));
      p.roll = lerp(p.roll, 0, Math.min(1, dt * 5));
      p.z = g;
      this.vz = 0;
      if (this.speed > this.vRotate && p.pitch > 5) {
        this.onGround = false;
        this.vz = 2;
        ev = 'liftoff';
      }
    } else {
      // attitude control: y (+ = pull back = nose up), x roll
      const pitchRate = inp.y * 9; // deg/s
      p.pitch = clamp(p.pitch + pitchRate * dt, -25, 25);
      if (Math.abs(inp.x) > 0.05) p.roll = clamp(p.roll + inp.x * 32 * dt, -45, 45);
      else p.roll = lerp(p.roll, 0, Math.min(1, dt * 0.6));
      // coordinated turn + rudder
      const turnRate = ((9.81 * Math.tan(p.roll * D2R)) / Math.max(this.speed, 40)) / D2R; // deg/s
      p.heading = wrap360(p.heading + (turnRate + inp.yaw * 3) * dt);
      // energy: climbing costs speed
      this.speed = clamp(this.speed + (thrustAcc - drag - 9.81 * Math.sin(p.pitch * D2R) * 0.6) * dt, 0, 260);
      const lift = clamp((this.speed - this.vStall + 10) / 25, 0, 1);
      const vzTarget = this.speed * Math.sin(p.pitch * D2R) * lift - (1 - lift) * 14;
      this.vz = lerp(this.vz, vzTarget, Math.min(1, dt * 1.2));
      if (lift < 0.6) p.pitch = lerp(p.pitch, -8, Math.min(1, dt * 0.5)); // stall: nose drops
      p.z += this.vz * dt;
      if (p.z <= g + 0.05) {
        // contact
        const soft = this.vz > -4.5 && Math.abs(p.roll) < 12 && p.pitch > -3 && this.gearDown;
        if (soft) {
          ev = 'touchdown';
          this.onGround = true;
          p.z = g;
          this.vz = 0;
        } else {
          ev = 'crash';
          p.z = g;
          this.vz = 0;
          this.speed = 0;
          this.onGround = true;
        }
      }
    }
    const h = p.heading * D2R;
    const horiz = this.speed * Math.cos(p.pitch * D2R * (this.onGround ? 0 : 1));
    p.x += Math.sin(h) * horiz * dt;
    p.y += Math.cos(h) * horiz * dt;
    return ev;
  }
}
