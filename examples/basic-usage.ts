/**
 * Example: Basic Usage with DuckDB-WASM
 * 
 * Demonstrates the complete pipeline from DuckDB query to Deck.gl rendering
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import { Deck } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { OrthographicView } from '@deck.gl/core';
import { geoMollweide, geoOrthographic, geoIdentity } from 'd3-geo';

import {
  parseLineStrings,
  extractGeoArrowBuffers,
  createPathLayerProps,
  createColorAttribute,
  calculateBounds,
  createOrthographicViewState
} from 'geoarrow-deck-stream';

// =============================================================================
// Setup DuckDB
// =============================================================================

async function initDuckDB() {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
  
  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  
  const worker = new Worker(worker_url);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(worker_url);
  
  // Load spatial extension
  const conn = await db.connect();
  await conn.query(`INSTALL spatial; LOAD spatial;`);
  
  return { db, conn };
}

// =============================================================================
// Example 1: Reprojection Mode (WGS84 → Globe)
// =============================================================================

async function exampleGlobeProjection() {
  const { conn } = await initDuckDB();
  
  // Query GeoArrow data from DuckDB
  // This returns LineStrings in WGS84 (lon/lat)
  const result = await conn.query(`
    SELECT geometry 
    FROM ST_Read('countries.geojson')
    WHERE ST_GeometryType(geometry) = 'LINESTRING'
  `);
  
  // Extract Arrow buffers (zero-copy)
  const geometryColumn = extractGeoArrowBuffers(result.getChildAt(0));
  
  // Configure projection - Orthographic globe centered on Europe
  const projection = geoOrthographic()
    .rotate([-10, -45, 0])    // Center on Europe
    .translate([400, 300])     // Center in viewport
    .scale(200)                // Globe size
    .clipAngle(90);            // Clip to hemisphere
  
  // Parse: GeoArrow → D3 projection stream → Binary Deck.gl format
  // This single call handles everything:
  // - Reading Arrow buffers
  // - Projecting coordinates
  // - Clipping at globe edge
  // - Splitting features that cross boundaries
  // - Writing to TypedArrays
  const binaryData = parseLineStrings(geometryColumn, { projection });
  
  console.log(`Input: ${geometryColumn.length} features`);
  console.log(`Output: ${binaryData.length} paths (some may be split)`);
  
  // Create Deck.gl layer
  const pathLayer = new PathLayer({
    id: 'globe-paths',
    ...createPathLayerProps(binaryData),
    getColor: [100, 150, 200],
    getWidth: 1,
    widthMinPixels: 1
  });
  
  // Render with OrthographicView (2D cartesian, not MapView)
  new Deck({
    container: 'deck-container',
    views: new OrthographicView(),
    initialViewState: {
      target: [400, 300, 0],
      zoom: 0
    },
    controller: true,
    layers: [pathLayer]
  });
}

// =============================================================================
// Example 2: Pass-through Mode (Lambert 93 → Deck.gl)
// =============================================================================

async function examplePassThrough() {
  const { conn } = await initDuckDB();
  
  // Query data already in Lambert 93 projection (EPSG:2154)
  // Coordinates are in meters, not degrees
  const result = await conn.query(`
    SELECT geometry 
    FROM ST_Read('france_lambert93.parquet')
  `);
  
  const geometryColumn = extractGeoArrowBuffers(result.getChildAt(0));
  
  // geoIdentity() passes coordinates through unchanged
  // reflectY(true) flips Y axis (common for screen coordinates)
  const projection = geoIdentity()
    .reflectY(true);
  
  // Same parsing code works for both reprojection and pass-through!
  const binaryData = parseLineStrings(geometryColumn, { projection });
  
  // Calculate appropriate view state from data bounds
  const viewState = createOrthographicViewState(binaryData);
  
  const pathLayer = new PathLayer({
    id: 'lambert-paths',
    ...createPathLayerProps(binaryData),
    getColor: [200, 100, 100],
    getWidth: 2
  });
  
  new Deck({
    container: 'deck-container',
    views: new OrthographicView(),
    initialViewState: viewState,
    controller: true,
    layers: [pathLayer]
  });
}

// =============================================================================
// Example 3: Attribute Mapping with Split Features
// =============================================================================

async function exampleAttributeMapping() {
  const { conn } = await initDuckDB();
  
  // Query geometry AND attributes
  const result = await conn.query(`
    SELECT 
      geometry,
      population,
      name
    FROM ST_Read('countries.geojson')
  `);
  
  const geometryColumn = extractGeoArrowBuffers(result.getChildAt(0));
  
  // Get attribute arrays
  const populationArray = result.getChildAt(1)?.toArray() as Float64Array;
  const nameArray = result.getChildAt(2)?.toArray() as string[];
  
  const projection = geoMollweide()
    .translate([400, 250])
    .scale(100);
  
  const binaryData = parseLineStrings(geometryColumn, { projection });
  
  // Create color scale based on population
  // Use featureIds to map back to original data
  const maxPop = Math.max(...populationArray);
  const colorAttribute = createColorAttribute(binaryData, (featureId) => {
    const pop = populationArray[featureId];
    const normalized = pop / maxPop;
    return [
      Math.floor(255 * normalized),  // Red
      50,                             // Green
      Math.floor(255 * (1 - normalized)), // Blue
      255                             // Alpha
    ];
  });
  
  // When Russia is split at the antimeridian:
  // - Path A (Western Russia) has featureId = originalRussiaIndex
  // - Path B (Eastern Russia) has featureId = originalRussiaIndex
  // Both get the same color from populationArray[originalRussiaIndex]
  
  const pathLayer = new PathLayer({
    id: 'attributed-paths',
    data: {
      length: binaryData.length,
      startIndices: binaryData.startIndices,
      attributes: {
        getPath: {
          value: binaryData.positions,
          size: 2
        },
        getColor: colorAttribute
      }
    },
    _pathType: 'open',
    getWidth: 2,
    pickable: true,
    
    // Custom picking to show original feature name
    onHover: (info) => {
      if (info.index >= 0) {
        const featureId = binaryData.featureIds[info.index];
        console.log(`Hovering: ${nameArray[featureId]}`);
      }
    }
  });
  
  new Deck({
    container: 'deck-container',
    views: new OrthographicView(),
    initialViewState: {
      target: [400, 250, 0],
      zoom: 0
    },
    controller: true,
    layers: [pathLayer]
  });
}

// =============================================================================
// Example 4: Real-time Rotation
// =============================================================================

async function exampleAnimatedGlobe() {
  const { conn } = await initDuckDB();
  
  const result = await conn.query(`
    SELECT geometry FROM ST_Read('world.geojson')
  `);
  
  const geometryColumn = extractGeoArrowBuffers(result.getChildAt(0));
  
  let rotation = 0;
  
  function render() {
    // Update projection rotation
    const projection = geoOrthographic()
      .rotate([rotation, -20, 0])
      .translate([400, 300])
      .scale(250)
      .clipAngle(90);
    
    // Re-parse with new projection
    // Fast enough for 60fps with moderate data sizes
    const binaryData = parseLineStrings(geometryColumn, { projection });
    
    const pathLayer = new PathLayer({
      id: 'rotating-globe',
      ...createPathLayerProps(binaryData),
      getColor: [60, 100, 150],
      getWidth: 1
    });
    
    deck.setProps({ layers: [pathLayer] });
    
    rotation += 0.5;
    requestAnimationFrame(render);
  }
  
  const deck = new Deck({
    container: 'deck-container',
    views: new OrthographicView(),
    initialViewState: {
      target: [400, 300, 0],
      zoom: 0
    },
    layers: []
  });
  
  render();
}

// Run examples
// exampleGlobeProjection();
// examplePassThrough();
// exampleAttributeMapping();
// exampleAnimatedGlobe();
