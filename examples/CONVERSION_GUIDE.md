# GeoJSON to Arrow Conversion Guide

This guide explains how to convert GeoJSON files to GeoArrow format using GDAL/OGR.

## Quick Start

```bash
cd examples
./convert-all.sh
```

This script automatically:

- Converts simple test files to INTERLEAVED encoding (and SEPARATED if supported)
- Normalizes and converts real-world files with mixed geometry types

## Directory Structure

```
test-data/
├── primitives/          # Simple, clean test geometries
│   ├── *.geojson       # Source files
│   ├── *.interleaved.arrow
│   └── *.separated.arrow (if GDAL supports it)
└── real-data/          # Real-world datasets
    ├── *.geojson       # Source files
    └── *.arrow         # INTERLEAVED format with normalization
```

## Manual Conversion

### Simple Files (Primitives)

For clean GeoJSON files with uniform geometry types:

**INTERLEAVED encoding** (default, coordinates as [x,y] pairs):

```bash
ogr2ogr \
  -f Arrow \
  -lco GEOMETRY_ENCODING=GEOARROW_INTERLEAVED \
  -lco COMPRESSION=NONE \
  output.arrow \
  input.geojson
```

**SEPARATED encoding** (x[] and y[] arrays) - GDAL 3.9+:

```bash
ogr2ogr \
  -f Arrow \
  -lco GEOMETRY_ENCODING=GEOARROW \
  -lco COMPRESSION=NONE \
  output.arrow \
  input.geojson
```

### Real-World Files (Mixed Geometries)

For GeoJSON files with mixed geometry types (e.g., LineString + MultiLineString):

**Two-step process:**

1. **Normalize geometries** (GeoJSON → GeoJSON):

```bash
ogr2ogr \
  -f GeoJSON \
  -nlt PROMOTE_TO_MULTI \
  -skipfailures \
  normalized.geojson \
  input.geojson
```

2. **Convert to Arrow**:

```bash
ogr2ogr \
  -f Arrow \
  -lco GEOMETRY_ENCODING=GEOARROW_INTERLEAVED \
  -lco COMPRESSION=NONE \
  output.arrow \
  normalized.geojson
```

## Common Issues

### ERROR 6: GeoArrow encoding is currently not supported for Unknown (any)

**Cause:** GeoJSON file contains mixed geometry types (e.g., both `LineString` and `MultiLineString`). GDAL cannot determine a single geometry type.

**Solution:** Use the two-step normalization process above, or specify geometry type:

```bash
ogr2ogr -f Arrow -lco GEOMETRY_ENCODING=GEOARROW -nlt MULTILINESTRING output.arrow input.geojson
```

### Unsupported GEOMETRY_ENCODING = GEOARROW_SEPARATED

**Cause:** Your GDAL version doesn't support SEPARATED encoding (requires 3.8+).

**Solution:** Use INTERLEAVED encoding instead (GEOARROW without \_SEPARATED).

## Layer Configuration Options

```bash
-lco GEOMETRY_ENCODING=GEOARROW_INTERLEAVED  # INTERLEAVED (default)
-lco GEOMETRY_ENCODING=GEOARROW              # SEPARATED (GDAL 3.9+)
-lco COMPRESSION=NONE                        # No compression (faster for dev)
-lco COMPRESSION=ZSTD                        # Compressed (smaller files)
-nlt PROMOTE_TO_MULTI                        # Convert to Multi* geometries
-nlt MULTILINESTRING                         # Force specific geometry type
-skipfailures                                # Continue on errors
```

## Requirements

- GDAL 3.9.0+ (for SEPARATED encoding)

Check version:

```bash
ogr2ogr --version
```

## References

- [GDAL Arrow Driver Documentation](https://gdal.org/drivers/vector/arrow.html)
- [GeoArrow Specification](https://github.com/geoarrow/geoarrow)
