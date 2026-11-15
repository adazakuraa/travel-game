// Key-less aerial / satellite imagery, layered from global (coarse) to national (very high resolution).
// All endpoints verified to answer with CORS `Access-Control-Allow-Origin` (required for WebGL textures).
import {
  Credit,
  ImageryLayer,
  Rectangle,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
  type Viewer,
} from 'cesium';

interface LayerDef {
  id: string;
  url: string;
  maximumLevel: number;
  minimumLevel?: number;
  rect?: [number, number, number, number]; // west, south, east, north (deg)
  credit: string;
}

const LAYERS: LayerDef[] = [
  {
    // Global base: Sentinel-2 cloudless 2024 by EOX (CC BY-NC-SA 4.0 → non-commercial use only)
    id: 's2cloudless',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
    maximumLevel: 14,
    credit:
      '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless 2024</a> by EOX IT Services GmbH (CC BY-NC-SA 4.0, Contains modified Copernicus Sentinel data 2024)',
  },
  {
    id: 'usgs',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 16,
    minimumLevel: 8,
    rect: [-125, 24.4, -66.9, 49.4],
    credit: 'USGS The National Map: Orthoimagery (public domain)',
  },
  {
    id: 'ign',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
    maximumLevel: 19,
    minimumLevel: 11,
    rect: [-5.2, 42.3, 7.6, 51.1],
    credit: 'Orthophotos © IGN – Géoplateforme (Licence Ouverte Etalab 2.0)',
  },
  {
    id: 'pdok',
    url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
    maximumLevel: 20,
    minimumLevel: 8,
    rect: [3.3, 50.75, 7.25, 53.55],
    credit: 'Luchtfoto © PDOK / Beeldmateriaal Nederland (CC BY 4.0)',
  },
  {
    id: 'swissimage',
    url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    maximumLevel: 20,
    minimumLevel: 8,
    rect: [5.95, 45.82, 10.49, 47.81],
    credit: 'SWISSIMAGE © swisstopo',
  },
  {
    id: 'gsi',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    maximumLevel: 18,
    minimumLevel: 6,
    rect: [122.9, 24.0, 146.0, 45.6],
    credit:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">出典: 国土地理院 シームレス空中写真</a>',
  },
];

export function addImagery(viewer: Viewer): void {
  const tiling = new WebMercatorTilingScheme();
  for (const def of LAYERS) {
    const provider = new UrlTemplateImageryProvider({
      url: def.url,
      tilingScheme: tiling,
      maximumLevel: def.maximumLevel,
      minimumLevel: def.minimumLevel ?? 0,
      rectangle: def.rect ? Rectangle.fromDegrees(...def.rect) : undefined,
      credit: new Credit(def.credit, false),
      enablePickFeatures: false,
    });
    const layer = new ImageryLayer(provider, {
      rectangle: def.rect ? Rectangle.fromDegrees(...def.rect) : undefined,
    });
    // subtle grading so mixed sources look consistent and less washed out
    layer.saturation = 1.08;
    layer.contrast = 1.04;
    layer.gamma = 1.0;
    viewer.imageryLayers.add(layer);
  }
}
