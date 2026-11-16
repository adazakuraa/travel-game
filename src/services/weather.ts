// Real weather + local time offset from Open-Meteo (free for non-commercial use, no key, CC BY 4.0).
import type { WeatherKind, WeatherState } from '../types';

export interface LiveWeather {
  weather: WeatherState;
  timezone: string | null;
  utcOffsetSeconds: number;
}

// WMO weather interpretation codes → our categories
function kindFromCode(code: number, cloud: number): WeatherKind {
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 45 || code === 48) return 'fog';
  if (code === 3 || cloud > 80) return 'cloudy';
  if (code === 1 || code === 2 || cloud > 30) return 'partly';
  return 'clear';
}

const cache = new Map<string, { t: number; data: LiveWeather }>();

export async function fetchWeather(lat: number, lon: number): Promise<LiveWeather | null> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 15 * 60_000) return hit.data;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,precipitation&wind_speed_unit=ms&timezone=auto`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const c = j.current ?? {};
    const cloud = Number(c.cloud_cover ?? 0);
    const data: LiveWeather = {
      timezone: j.timezone ?? null,
      utcOffsetSeconds: Number(j.utc_offset_seconds ?? 0),
      weather: {
        kind: kindFromCode(Number(c.weather_code ?? 0), cloud),
        temperature: typeof c.temperature_2m === 'number' ? c.temperature_2m : null,
        cloudCover: cloud,
        windSpeed: Number(c.wind_speed_10m ?? 0),
        precipitation: Number(c.precipitation ?? 0),
        source: 'live',
      },
    };
    cache.set(key, { t: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

/** UTC offset for an IANA zone (fallback before weather data arrives). */
export function offsetForZone(tz: string, at = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUTC - at.getTime()) / 1000);
  } catch {
    return 0;
  }
}
