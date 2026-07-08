# GeoArrow Deck Stream

High-performance GeoArrow to Deck.gl binary parser using d3-geo streaming.

## Overview

This module provides a **zero-serialization pipeline** for transforming GeoArrow geometries into Deck.gl-ready binary buffers. It handles both:

1. **Reprojection**: Transform WGS84 (lon/lat) data to any d3-geo projection
2. **Pass-through**: Standardize already-projected data (Lambert 93, UTM, etc.) for Deck.gl

### Key Features

- ⚡ **Zero-copy Arrow access**: Reads directly from Arrow binary buffers
- 🚀 **No object allocation**: No `{x, y}` objects in the hot path
- 🔄 **Unified code path**: Same API for reprojection and identity transforms
- ✂️ **Automatic feature splitting**: Handles antimeridian/clipping correctly
- 🎯 **Feature ID mapping**: Split geometries maintain reference to source data
- 🌐 **Full Geometry Support**: Points, LineStrings, Polygons (with holes), Multi-geometries
- 🌪️ **Spherical Winding**: Automatic correction of ring direction (Rewind / Right-Hand Rule) using `d3-geo`
- 🔺 **Integrated Triangulation**: Uses `earcut` internally to perform triangulation for `SolidPolygonLayer`

## Supported Input Formats

The library accepts Apache Arrow tables with geometry columns in three formats:

| Format                   | Extension Name                                | Description                                                                                    |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **GeoArrow Interleaved** | `geoarrow.point`, `geoarrow.linestring`, etc. | Coordinates as `[x,y,x,y,...]` in a single `Float64Array`. Default in DuckDB-WASM, GeoParquet. |
| **GeoArrow Separated**   | Same as above                                 | Coordinates as separate `x[]` and `y[]` arrays (Apache Arrow Struct encoding).                 |
| **GeoArrow WKB**         | `geoarrow.wkb`                                | Well-Known Binary blobs in a `Binary` column. Auto-decoded to native GeoArrow before parsing.  |

All geometry types are supported: **Point**, **MultiPoint**, **LineString**, **MultiLineString**, **Polygon** (with holes), **MultiPolygon**.

### WKB Support

WKB input (`geoarrow.wkb`) is **transparently decoded** — all parse functions (`parseGeometry`, `parsePoints`, `parsePolygonsToSolid`) detect WKB columns and convert them to native GeoArrow automatically. No additional code is needed.

For explicit control, you can also decode WKB manually:

```typescript
import { decodeWkbColumn, isWkbGeometryColumn } from "@ateliercartographie/geoarrow-deck-stream";

// Check if table has WKB geometry
if (isWkbGeometryColumn(table)) {
  const { table: nativeTable, geometryType } = decodeWkbColumn(table);
  console.log(`Decoded WKB → ${geometryType}`); // e.g. "multipolygon"
}
```

Supported WKB features:

- Little-endian and big-endian byte order
- 2D, 3D (Z), and 4D (ZM) coordinates (Z/M values are dropped for Deck.gl)
- ISO WKB and EWKB (PostGIS) variants with SRID
- NULL geometry handling (validity bitmap)
- Mixed type promotion (e.g., Polygon + MultiPolygon → MultiPolygon)

## CRS Detection & Projection Strategy

GeoArrow inputs may be in WGS84 (requiring reprojection) or already projected (requiring pass-through). This library provides utilities to detect the CRS and choose the correct strategy, compliant with GeoArrow and GeoParquet specifications.

```typescript
import {
  isWGS84,
  getProjectionStrategy,
  extractCRSFromArrow,
} from "@ateliercartographie/geoarrow-deck-stream";
import { geoMercator, geoIdentity } from "d3-geo";

// 1. Quick Check (Most Common)
const projection = isWGS84(table)
  ? geoMercator().fitSize([width, height], bounds)
  : geoIdentity(); // Pass-through for pre-projected data

// 2. Advanced Strategy
const strategy = getProjectionStrategy(table);
// returns: 'reproject' | 'passthrough' | 'unknown'

if (strategy === "unknown") {
  console.warn("CRS unknown - assuming WGS84 or asking user");
}

// 3. Detailed CRS Info
const info = extractCRSFromArrow(table);
if (info.crsInfo?.isWGS84) {
  console.log("Data is WGS84 (EPSG:4326/OGC:CRS84)");
}
```

