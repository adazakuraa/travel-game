// Time of day, sun, atmosphere and weather visuals.
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  CloudCollection,
  JulianDate,
  PostProcessStage,
  type Viewer,
} from 'cesium';
import type { EnvironmentState, WeatherKind, WeatherState } from '../types';

/** Solar elevation (deg) for UTC date and location. NOAA approximate algorithm. */
export function sunElevation(date: Date, lat: number, lon: number): number {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * rad;
  const ha = lst - ra;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return el / rad;
}

const FOG_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform sampler2D depthTexture;
  uniform float u_density;
  uniform vec3 u_fogColor;
  in vec2 v_textureCoordinates;
  void main() {
    vec4 color = texture(colorTexture, v_textureCoordinates);
    float depth = czm_readDepth(depthTexture, v_textureCoordinates);
    if (depth >= 1.0) { out_FragColor = color; return; }
    // the depth texture handed to post-process stages holds perspective depth of the current frustum
    float near = czm_currentFrustum.x;
    float far = czm_currentFrustum.y;
    float d = near * far / (far - depth * (far - near));
    float f = 1.0 - exp(-pow(d * u_density, 1.35));
    out_FragColor = vec4(mix(color.rgb, u_fogColor, clamp(f, 0.0, 0.97)), color.a);
  }
`;

const RAIN_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform float u_intensity;
  uniform float u_snow;
  in vec2 v_textureCoordinates;
  float hash(float x) { return fract(sin(x * 133.3) * 13.13); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec4 color = texture(colorTexture, v_textureCoordinates);
    float time = czm_frameNumber / 60.0;
    vec2 res = czm_viewport.zw;
    vec2 uv = (gl_FragCoord.xy * 2.0 - res) / min(res.x, res.y);
    vec3 add = vec3(0.0);
    if (u_snow < 0.5) {
      float a = -0.25;
      uv *= mat2(cos(a), -sin(a), sin(a), cos(a));
      uv *= length(uv + vec2(0.0, 4.9)) * 0.3 + 1.0;
      float v = 1.0 - sin(hash(floor(uv.x * 110.0)) * 2.0);
      float b = clamp(abs(sin(20.0 * time * v + uv.y * (5.0 / (2.0 + v)))) - 0.95, 0.0, 1.0) * 20.0;
      add = vec3(0.55, 0.6, 0.68) * v * b * 0.35;
      color.rgb *= 1.0 - 0.18 * u_intensity; // overcast dimming
    } else {
      for (int i = 0; i < 3; i++) {
        float sc = 6.0 + float(i) * 5.0;
        vec2 p = uv * sc + vec2(sin(time * 0.5 + float(i)) * 0.6, time * (1.2 + float(i) * 0.4));
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        float r = hash2(cell + float(i) * 7.0);
        vec2 o = vec2(r - 0.5, hash2(cell.yx) - 0.5) * 0.6;
        float s = smoothstep(0.09 - float(i) * 0.02, 0.0, length(f - o)) * step(0.35, r);
        add += vec3(s) * (0.9 - float(i) * 0.2);
      }
    }
    out_FragColor = vec4(color.rgb + add * u_intensity, color.a);
  }
`;

export class EnvironmentController {
  state: EnvironmentState;
  private fog: PostProcessStage;
  private rain: PostProcessStage;
  private clouds: CloudCollection;
  private cloudCenter: Cartesian3 | null = null;
  private cloudCount = 0;
  mobile = false;
  /** 0 = day, 1 = full night */
  night = 0;

  constructor(private viewer: Viewer) {
    const now = new Date();
    this.state = {
      timezone: null,
      utcOffsetSeconds: 0,
      localWallClock: now,
      timeOverride: null,
      weather: { kind: 'clear', temperature: null, cloudCover: 10, windSpeed: 2, precipitation: 0, source: 'default' },
      weatherOverride: null,
    };
    const scene = viewer.scene;
    this.fog = new PostProcessStage({
      fragmentShader: FOG_SHADER,
      uniforms: { u_density: 1 / 9000, u_fogColor: new Cartesian3(0.72, 0.78, 0.86) },
    });
    this.rain = new PostProcessStage({ fragmentShader: RAIN_SHADER, uniforms: { u_intensity: 0, u_snow: 0 } });
    this.rain.enabled = false;
    scene.postProcessStages.add(this.fog);
    scene.postProcessStages.add(this.rain);
    this.clouds = scene.primitives.add(new CloudCollection({ noiseDetail: 16, noiseOffset: Cartesian3.ZERO }));
    // CesiumJS bug workaround: CloudCollection draw commands have no boundingVolume, which crashes the
    // back-to-front sort of translucent commands as soon as another translucent object (car glass) is visible.
    const clouds = this.clouds as any;
    const origUpdate = clouds.update.bind(clouds);
    clouds.update = (frameState: any) => {
      origUpdate(frameState);
      const center = this.cloudCenter ?? Cartesian3.ZERO;
      for (const cmd of clouds._colorCommands ?? []) {
        if (!cmd.boundingVolume) cmd.boundingVolume = new BoundingSphere(Cartesian3.clone(center), 20000);
        else Cartesian3.clone(center, cmd.boundingVolume.center);
      }
    };
  }

