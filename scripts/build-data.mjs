// Build-time data preparation. Run with `npm run data` (needs internet).
// Outputs:
//   public/data/geoid.bin          EGM96 geoid undulation, 1° grid, Int16 decimetres, lat 90..-90 (181 rows) x lon -180..180 (361 cols)
//   public/data/countries.geojson  Natural Earth 1:110m admin-0 countries (public domain), slimmed properties
//   src/data/plateau.generated.json  PLATEAU building 3D Tiles (textured) per ward, with bounding regions
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import egm from 'egm96-universal';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (p) => {
  const f = join(root, p);
  mkdirSync(dirname(f), { recursive: true });
  return f;
};

// ---------- 1. geoid grid ----------
{
  const rows = 181;
  const cols = 361;
  const buf = new Int16Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const lat = 90 - r;
    for (let c = 0; c < cols; c++) {
      const lon = -180 + c;
      buf[r * cols + c] = Math.round(egm.meanSeaLevel(lat, lon) * 10);
    }
  }
  writeFileSync(out('public/data/geoid.bin'), Buffer.from(buf.buffer));
  console.log('geoid.bin written');
}

// ---------- 2. countries ----------
{
  const url =
    'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
  const res = await fetch(url);
  if (!res.ok) throw new Error('countries fetch failed ' + res.status);
  const fc = await res.json();
  const round = (v) => Math.round(v * 1000) / 1000;
  const roundCoords = (c) => (typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(roundCoords));
  const features = fc.features.map((f) => ({
    type: 'Feature',
    properties: {
      iso: f.properties.ISO_A2_EH && f.properties.ISO_A2_EH !== '-99' ? f.properties.ISO_A2_EH : f.properties.ISO_A2,
      name: f.properties.NAME,
      nameJa: f.properties.NAME_JA || f.properties.NAME,
    },
    geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
  }));
  writeFileSync(out('public/data/countries.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log('countries.geojson written', features.length);
}

// ---------- 3. PLATEAU tilesets ----------
{
  const { CITIES_PLATEAU } = await import('./plateau-wards.mjs');
  const res = await fetch('https://api.plateau.reearth.io/datacatalog/plateau-datasets');
  if (!res.ok) throw new Error('plateau catalog failed ' + res.status);
  const cat = await res.json();
  const all = cat.datasets.filter((d) => d.type_en === 'bldg' && d.format === '3D Tiles' && d.texture);
  const result = {};
  for (const [cityId, wards] of Object.entries(CITIES_PLATEAU)) {
    result[cityId] = [];
    for (const ward of wards) {
      const cands = all.filter((d) => (d.ward_code || d.city_code) === ward);
      if (!cands.length) {
        console.warn('no PLATEAU data for', cityId, ward);
        continue;
      }
      const newestYear = Math.max(...cands.map((d) => d.year));
      const latest = cands.filter((d) => d.year === newestYear);
      const lod2 = latest.find((d) => d.lod === '2' || d.lod === 2);
      // Prefer the highest LOD whose tileset is about as large as LOD2 (= covers all buildings, not only a few LOD3 ones)
      const sorted = latest
        .filter((d) => Number(d.lod) >= 2)
        .sort((a, b) => Number(b.lod) - Number(a.lod));
      let pick = sorted.find((d) => !lod2 || d.file_size >= lod2.file_size * 0.9) || lod2 || latest[0];
      // fetch the root to get its bounding region
      const tsRes = await fetch(pick.url);
      if (!tsRes.ok) {
        console.warn('tileset fetch failed', pick.url, tsRes.status);
        continue;
      }
      const ts = await tsRes.json();
      const region = ts.root?.boundingVolume?.region;
      if (!region) {
        console.warn('no region in', pick.url);
        continue;
      }
      result[cityId].push({
        ward,
        name: (pick.ward || pick.city) + ` LOD${pick.lod}`,
        lod: Number(pick.lod),
        year: pick.year,
        url: pick.url,
        // radians west,south,east,north + heights
        region: region.map((v) => Math.round(v * 1e7) / 1e7),
      });
      console.log(cityId, ward, pick.ward || pick.city, 'LOD' + pick.lod, pick.year);
    }
  }
  writeFileSync(out('src/data/plateau.generated.json'), JSON.stringify(result, null, 1));
  console.log('plateau.generated.json written');
}
