import {
  Color,
  Ion,
  ShadowMode,
  Viewer,
  type TerrainProvider,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { GraphicsQuality } from '../types';

// We never use Cesium ion (it requires an account). Make sure nothing silently calls it.
Ion.defaultAccessToken = '';

export interface QualityPreset {
  resolutionScale: number;
  msaa: number;
  globeSSE: number;
  tilesetSSE: number;
  shadows: boolean;
  ao: boolean;
  fxaa: boolean;
}

export const PRESETS: Record<Exclude<GraphicsQuality, 'auto'>, QualityPreset> = {
  low: { resolutionScale: 0.6, msaa: 1, globeSSE: 4, tilesetSSE: 32, shadows: false, ao: false, fxaa: true },
  medium: { resolutionScale: 0.85, msaa: 1, globeSSE: 2.5, tilesetSSE: 20, shadows: false, ao: false, fxaa: true },
  high: { resolutionScale: 1, msaa: 4, globeSSE: 1.8, tilesetSSE: 12, shadows: true, ao: false, fxaa: false },
  ultra: { resolutionScale: 1, msaa: 4, globeSSE: 1.3, tilesetSSE: 8, shadows: true, ao: true, fxaa: false },
};

export function detectQuality(): Exclude<GraphicsQuality, 'auto'> {
  const mobile = matchMedia('(pointer: coarse)').matches;
  const mem = (navigator as any).deviceMemory as number | undefined;
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile) return mem !== undefined && mem >= 6 && cores >= 8 ? 'medium' : 'low';
  if (cores >= 8 && (mem === undefined || mem >= 8)) return 'high';
  return 'medium';
}

export function createViewer(container: HTMLElement, terrain: TerrainProvider): Viewer {
  const mobile = matchMedia('(pointer: coarse)').matches;
  const viewer = new Viewer(container, {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    vrButton: false,
    projectionPicker: false,
    terrainProvider: terrain,
    shouldAnimate: true,
    msaaSamples: mobile ? 1 : 4,
    useBrowserRecommendedResolution: true,
    contextOptions: { webgl: { alpha: false, powerPreference: 'high-performance' } },
    orderIndependentTranslucency: false,
  });
  const scene = viewer.scene;
  scene.globe.baseColor = Color.fromCssColorString('#2c3a46');
  scene.globe.enableLighting = true;
  scene.globe.dynamicAtmosphereLighting = true;
  scene.globe.dynamicAtmosphereLightingFromSun = true;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.preloadSiblings = true;
  scene.globe.tileCacheSize = mobile ? 200 : 600;
  scene.highDynamicRange = true;
  scene.fog.enabled = true;
  scene.fog.density = 1.2e-4;
  scene.fog.minimumBrightness = 0.03;
  scene.skyAtmosphere.show = true;
  scene.sun.show = true;
  scene.moon.show = true;
  scene.screenSpaceCameraController.enableInputs = false;
  scene.camera.frustum.near = 0.1;
  viewer.shadowMap.softShadows = true;
  viewer.shadowMap.size = 2048;
  viewer.shadowMap.maximumDistance = 1200;
  viewer.shadowMap.darkness = 0.45;
  viewer.shadows = false;
  viewer.terrainShadows = ShadowMode.RECEIVE_ONLY;
  // keep credits small: move the credit container into the bottom-left corner (styled in CSS)
  return viewer;
}

export function applyQuality(viewer: Viewer, q: QualityPreset) {
  const scene = viewer.scene;
  viewer.resolutionScale = q.resolutionScale;
  scene.msaaSamples = q.msaa;
  scene.globe.maximumScreenSpaceError = q.globeSSE;
  viewer.shadows = q.shadows;
  scene.postProcessStages.fxaa.enabled = q.fxaa;
  const ao = scene.postProcessStages.ambientOcclusion;
  ao.enabled = q.ao;
  if (q.ao) {
    ao.uniforms.intensity = 2.2;
    ao.uniforms.bias = 0.1;
    ao.uniforms.lengthCap = 0.26;
    ao.uniforms.stepSize = 1.5;
    ao.uniforms.blurStepSize = 0.86;
  }
}
