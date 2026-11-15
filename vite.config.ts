import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const cesiumSource = 'node_modules/cesium/Build/Cesium';

export default defineConfig({
  // relative base so the build works on GitHub Pages sub-paths and any static host
  base: './',
  define: {
    CESIUM_BASE_URL: JSON.stringify('./cesium/'),
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/Workers`, dest: 'cesium' },
        { src: `${cesiumSource}/ThirdParty`, dest: 'cesium' },
        { src: `${cesiumSource}/Assets`, dest: 'cesium' },
        { src: `${cesiumSource}/Widgets`, dest: 'cesium' },
      ],
    }),
  ],
  build: {
    chunkSizeWarningLimit: 6000,
    target: 'es2022',
  },
  server: { host: true },
});