## Installation

```bash
npm install @ateliercartographie/geoarrow-deck-stream d3-geo earcut
```

## Quick Start

```typescript
import {
  parsePolygonsToSolid,
  createSolidPolygonLayerProps,
} from "@ateliercartographie/geoarrow-deck-stream";
import { geoOrthographic } from "d3-geo";
import { SolidPolygonLayer } from "@deck.gl/layers";

// From DuckDB-WASM query result
const result = await conn.query(`SELECT geometry FROM my_countries`);
const table = result; // Pass the Arrow Table directly

// Reproject to globe, fix winding, and triangulate
const data = parsePolygonsToSolid(table, {
  projection: geoOrthographic().rotate([-10, -40]),
  rewind: true, // Default: true (Fixes Right-Hand Rule for spherical rendering)
});

// Create Deck.gl layer
const layer = new SolidPolygonLayer({
  id: "countries",
  ...createSolidPolygonLayerProps(data),
  getFillColor: [0, 150, 200],
  getLineColor: [255, 255, 255],
});
```

### DuckDB-WASM Integration

#### DuckDB-WASM ≥ 1.33 (transparent `geoarrow.wkb`)

Since [v1.33.1-dev41](https://github.com/duckdb/duckdb-wasm/pull/2200), DuckDB-WASM natively returns geometry columns as `geoarrow.wkb`. The library handles this transparently — no special handling needed:

```typescript
import { parsePolygonsToSolid } from "@ateliercartographie/geoarrow-deck-stream";
import { geoEqualEarth } from "d3-geo";

const db = await AsyncDuckDB.create(/* ... */);
const conn = await db.connect();

// Load the spatial extension
await conn.query(`INSTALL spatial; LOAD spatial;`);

// Query geometry directly — DuckDB returns geoarrow.wkb
const table = await conn.query(`
  SELECT geometry, name, population
  FROM my_countries
`);

// geoarrow-deck-stream detects WKB and decodes it automatically
const data = parsePolygonsToSolid(table, {
  projection: geoEqualEarth().translate([512, 384]).scale(200),
});
```

#### DuckDB-WASM < 1.33 (explicit `ST_AsWKB`)

Older versions of DuckDB-WASM return geometry as an opaque BLOB that is not standard WKB. Use `ST_AsWKB()` to convert it explicitly:

```typescript
// Older DuckDB-WASM: must call ST_AsWKB() to produce valid WKB
const table = await conn.query(`
  SELECT ST_AsWKB(geometry) as geometry, name, population
  FROM my_countries
`);

// Same API — WKB is auto-decoded
const data = parsePolygonsToSolid(table, {
  projection: geoEqualEarth().translate([512, 384]).scale(200),
});
```

## Composite Projections

Support for composite projections (like `geoAlbersUsa` or France with DOM-TOM) where distant territories are displayed in insets.

```typescript
import {
  buildCompositeProjection,
  PRESET_LAYOUTS,
  TERRITORY_BOUNDS,
  createInsetBorderData,
} from "@ateliercartographie/geoarrow-deck-stream";
import { geoConicConformal, geoMercator } from "d3-geo";

// 1. Build a composite projection
const franceProjection = buildCompositeProjection({
  width: 960,
  height: 600,
  entries: [
    // Main territory
    {
      id: "mainland",
      projection: geoConicConformal().parallels([44, 49]).rotate([-3, 0]),
      bounds: TERRITORY_BOUNDS.FRANCE_MAINLAND,
      layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.mainland,
    },
    // Inset territory (Guadeloupe)
    {
      id: "guadeloupe",
      projection: geoMercator(),
      bounds: TERRITORY_BOUNDS.GUADELOUPE,
      layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.guadeloupe,
      scaleMultiplier: 1.5, // Make small islands visible
    },
    // ... add other DOM-TOMs using PRESET_LAYOUTS.FRANCE_DOM_TOM
  ],
});

// 2. Use in parser
const data = parseGeometry(table, { projection: franceProjection });

// 3. (Optional) Render inset borders
const borderData = createInsetBorderData(franceProjection);
const borderLayer = new PathLayer({
  data: borderData,
  getPath: (d) => d.path,
  getColor: [0, 0, 0, 128],
});
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    INPUT (GeoArrow / WKB)                           │
│       Reads Float64Array coordinates directly (native)              │
│       or decodes WKB → native GeoArrow first                       │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         DRIVER (Orchestrator)                       │
│  • Iterates over Arrow geometries                                   │
│  • Manages featureId tracking                                       │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    REWIND STREAM (Optional)                         │
│  • buffers rings -> checks spherical containment (d3-geo)           │
│  • reverses rings if needed (Right-Hand Rule)                       │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    D3 PROJECTION STREAM                             │
│  ┌───────────────┐     ┌──────────────────┐     ┌──────────────┐   │
│  │ Rotation      │ ──▶ │ Projection Math  │ ──▶ │ Clipping     │   │
│  └───────────────┘     └──────────────────┘     └──────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      BINARY SINK (Custom GeoStream)                 │
│  • Receives point(x, y) calls                                       │
│  • Writes directly to Float32Array buffers                          │
│  • For Polygons: Runs Earcut triangulation on the fly               │
└─────────────────────────────────────────────────────────────────────┘
```

## "Zero-Copy" Philosophy & Data Flow

While "Zero-Copy" is the guiding principle, strict zero-copy is impossible when transforming Double-Precision data for the GPU. Here is the honest breakdown of the data lifecycle:

### 1. Arrow Input (True Zero-Copy)

We read directly from the underlying `Float64Array` buffers of the Apache Arrow table.

- **No deserialization**: We do not parse JSON. WKB input is decoded once upfront into native GeoArrow (a necessary pre-processing step), then the rest of the pipeline reads the resulting buffers with zero-copy.
- **No object allocation**: We never create `{x: 10, y: 20}` objects. We pass raw numbers `(x, y)` through the pipeline.
- **Batched Access**: Coordinates are read sequentially, optimizing CPU cache usage.

### 2. The D3-Geo Pipeline (Streaming)

The streaming architecture acts as a "pipe", processing one coordinate at a time.

- **Projection**: Mathematical transformations happen on the stack or registers. No intermediate arrays are allocated for total projected points.
- **Topology (Rewind/Clipping)**: These steps **are not zero-copy**. To fix winding order (Right-Hand Rule) or clip polygons against the antimeridian/globe, the pipeline _must_ temporarily buffer the current geometry.
  - _Impact_: Allocations are limited to the **single feature** being processed, not the entire dataset. Peak memory usage remains minimal.

### 3. Binary Output (Transcoding)

The final Sink writes data into `Float32Array` buffers for Deck.gl.

- **Necessary Copy**: GPUs require `Float32`. GeoArrow is usually `Float64`. We must copy and cast values.
- **Interleaving**: We write `[x,y, x,y]` contiguously, which is the native format for WebGL attributes.
- **Triangulation**: For `SolidPolygonLayer`, `earcut` generates indices. This is a CPU-intensive step but essential for rendering filled polygons without tessellation artifacts.

**Why use d3-geo instead of a custom loop?**

Despite the overhead of function calls (virtual dispatch), `d3-geo` offers mathematically robust handling of spherical coordinates, antimeridian cutting, and clipping that is notoriously difficult to implement correctly from scratch. The streaming approach ensures that **Peak Memory Usage** remains `O(Output + Single Feature)` rather than `O(Input + Output)`.

## API Reference

### `parseLineStrings(table, options)`

### `parsePolygonsToSolid(table, options)`

### `parsePoints(table, options)`

Main parsing functions. Transform GeoArrow geometries to Deck.gl binary format.

```typescript
function parsePolygonsToSolid(
  table: Table,
  options: {
    projection: GeoProjection; // d3-geo projection
    capacityMultiplier?: number; // Buffer growth factor (default: 1.5)
    rewind?: boolean; // Fix spherical winding order (default: true)
  },
): BinaryPolygonData;
```

### `BinaryPolygonData`

Output format compatible with Deck.gl binary attributes for `SolidPolygonLayer`.

```typescript
interface BinaryPolygonData {
  length: number; // Number of indices (triangles * 3)
  positions: Float32Array; // [x0,y0, x1,y1, ...] projected coords
  indices: Uint32Array; // Triangulation indices for WebGL
  featureIds: Uint32Array; // Maps output vertex → input feature
  startIndices: Uint32Array; // Range for each polygon (mostly for outlines)
}
```

### `createSolidPolygonLayerProps(data)`

Creates props for Deck.gl `SolidPolygonLayer`.

```typescript
const props = createSolidPolygonLayerProps(binaryData);

new SolidPolygonLayer({
  id: "my-polygons",
  ...props,
  getFillColor: [255, 0, 0],
});
```

## Attribute Accessors & Performance

Because this parser splits geometries (clipping/wrapping), the number of output vertices often exceeds input rows. You cannot simply pass an Arrow column as a WebGL attribute. We provide two patterns to handle attributes like Color, Width, or Elevation.

### 1. Binary Expansion (Fastest - GPU)

Use `createColorAttribute` (or similar helpers) to generate a pre-expanded TypedArray that matches the output geometry. This offers maximum rendering performance (pure GPU) but costs some CPU time upfront to build the buffer.

```typescript
// Good for static data
const colors = createColorAttribute(binaryData, (featureId) => {
  // Access Arrow column directly by row index (featureId)
  const val = populationColumn.get(featureId);
  return scale(val); // Returns [r, g, b]
});

new PathLayer({
  ...props,
  getColor: colors, // Passing { value: Uint8Array, size: ... }
});
```

### 2. Indexed Accessor (Flexible - CPU/Dynamic)

If you need dynamic updates (hover, highlighting) without rebuilding buffers, use the `featureIds` mapping inside a standard Deck.gl accessor.

**Note**: Do not use the `d` object. It is undefined in binary mode. Use the `index` argument.

```typescript
// Good for interactive/dynamic data
new PathLayer({
  ...props,
  // Warning: 'd' is null/undefined in binary mode!
  getFillColor: (_, { index }) => {
    // 1. Get original Row ID
    const rowId = binaryData.featureIds[index];

    // 2. Lookup in your original data source (Arrow, Array, etc.)
    const isHovered = rowId === hoveredId;
    return isHovered ? [255, 255, 0] : [0, 0, 255];
  },
  updateTriggers: {
    getFillColor: [hoveredId], // Only re-evaluate when this changes
  },
});
```

### 3. TextLayer Hybrid Pattern

For `TextLayer`, we use a "Proxy Accessor" pattern. `createTextLayerProps` is currently internal but the pattern is as follows:

1.  Use `parsePoints` to get binary positions.
2.  Pass a virtual array (`new Array(n).fill(null)`) to `data` to trigger accessors.
3.  Read positions manually from the binary buffer in `getPosition`.

```typescript
import { TextLayer } from "@deck.gl/layers";
const data = parsePoints(table, { projection });

new TextLayer({
  id: "text-labels",

  // 1. DATA: Virtual array to trigger JS accessors
  data: new Array(data.featureIds.length).fill(null),

  // 2. POSITION: Read manually from binary buffer
  getPosition: (_, { index }) => {
    const i = index * 2;
    return [data.positions[i], data.positions[i + 1]];
  },

  // 3. TEXT: Dynamic lookup via Feature ID
  getText: (_, { index }) => {
    const featureId = data.featureIds[index];
    const nameVector = table.getChild("name");
    return String(nameVector.get(featureId));
  },

  getSize: 14,
  getColor: [255, 255, 255],

  // CRITICAL: Ensure updates when data changes
  updateTriggers: {
    getPosition: [data.positions],
    getText: [data.featureIds],
  },
});
```

## Recipe: Joining External Data (BYOD)

A common scenario: You have static "Basemaps" (e.g., French Communes geometry) and dynamic "User Data" (e.g., CSV with Population by Commune Code). You want to join them without recreating the geometry.

**The Strategy: "Logical Join" via Accessors**

1.  **Parse Geometry once**: Keep the binary result in memory.
2.  **Extract Keys**: Cache the "Business ID" column (e.g., `insee_code`) from the Arrow table.
3.  **Map User Data**: Index your external data by that Key.
4.  **Render**: Chain the lookups in the accessor.

```javascript
// 1. Setup Phase (Run once)
const binaryData = parsePolygonsToSolid(arrowTable, { projection });

// Extract IDs to a native array for O(1) access
// Note: We access the Arrow Vector directly
const geoKeys = arrowTable.getChild("code_insee");

// 2. User Data Phase (Run when user uploads CSV/JSON)
// Index user data: Map<Code, Value>
const userDataMap = new Map();
userRows.forEach((row) => {
  userDataMap.set(row.code, row.value);
});

// 3. Render Phase
new SolidPolygonLayer({
  ...createSolidPolygonLayerProps(binaryData),

  // The Data Chain:
  // Binary Vertex Index -> Feature ID (Row Index) -> Business Key (INSEE) -> User Value
  getFillColor: (_, { index }) => {
    // A. Get Arrow Row Index
    const rowId = binaryData.featureIds[index];

    // B. Get Business Key (Zero-copy read from Arrow)
    const key = geoKeys.get(rowId);

    // C. Get User Value
    const value = userDataMap.get(key);

    return value ? colorScale(value) : [200, 200, 200]; // Fallback color
  },

  // CRITICAL: Tell Deck.gl to redraw when user data map changes
  updateTriggers: {
    getFillColor: [userDataMap],
  },
});
```

## Understanding Feature Splitting

When geometries cross projection boundaries (antimeridian, globe edge), they get split:

```
Input Arrow Data:
┌─────────────────────────────────────────┐
│ Row 0: France (LineString)              │
│ Row 1: USA (LineString)                 │
│ Row 2: Russia (LineString - crosses 180°)│
└─────────────────────────────────────────┘

Output Binary Data:
┌─────────────────────────────────────────┐
│ Path 0: France      → featureId: 0      │
│ Path 1: USA         → featureId: 1      │
│ Path 2: Russia West → featureId: 2      │  ← Same featureId!
│ Path 3: Russia East → featureId: 2      │  ← Split at antimeridian
└─────────────────────────────────────────┘
```

This means:

- `binaryData.length` may be > `arrowColumn.length`
- Use `featureIds` to map back to original attributes
- All split paths get the same color/style from the source feature

## Performance Tips

1. **Use OrthographicView**: For projected data, not MapView
2. **Batch updates**: Avoid re-parsing on every frame if data is static
3. **Pre-allocate buffers**: Set `capacityMultiplier` based on expected clipping
4. **Disable Rewind for Projected Data**: If using `geoIdentity` (pure pass-through), set `rewind: false` to skip unnecessary spherical calculations.

## Development & Building

### Standard Build (NPM)

```bash
pnpm build
```

Uses `tsc` to compile TypeScript to `dist/`, keeping the file structure. This is best for internal usage or when consuming via a bundler that wants individually importable modules for maximum tree-shaking.

### Production Bundle (CDN/Standalone)

```bash
pnpm build:bundle
```

Uses `rollup` to generate a single ESM file (`dist/geoarrow-deck-stream.min.mjs`) containing the library and core dependencies (`d3-geo`, `earcut`), excluding peer dependencies (`apache-arrow`, `deck.gl`).

**Bundle Stats:**

- Minified: ~68 KB
- Gzipped: ~22 KB

## License

ISC
