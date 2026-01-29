# Test Data

This directory contains test datasets for geoarrow-deck-stream.

## Structure

### `primitives/`

Simple geometry test files (small, clean datasets).

**GeoJSON files:**

- `linestrings.geojson` - Simple LineString geometries
- `multilinestrings.geojson` - MultiLineString geometries
- `polygons.geojson` - Simple Polygon geometries
- `polygons-with-holes.geojson` - Polygons with holes
- `multipolygons.geojson` - MultiPolygon geometries

**Arrow files:**

- `*.interleaved.arrow` - INTERLEAVED encoding (coordinates stored as [x,y] pairs)
- `*.separated.arrow` - SEPARATED encoding (x[] and y[] arrays) - _if supported by GDAL_

### `real-data/`

Real-world datasets (larger, may contain mixed geometry types).

**Files:**

- `nuts2.geojson` / `nuts2.arrow` - European NUTS2 regions
- `lignes-du-reseau-star-de-rennes-metropole.geojson` / `.arrow` - Rennes metro lines
- `ne_50m.geojson` / `ne_50m.arrow` - Natural Earth 50m data
- `fr-com2025-line.geojson` / `.arrow` - French communes 2025

**Arrow files:**

- `*.arrow` - INTERLEAVED encoding with geometry normalization

## Conversion Script

Use `convert-all.sh` to regenerate Arrow files:

```bash
cd examples
./convert-all.sh
```

### How it works

**For primitives:**

1. Converts each GeoJSON to Arrow with INTERLEAVED encoding
2. Attempts SEPARATED encoding (skips if unsupported)

**For real-data:**

1. Normalizes geometries: GeoJSON → GeoJSON with `PROMOTE_TO_MULTI`
   - Converts mixed geometry types (LineString + MultiLineString) to uniform types
   - Ensures GDAL can determine the layer geometry type
2. Converts normalized GeoJSON to Arrow with INTERLEAVED encoding
3. Cleans up temporary normalized files

### Why normalization for real-data?

Real-world GeoJSON files often contain mixed geometry types (e.g., both `LineString` and `MultiLineString` in the same file). GDAL assigns these files a geometry type of `Unknown (any)`, which the Arrow driver refuses:

```
ERROR 6: GeoArrow encoding is currently not supported for Unknown (any)
```

The solution is to normalize geometries using `-nlt PROMOTE_TO_MULTI`, which converts all simple geometries to their Multi\* equivalents, ensuring a uniform geometry type.

## Requirements

- GDAL/OGR with Arrow support
- `ogr2ogr` command available in PATH

Check your GDAL version:

```bash
ogr2ogr --version
```

For Arrow support, GDAL 3.5.0+ is recommended.