  setZone(tz: string | null, offsetSeconds: number) {
    this.state.timezone = tz;
    this.state.utcOffsetSeconds = offsetSeconds;
  }

  setLiveWeather(w: WeatherState) {
    this.state.weather = w;
  }

  effectiveWeather(): WeatherKind {
    return this.state.weatherOverride ?? this.state.weather.kind;
  }

  /** current UTC instant used for the sun */
  simulatedUtc(): Date {
    const now = new Date();
    if (this.state.timeOverride === null) return now;
    const localNow = new Date(now.getTime() + this.state.utcOffsetSeconds * 1000);
    const midnightLocal = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
    return new Date(midnightLocal + this.state.timeOverride * 3600_000 - this.state.utcOffsetSeconds * 1000);
  }

  /** per frame */
  update(lat: number, lon: number, groundHeight: number, playerPos: Cartesian3) {
    const utc = this.simulatedUtc();
    this.viewer.clock.currentTime = JulianDate.fromDate(utc);
    this.state.localWallClock = new Date(utc.getTime() + this.state.utcOffsetSeconds * 1000);
    const el = sunElevation(utc, lat, lon);
    this.night = Math.max(0, Math.min(1, (2 - el) / 10)); // 0 above +2°, 1 below -8°

    const kind = this.effectiveWeather();
    const scene = this.viewer.scene;
    const overcast = kind === 'cloudy' || kind === 'rain' || kind === 'storm' || kind === 'snow' || kind === 'fog';
    // fog / haze
    const baseHaze = 1 / 14000;
    const density =
      kind === 'fog' ? 1 / 700 : kind === 'rain' || kind === 'storm' ? 1 / 3000 : kind === 'snow' ? 1 / 1800 : kind === 'cloudy' ? 1 / 7000 : baseHaze;
    const dayFog = overcast ? new Cartesian3(0.66, 0.69, 0.72) : new Cartesian3(0.7, 0.78, 0.88);
    const t = this.night;
    const fogColor = new Cartesian3(
      dayFog.x * (1 - t) + 0.03 * t,
      dayFog.y * (1 - t) + 0.04 * t,
      dayFog.z * (1 - t) + 0.07 * t,
    );
    (this.fog.uniforms as any).u_density = density;
    (this.fog.uniforms as any).u_fogColor = fogColor;

    const precip = kind === 'rain' || kind === 'storm' ? 1 : kind === 'snow' ? 1 : 0;
    this.rain.enabled = precip > 0;
    (this.rain.uniforms as any).u_intensity = kind === 'storm' ? 1.0 : 0.75;
    (this.rain.uniforms as any).u_snow = kind === 'snow' ? 1 : 0;

    // light & sky
    scene.light.intensity = overcast ? 1.4 : 2.2;
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.saturationShift = overcast ? -0.55 : 0;
      scene.skyAtmosphere.brightnessShift = overcast ? -0.15 : 0;
    }
    scene.globe.atmosphereSaturationShift = overcast ? -0.35 : 0;

    // clouds around the player
    const cover = this.state.weatherOverride
      ? { clear: 5, partly: 40, cloudy: 90, fog: 70, rain: 95, snow: 95, storm: 100 }[kind]
      : this.state.weather.cloudCover;
    const wanted = Math.round((cover / 100) * (this.mobile ? 22 : 55));
    if (!this.cloudCenter || Cartesian3.distance(this.cloudCenter, playerPos) > 12000 || wanted !== this.cloudCount) {
      this.layoutClouds(lat, lon, groundHeight, wanted, overcast);
      this.cloudCenter = Cartesian3.clone(playerPos);
    }
  }

  private layoutClouds(lat: number, lon: number, ground: number, count: number, overcast: boolean) {
    this.clouds.removeAll();
    this.cloudCount = count;
    let seed = Math.floor(lat * 1000) * 31 + Math.floor(lon * 1000);
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0xffff) / 0xffff;
    };
    for (let i = 0; i < count; i++) {
      const r = 1500 + rnd() * 14000;
      const a = rnd() * Math.PI * 2;
      const dLat = (r * Math.cos(a)) / 110540;
      const dLon = (r * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180));
      const alt = Math.max(ground, 0) + (overcast ? 900 : 1400) + rnd() * 900;
      const w = 900 + rnd() * 1800;
      const h = w * (0.35 + rnd() * 0.25);
      this.clouds.add({
        position: Cartesian3.fromDegrees(lon + dLon, lat + dLat, alt),
        scale: new Cartesian2(w, h),
        maximumSize: new Cartesian3(50 + rnd() * 25, 12 + rnd() * 10, 15 + rnd() * 10),
        slice: 0.3 + rnd() * 0.4,
        brightness: overcast ? 0.62 + rnd() * 0.15 : 0.95 + rnd() * 0.05,
        color: overcast ? Color.fromCssColorString('#c9ced6') : Color.WHITE,
      });
    }
  }
}
