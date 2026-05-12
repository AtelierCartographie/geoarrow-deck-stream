/**
 * Test Viewer - Demonstrates automatic layer routing based on geometry type
 * 
 * Supports:
 * - Point / MultiPoint → ScatterplotLayer
 * - LineString / MultiLineString → PathLayer  
 * - Polygon / MultiPolygon → SolidPolygonLayer
 */

import { Deck, OrthographicView } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { 
  geoIdentity, 
  geoMercator, 
  geoOrthographic,
  geoEqualEarth,
  geoNaturalEarth1,
  geoConicConformal
} from 'd3-geo';
import { tableFromIPC } from 'apache-arrow';

import {
  // Geometry detection
  detectGeometryType,
  getLayerType,
  // WKB support
  decodeWkbColumn,
  // Parsers by layer type
  parseGeometry,
  parseGeometryWithStats,
  parsePoints,
  parsePolygonsToSolid,
  parseSphere,
  // Layer props helpers
  createScatterplotLayerProps,
  createTextLayerProps,
  createPathLayerProps,
  createSolidPolygonLayerProps,
  createColorAttribute,
  createPolygonFillColorAttribute,
  // Utilities
  calculateBounds,
  createOrthographicViewState,
  setLogging,
  // Composite Projections
  buildCompositeProjection,
  PRESET_LAYOUTS,
  TERRITORY_BOUNDS,
  createInsetBorderData,
  createInsetBorderBinaryData
} from '../dist/index.js';

// =============================================================================
// Logging
// =============================================================================

let loggingEnabled = false;

function log(...args) {
  if (loggingEnabled) console.log(...args);
}

function warn(...args) {
  if (loggingEnabled) console.warn(...args);
}

function error(...args) {
  console.error(...args); // Always show errors
}

// =============================================================================
// State
// =============================================================================

let deck;
let currentTable = null;
let currentGeometryType = null;
let currentAttributes = null;
let animationFrame = null;

// =============================================================================
// Initialize Deck.gl
// =============================================================================

function initDeck() {
  log('🎨 Initializing Deck.gl...');
  deck = new Deck({
    canvas: 'deck-canvas',
    width: '100%',
    height: '100%',
    views: new OrthographicView(),
    initialViewState: {
      target: [0, 0, 0],
      zoom: 0
    },
    controller: true,
    layers: []
  });
  log('✅ Deck.gl initialized');
  document.getElementById('loading').style.display = 'none';
}

// =============================================================================
// Load Arrow file
// =============================================================================

