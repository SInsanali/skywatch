import { useRef, useCallback, useEffect } from 'react';
import { Viewer } from 'resium';
import {
  Viewer as CesiumViewer,
  Cartesian3,
  Color,
  Math as CesiumMath,
  UrlTemplateImageryProvider,
  IonImageryProvider,
  TileProviderError,
} from 'cesium';

export type MapStyle = 'dark' | 'satellite';

interface GlobeProps {
  mapStyle: MapStyle;
  onViewerReady?: (viewer: CesiumViewer) => void;
  children?: React.ReactNode;
}

// Dark base map (no labels)
const darkBaseTiles = new UrlTemplateImageryProvider({
  url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
  subdomains: ['a', 'b', 'c', 'd'],
  maximumLevel: 18,
  tileWidth: 512,
  tileHeight: 512,
  credit: 'CARTO / OSM',
});

// Dark mode labels (CARTO dark labels — subtle, thin)
const darkLabelTiles = new UrlTemplateImageryProvider({
  url: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png',
  subdomains: ['a', 'b', 'c', 'd'],
  maximumLevel: 18,
  tileWidth: 512,
  tileHeight: 512,
  credit: 'CARTO / OSM',
});

export default function Globe({ mapStyle, onViewerReady, children }: GlobeProps) {
  const initialized = useRef(false);
  const viewerRef = useRef<CesiumViewer | null>(null);

  const handleViewerReady = useCallback((cesiumElement: CesiumViewer) => {
    if (initialized.current) return;
    initialized.current = true;
    viewerRef.current = cesiumElement;

    try {
      const globe = cesiumElement.scene.globe;
      globe.baseColor = Color.fromCssColorString('#0a1628');
      globe.showGroundAtmosphere = true;
      globe.enableLighting = true;
      // Lighten the night side so country labels stay readable
      for (let i = 0; i < globe.imageryLayers.length; i++) { globe.imageryLayers.get(i).nightAlpha = 0.55; }

      if (cesiumElement.scene.skyAtmosphere) {
        cesiumElement.scene.skyAtmosphere.show = true;
      }
      cesiumElement.scene.fog.enabled = true;

      const credit = cesiumElement.cesiumWidget.creditContainer as HTMLElement;
      if (credit) credit.style.display = 'none';

      // Cap resolution scale — full devicePixelRatio on Retina renders 4x pixels
      cesiumElement.resolutionScale = Math.min(window.devicePixelRatio, 1.5);

      // Only re-render when something changes (camera move, entity update)
      cesiumElement.scene.requestRenderMode = true;
      cesiumElement.scene.maximumRenderTimeChange = 0.5;

      cesiumElement.scene.screenSpaceCameraController.zoomFactor = 3;
      cesiumElement.scene.screenSpaceCameraController.minimumZoomDistance = 200;
      cesiumElement.scene.screenSpaceCameraController.maximumZoomDistance = 50_000_000;

      cesiumElement.camera.setView({
        destination: Cartesian3.fromDegrees(-40, 30, 20_000_000),
        orientation: {
          heading: CesiumMath.toRadians(0),
          pitch: CesiumMath.toRadians(-90),
          roll: 0,
        },
      });

      // Log rendering / WebGL errors instead of swallowing them
      cesiumElement.scene.renderError.addEventListener((_scene: any, error: any) => {
        console.error('[Skywatch] Scene render error:', error);
      });

      // Log imagery tile load failures
      cesiumElement.scene.globe.imageryLayers.layerAdded.addEventListener((layer: any) => {
        layer.imageryProvider.errorEvent?.addEventListener((err: TileProviderError) => {
          console.error('[Skywatch] Tile load failed:', err.message, err);
        });
      });

      applyMapStyle(cesiumElement, mapStyle);
      if (onViewerReady) onViewerReady(cesiumElement);
    } catch (e) {
      console.error('Globe init error:', e);
    }
  }, []);

  useEffect(() => {
    if (viewerRef.current) {
      applyMapStyle(viewerRef.current, mapStyle);
    }
  }, [mapStyle]);

  return (
    <Viewer
      full
      ref={(e: any) => {
        if (e?.cesiumElement) handleViewerReady(e.cesiumElement);
      }}
      animation={false}
      timeline={false}
      baseLayerPicker={false}
      geocoder={false}
      homeButton={false}
      sceneModePicker={false}
      navigationHelpButton={false}
      fullscreenButton={false}
      selectionIndicator={false}
      infoBox={false}
    >
      {children}
    </Viewer>
  );

  async function applyMapStyle(viewer: CesiumViewer, style: MapStyle) {
    const layers = viewer.imageryLayers;
    layers.removeAll();

    if (style === 'dark') {
      // Dark base + Bing road overlay for English labels/borders
      layers.addImageryProvider(darkBaseTiles);
      try {
        const bingRoad = await IonImageryProvider.fromAssetId(4);
        const roadLayer = layers.addImageryProvider(bingRoad);
        roadLayer.alpha = 0.2;
      } catch (e) {
        console.error('[Skywatch] Failed to load Bing road overlay:', e);
      }
    } else {
      // ESRI World Imagery (no baked-in labels at any zoom) + CARTO English
      // label overlay. Bing aerial assets (2 and 3) ship continent/country
      // labels rendered into the tiles in multiple languages, which we don't
      // want.
      layers.addImageryProvider(new UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 19,
        credit: 'Esri',
      }));
      layers.addImageryProvider(darkLabelTiles);
    }
    // Keep night side lighter so labels stay readable
    for (let i = 0; i < layers.length; i++) { layers.get(i).nightAlpha = 0.55; }
  }
}
