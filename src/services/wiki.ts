export interface WikiSummary {
  title: string;
  extract: string;
  thumbnail?: string;
  image?: string;
  pageUrl: string;
  lang: 'ja' | 'en';
}

export interface WikiNearby {
  pageid: number;
  title: string;
  lat: number;
  lon: number;
  dist: number;
  lang: 'ja' | 'en';
}

const HEADERS: Record<string, string> = { 'Api-User-Agent': 'WorldTravel3D/0.1 (browser game)' };

async function getJson(url: string): Promise<any | null> {
  try {
    let r: Response;
    try {
      r = await fetch(url, { headers: HEADERS });
    } catch {
      r = await fetch(url); // retry without custom header in case preflight fails
    }
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const summaryCache = new Map<string, Promise<WikiSummary | null>>();

function summaryFor(lang: 'ja' | 'en', title: string): Promise<WikiSummary | null> {
  const key = `${lang}:${title}`;
  let p = summaryCache.get(key);
  if (!p) {
    const slug = encodeURIComponent(title.replace(/ /g, '_'));
    p = getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}`).then((j) => {
      if (!j || typeof j.extract !== 'string') return null;
      return {
        title: String(j.title ?? title),
        extract: j.extract,
        thumbnail: j.thumbnail?.source,
        image: j.originalimage?.source,
        pageUrl: j.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${slug}`,
        lang,
      } as WikiSummary;
    });
    summaryCache.set(key, p);
  }
  return p;
}

/** ja first, then en. Returns null when nothing is found (never throws). */
export async function fetchSummary(titleJa?: string, titleEn?: string): Promise<WikiSummary | null> {
  if (titleJa) {
    const s = await summaryFor('ja', titleJa);
    if (s) return s;
  }
  if (titleEn) return summaryFor('en', titleEn);
  return null;
}

const geoCache = new Map<string, WikiNearby[]>();
let lastGeo = 0;
let geoChain: Promise<unknown> = Promise.resolve();

async function geoQuery(lang: 'ja' | 'en', lat: number, lon: number, radiusM: number, limit: number): Promise<WikiNearby[]> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}` +
    `&gsradius=${Math.min(10000, Math.round(radiusM))}&gslimit=${limit}&format=json&origin=*`;
  const j = await getJson(url);
  const list = j?.query?.geosearch;
  if (!Array.isArray(list)) return [];
  return list.map((x: any) => ({ pageid: x.pageid, title: String(x.title), lat: x.lat, lon: x.lon, dist: x.dist, lang }));
}

/** Throttled to one network call per 5 s; cached per ~1 km cell. Falls back to en when ja is empty. */
export function geosearch(lat: number, lon: number, radiusM = 10000, limit = 30): Promise<WikiNearby[]> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${radiusM},${limit}`;
  const hit = geoCache.get(key);
  if (hit) return Promise.resolve(hit);
  const run = async () => {
    const wait = lastGeo + 5000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeo = Date.now();
    let res = await geoQuery('ja', lat, lon, radiusM, limit);
    if (res.length < 3) {
      const en = await geoQuery('en', lat, lon, radiusM, limit);
      res = res.concat(en).slice(0, limit);
      lastGeo = Date.now();
    }
    if (res.length) geoCache.set(key, res);
    return res;
  };
  const p = geoChain.then(run, run);
  geoChain = p.catch(() => undefined);
  return p;
}