async function loadArrowFile(filename) {
  try {
    log('📦 Loading Arrow file:', filename);
    const response = await fetch(`test-data/${filename}.arrow`);
    if (!response.ok) {
      throw new Error(`Failed to load ${filename}.arrow: ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    log('📊 ArrayBuffer size:', arrayBuffer.byteLength, 'bytes');
    
    let table = tableFromIPC(arrayBuffer);
    log('✅ Arrow table parsed:', table.numRows, 'rows,', table.numCols, 'columns');
    
    // Detect geometry type from metadata
    let geometryType = detectGeometryType(table);
    
    // If WKB, decode to native GeoArrow and re-detect
    if (geometryType === 'wkb') {
      log('🔄 WKB detected, decoding to native GeoArrow...');
      const result = decodeWkbColumn(table);
      table = result.table;
      geometryType = result.geometryType;
      log('✅ WKB decoded → native', geometryType);
    }
    
    const layerType = getLayerType(geometryType);
    log('🔍 Detected geometry type:', geometryType, '→', layerType);
    
    // Extract non-geometry attributes
    const attributes = {};
    for (const field of table.schema.fields) {
      if (field.name !== 'geometry') {
        const col = table.getChild(field.name);
        if (col) {
          attributes[field.name] = col.toArray();
        }
      }
    }
    log('📋 Attributes:', Object.keys(attributes));
    
    return { table, geometryType, layerType, attributes };
  } catch (err) {
    error('Error loading Arrow file:', err);
    throw err;
  }
}

// =============================================================================
// Create projection from settings
// =============================================================================

function createProjection() {
  const projType = document.getElementById('projection').value;
  const rotLon = parseFloat(document.getElementById('rotLon').value);
  const rotLat = parseFloat(document.getElementById('rotLat').value);
  const scale = parseFloat(document.getElementById('scale').value);
  
  switch (projType) {
    case 'identity':
      return geoIdentity().reflectY(true);
    
    case 'mercator':
      return geoMercator()
        .center([rotLon, 0])
        .translate([512, 384])
        .scale(scale);
    
    case 'orthographic':
      return geoOrthographic()
        .rotate([-rotLon, -rotLat, 0])
        .translate([512, 384])
        .scale(scale)
        .clipAngle(90);
    
    case 'equalEarth':
      return geoEqualEarth()
        .rotate([-rotLon, 0, 0])
        .translate([512, 384])
        .scale(scale);
    
    case 'naturalEarth':
      return geoNaturalEarth1()
        .rotate([-rotLon, 0, 0])
        .translate([512, 384])
        .scale(scale);

    case 'compositeFrance':
      return buildCompositeProjection({
        width: 1024, // Use canvas width approx
        height: 768,
        entries: [
          {
            id: 'mainland',
            projection: geoConicConformal().parallels([44, 49]).rotate([-3, 0]),
            bounds: TERRITORY_BOUNDS.FRANCE_MAINLAND,
            layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.mainland
          },
          {
            id: 'guadeloupe',
            projection: geoMercator().center([-61.7, 16.2]),
            bounds: TERRITORY_BOUNDS.GUADELOUPE,
            layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.guadeloupe,
            scaleMultiplier: 1.5
          },
          {
            id: 'martinique',
            projection: geoMercator(),
            bounds: TERRITORY_BOUNDS.MARTINIQUE,
            layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.martinique,
            scaleMultiplier: 1.5
          },
          {
            id: 'guyane',
            projection: geoMercator().center([-53, 4]),
            bounds: TERRITORY_BOUNDS.GUYANE,
            layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.guyane,
            scaleMultiplier: 0.7
          },
          {
            id: 'reunion',
            projection: geoMercator(),
            bounds: TERRITORY_BOUNDS.REUNION,
            layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.reunion,
            scaleMultiplier: 1.5
          },
          {
            id: 'mayotte',
            projection: geoMercator(),
            bounds: TERRITORY_BOUNDS.MAYOTTE,
            layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.mayotte,
            scaleMultiplier: 1.5
          }
        ]
      })
      // Apply user scale/rotation if needed, but composite handles its own layout usually
      .scale(scale / 250) // Normalize based on default
      .translate([512 + rotLon * 2, 384 + rotLat * 2]); // Rough manual adjust

    case 'compositeUSA':
      return buildCompositeProjection({
        width: 1024,
        height: 768,
        entries: [
          {
            id: 'lower48',
            projection: geoMercator(), // or Albers
            bounds: TERRITORY_BOUNDS.USA_LOWER48,
            layout: PRESET_LAYOUTS.USA_ALASKA_HAWAII.lower48
          },
          {
            id: 'alaska',
            projection: geoMercator(), // or Conic Equal Area
            bounds: TERRITORY_BOUNDS.ALASKA,
            layout: PRESET_LAYOUTS.USA_ALASKA_HAWAII.alaska
          },
          {
            id: 'hawaii',
            projection: geoMercator(),
            bounds: TERRITORY_BOUNDS.HAWAII,
            layout: PRESET_LAYOUTS.USA_ALASKA_HAWAII.hawaii
          }
        ]
      })
      .scale(scale / 250)
      .translate([512 + rotLon, 384 + rotLat]);
    
    default:
      return geoIdentity();
  }
}

// =============================================================================
// Parse and render based on geometry type
// =============================================================================

function parseAndRender() {
  if (!currentTable) {
    warn('⚠️ No table loaded yet');
    return;
  }
  
  try {
    log('🔄 Parsing and rendering...');
    const projection = createProjection();
    const layerType = getLayerType(currentGeometryType);
    
    let layer;
    let data;
    let stats = null;
    let borderLayer = null;

    // Handle Composite Projection Borders
    if (layerType === 'compositeFrance' || layerType === 'compositeUSA' || 
        // Better check: is it our custom composite object?
        (projection && typeof projection.getInsetBorders === 'function')) {
      
      const borders = createInsetBorderData(projection);
      if (borders && borders.length > 0) {
        log('🖼️ Creating inset borders layer');
        borderLayer = new PathLayer({
          id: 'inset-borders',
          data: borders,
          getPath: d => d.path,
          getColor: [100, 100, 100, 200],
          getWidth: 2,
          widthMinPixels: 1,
          pickable: false
        });
      }
    }
    
    const startTime = performance.now();
    
    // Route to appropriate parser based on layer type
    switch (layerType) {
      case 'scatterplot': {
        // Point / MultiPoint → ScatterplotLayer
        log('📍 Parsing as points...');
        data = parsePoints(currentTable, { projection });
        
        const props = createScatterplotLayerProps(data);
        const useText = document.getElementById('renderAsText')?.checked;

        if (useText) {
             // ALTERNATIVE: PROXY ACCESSOR (Robust for TextLayer)
             // TextLayer struggles with hybrid binary+js mode. 
             // Instead, we read from the binary arrays via a JS accessor.

             // Assume "name" column exists or use index
             let labelCol = null;
             // Check for common name columns
             for (const col of ['name', 'NAME', 'nom', 'label', 'admin', 'admin_0']) {
               if (currentTable.getChild(col)) {
                 labelCol = currentTable.getChild(col);
                 log("Found label column:", col);
                 break;
               }
             }
             
             layer = new TextLayer({
               id: 'text-layer',
               
               // 1. DATA: Virtual array to trigger JS accessors
               data: new Array(data.featureIds.length).fill(null),
               
               // 2. POSITION: Read manually from binary buffer
               // This bridges the Gap between "Zero-Copy Parsing" and "Complex Layers"
               getPosition: (_, {index}) => {
                   const i = index * 2;
                   return [data.positions[i], data.positions[i+1]];
               },
               
               // 3. TEXT: Dynamic lookup via Feature ID
               getText: (_, {index}) => {
                   const featureId = data.featureIds[index];
                   if (labelCol) return String(labelCol.get(featureId));
                   return String(featureId);
               },
               
               getSize: 14,
               getColor: [255, 255, 255],
               getBackgroundColor: [0, 0, 0, 200], // Background to make readable
               pickable: true,
               background: true,
               
               // Ensure updates when projection changes
               updateTriggers: {
                   getPosition: [data.positions], 
                   getText: [data.featureIds]
               }
             });

        } else {
            layer = new ScatterplotLayer({
              id: 'points',
              ...props,
              getRadius: 5,
              radiusMinPixels: 2,
              radiusMaxPixels: 10,
              getFillColor: [255, 100, 100, 200],
              getLineColor: [0, 0, 0, 255],
              stroked: true,
              lineWidthMinPixels: 1,
              pickable: true
            });
        }
        break;
      }
      
      case 'path': {
        // LineString / MultiLineString → PathLayer
        log('📏 Parsing as paths...');
        const result = parseGeometryWithStats(currentTable, {
          projection,
          debug: loggingEnabled,
          debugSampleLimit: 32
        });
        data = result.data;
        stats = result.stats;
        
        const width = parseFloat(document.getElementById('width').value);
        const colorByAttr = document.getElementById('colorByAttribute').checked;
        
        let layerProps = createPathLayerProps(data);
        
        // Optional: color by attribute
        if (colorByAttr && currentAttributes?.population) {
          const popArray = currentAttributes.population;
          const maxPop = Math.max(...popArray);
          
          const colorAttr = createColorAttribute(data, (featureId) => {
            const pop = popArray[featureId] || 0;
            const normalized = pop / maxPop;
            return [
              Math.floor(255 * normalized),
              100,
              Math.floor(255 * (1 - normalized)),
              255
            ];
          });
          
          layerProps = {
            ...layerProps,
            data: {
              ...layerProps.data,
              attributes: {
                ...layerProps.data.attributes,
                getColor: colorAttr
              }
            }
          };
        }
        
        layer = new PathLayer({
          id: 'paths',
          ...layerProps,
          getColor: colorByAttr ? undefined : [255, 255, 255],
          getWidth: width,
          widthMinPixels: 0.5,
          pickable: true
        });
        break;
      }
      
      case 'solid-polygon': {
        // Polygon / MultiPolygon → SolidPolygonLayer
        log('🔷 Parsing as polygons...');
        const rewind = document.getElementById('rewind').checked;
        data = parsePolygonsToSolid(currentTable, { projection, rewind });
        
        const colorByAttr = document.getElementById('colorByAttribute').checked;
        let layerProps = createSolidPolygonLayerProps(data);
        
        // Optional: color by attribute  
        if (colorByAttr && currentAttributes?.population) {
          const popArray = currentAttributes.population;
          const maxPop = Math.max(...popArray);
          
          const fillColorAttr = createPolygonFillColorAttribute(data, (featureId) => {
            const pop = popArray[featureId] || 0;
            const normalized = pop / maxPop;
            return [
              Math.floor(255 * normalized),
              100,
              Math.floor(255 * (1 - normalized)),
              200
            ];
          });
          
          layerProps = {
            ...layerProps,
            data: {
              ...layerProps.data,
              attributes: {
                ...layerProps.data.attributes,
                getFillColor: fillColorAttr
              }
            }
          };
        }
        
        layer = new SolidPolygonLayer({
          id: 'polygons',
          ...layerProps,
          getFillColor: colorByAttr ? undefined : [100, 150, 255, 180],
          getLineColor: [0, 0, 0, 255],
          // lineWidthMinPixels: 1,
          // pickable: true
        });
        break;
      }
      
      default:
        throw new Error(`Unknown layer type: ${layerType}`);
    }
    
    const endTime = performance.now();
    
    // Update stats display
    if (stats) {
      document.getElementById('inputFeatures').textContent = stats.inputFeatures;
      document.getElementById('outputPaths').textContent = stats.outputPaths;
      document.getElementById('inputCoords').textContent = stats.inputCoordinates.toLocaleString();
      document.getElementById('outputCoords').textContent = stats.outputCoordinates.toLocaleString();
      document.getElementById('parseTime').textContent = stats.processingTimeMs.toFixed(2) + ' ms';
      document.getElementById('memory').textContent = (stats.peakMemoryBytes / 1024).toFixed(1) + ' KB';
    } else {
      document.getElementById('inputFeatures').textContent = currentTable.numRows;
      document.getElementById('outputPaths').textContent = data.length;
      document.getElementById('inputCoords').textContent = '-';
      document.getElementById('outputCoords').textContent = (data.positions.length / 2).toLocaleString();
      document.getElementById('parseTime').textContent = (endTime - startTime).toFixed(2) + ' ms';
      document.getElementById('memory').textContent = (data.positions.byteLength / 1024).toFixed(1) + ' KB';
    }
    document.getElementById('stats').style.display = 'block';
    
    // Render layer
    const layers = [];

    // Sphere layer (rendered first, as background)
    const showSphere = document.getElementById('showSphere')?.checked;
    if (showSphere) {
      try {
        const sphereMode = document.getElementById('sphereMode')?.value ?? 'polygon';
        const sphereData = parseSphere(projection, { output: sphereMode });
        if (sphereMode === 'polygon') {
          const sphereProps = createSolidPolygonLayerProps(sphereData);
          layers.push(new SolidPolygonLayer({
            id: 'sphere-polygon',
            ...sphereProps,
            getFillColor: [20, 40, 80, 220],
            _normalize: false
          }));
        } else {
          const sphereProps = createPathLayerProps(sphereData);
          layers.push(new PathLayer({
            id: 'sphere-path',
            ...sphereProps,
            getColor: [80, 160, 255, 200],
            getWidth: 2,
            widthMinPixels: 1
          }));
        }
        log('🌐 Sphere layer added in', sphereMode, 'mode');
      } catch (sphereErr) {
        warn('⚠️ Sphere generation failed:', sphereErr.message);
      }
    }

    layers.push(layer);
    if (borderLayer) {
      layers.push(borderLayer);
    }
    deck.setProps({ layers });
    log('✅ Layer rendered:', layerType, 'with', data.length, 'features');
    
    // Auto-fit view for identity projection
    if (document.getElementById('projection').value === 'identity') {
      const bounds = calculateBounds(data);
      if (bounds.minX !== Infinity) {
        const viewState = createOrthographicViewState(data);
        deck.setProps({ initialViewState: viewState });
      }
    }
    
    document.getElementById('error').style.display = 'none';
  } catch (err) {
    error('Parse error:', err);
    document.getElementById('error').textContent = `Error: ${err.message}`;
    document.getElementById('error').style.display = 'block';
  }
}

// =============================================================================
// Animation
// =============================================================================

function startAnimation() {
  if (animationFrame) return;
  
  let rotation = parseFloat(document.getElementById('rotLon').value);
  
  function animate() {
    rotation += 0.5;
    if (rotation > 180) rotation = -180;
    
    document.getElementById('rotLon').value = rotation;
    document.getElementById('rotLonValue').textContent = rotation.toFixed(0) + '°';
    
    parseAndRender();
    animationFrame = requestAnimationFrame(animate);
  }
  
  animate();
}

function stopAnimation() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
}

// =============================================================================
// Event Handlers
// =============================================================================

document.getElementById('loadBtn').addEventListener('click', async () => {
  const dataset = document.getElementById('dataset').value;
  log('🔘 Load button clicked, dataset:', dataset);
  if (!dataset) {
    alert('Please select a dataset');
    return;
  }
  
  document.getElementById('loadBtn').disabled = true;
  document.getElementById('loadBtn').textContent = 'Loading...';
  
  try {
    const { table, geometryType, layerType, attributes } = await loadArrowFile(dataset);
    
    currentTable = table;
    currentGeometryType = geometryType;
    currentAttributes = attributes;
    
    log('✅ Data loaded:', geometryType, '→', layerType);
    
    // Update UI to show detected type
    const typeLabel = document.getElementById('detectedType');
    if (typeLabel) {
      typeLabel.textContent = `${geometryType} → ${layerType}`;
    }
    
    parseAndRender();
    
    document.getElementById('loadBtn').textContent = 'Reload & Parse';
  } catch (err) {
    document.getElementById('error').textContent = `Error: ${err.message}`;
    document.getElementById('error').style.display = 'block';
    document.getElementById('loadBtn').textContent = 'Load & Parse';
  } finally {
    document.getElementById('loadBtn').disabled = false;
  }
});

// Projection change
document.getElementById('projection').addEventListener('change', () => {
  if (currentTable) parseAndRender();
});

// Rewind toggle (force re-parse)
document.getElementById('rewind').addEventListener('change', () => {
  if (currentTable) parseAndRender();
});

// Render as text toggle
document.getElementById('renderAsText').addEventListener('change', () => {
    if (currentTable) parseAndRender();
});

// Range sliders
document.getElementById('rotLon').addEventListener('input', (e) => {
  document.getElementById('rotLonValue').textContent = e.target.value + '°';
  if (currentTable && !document.getElementById('animate').checked) {
    parseAndRender();
  }
});

document.getElementById('rotLat').addEventListener('input', (e) => {
  document.getElementById('rotLatValue').textContent = e.target.value + '°';
  if (currentTable && !document.getElementById('animate').checked) {
    parseAndRender();
  }
});

document.getElementById('scale').addEventListener('input', (e) => {
  document.getElementById('scaleValue').textContent = e.target.value;
  if (currentTable) parseAndRender();
});

document.getElementById('width').addEventListener('input', (e) => {
  document.getElementById('widthValue').textContent = e.target.value;
  if (currentTable) parseAndRender();
});

// Animation toggle
document.getElementById('animate').addEventListener('change', (e) => {
  if (e.target.checked) {
    startAnimation();
  } else {
    stopAnimation();
  }
});

// Color mode
document.getElementById('colorByAttribute').addEventListener('change', () => {
  if (currentTable) parseAndRender();
});

// Logging toggle
document.getElementById('enableLogging').addEventListener('change', (e) => {
  loggingEnabled = e.target.checked;
  setLogging(e.target.checked);
  if (e.target.checked) {
    console.log('✅ Logging enabled');
  }
});

// Sphere controls
document.getElementById('showSphere').addEventListener('change', () => {
  if (currentTable) parseAndRender();
});
document.getElementById('sphereMode').addEventListener('change', () => {
  if (currentTable) parseAndRender();
});

// Initialize
initDeck();
