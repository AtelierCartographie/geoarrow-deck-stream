# GeoArrow Deck Stream - AI Agent Instructions

## Project Overview

This is a **zero-serialization** high-performance library that transforms GeoArrow geometries into Deck.gl-ready binary buffers. It uses d3-geo's streaming API to project coordinates while writing directly to TypedArrays, avoiding object allocation in the hot path.

**Key differentiator**: Unified code path for both reprojection (WGS84 → projected) and pass-through (already-projected → Deck.gl), achieved by always using `projection.stream(sink)`.

## GeoArrow Encoding Support

This library supports the official GeoArrow specification with both coordinate encodings:

### Interleaved Encoding

```typescript
// Coordinates stored as [x0,y0, x1,y1, x2,y2, ...] in a single Float64Array
values: Float64Array; // or Float32Array
```

- **Pros**: Contiguous memory access, better cache locality
- **Default in many implementations** (DuckDB-WASM, GeoParquet)

### Separated Encoding

```typescript
// Coordinates stored as separate arrays
x: Float64Array; // [x0, x1, x2, ...]
y: Float64Array; // [y0, y1, y2, ...]
```

- **Pros**: Easier projection of individual dimensions
- **Used by**: Apache Arrow native Struct encoding

The library auto-detects encoding via `detectCoordinateEncoding()` in [arrow-reader.ts](src/arrow-reader.ts) and reads directly from the appropriate buffers without conversion overhead.

**Current Support**:

- ✅ LineString (simple)
- ✅ MultiLineString (nested)
- ✅ Polygon (as paths)
- 🚧 Polygon with holes (planned)
- 🚧 MultiPolygon (planned - full SolidPolygonLayer support)

## Architecture (The "Three-Layer Cake")

```
┌─────────────────────────────────────────────┐
│  DRIVER (driver.ts)                         │  ← Orchestrates pipeline
│  - Reads GeoArrow buffers                   │  - Entry point: parseLineStrings()
│  - Iterates geometries                      │  - Manages featureId tracking
│  - Calls stream.point(x,y)                  │
├─────────────────────────────────────────────┤
│  D3 PROJECTION STREAM (d3-geo)              │  ← Never bypass this!
│  - Applies projection math                  │  - Even geoIdentity() goes through here
│  - Handles clipping/antimeridian            │  - Creates consistent API
│  - Can split geometries                     │
├─────────────────────────────────────────────┤
│  BINARY SINK (sink.ts)                      │  ← Custom GeoStream impl
│  - Implements d3.geoStream interface        │  - Writes to Float32Array
│  - Collects point(x,y) calls                │  - Tracks path boundaries
│  - Manages GrowableBuffers                  │  - Maps split paths → featureIds
└─────────────────────────────────────────────┘
```

### Critical Invariant

**NEVER call sink methods directly from driver.** Always use `projection.stream(sink)` to insert d3-geo middleware, even for identity transforms. This handles edge cases and maintains the "unified code path" design principle.

## Performance-Critical Patterns

### 1. Zero-Copy Buffer Access

- Read directly from Arrow `Float64Array` values without creating coordinate objects
- Use manual indexing: `values[i]` and `values[i+1]` instead of `{x, y}` tuples
- See: [driver.ts](src/driver.ts#L145-L165) streamLineStrings loop

### 2. Growable TypedArrays

- Use `GrowableBuffer` class ([buffers.ts](src/buffers.ts)) with exponential growth (2x)
- Pre-allocate with `estimateBufferSizes()` to minimize reallocations
- Always call `push2(x, y)` for coordinate pairs (faster than two `push()` calls)

### 3. Feature ID Mapping

- Output paths ≠ input features due to clipping/splitting
- `featureIds` array maps output path index → original Arrow row
- Essential for color/attribute lookups: `colorLookup(data.featureIds[i])`
- See: [deck-integration.ts](src/deck-integration.ts#L44-L70) createColorAttribute

## Module Responsibilities

- **driver.ts**: Pipeline orchestrator, reads GeoArrow structures, manages iteration
- **sink.ts**: Implements d3 GeoStream, writes to binary buffers, handles degenerate geometry filtering
- **arrow-reader.ts**: Low-level Arrow buffer access, geometry type detection, coordinate counting, encoding detection (interleaved/separated)
- **buffers.ts**: GrowableBuffer implementation, memory estimation utilities
- **deck-integration.ts**: Creates Deck.gl layer props, handles featureId-based attributes
- **types.ts**: All TypeScript interfaces, documents GeoArrow structures per official spec

## Development Workflow

```bash
# Build (required before testing)
pnpm build

# Development mode (watch)
pnpm dev

# Tests (Vitest)
pnpm test

# Type checking
pnpm typecheck

# Preview examples
pnpm preview  # Opens http://localhost:8000
```

**Important**: Tests import from built `dist/` files via [package.json](package.json) exports. Always build before testing changes.

## Code Conventions

1. **Export Everything**: All public types, helpers, and utilities ([index.ts](src/index.ts))
2. **Functional Style**: Pure functions, no classes except GrowableBuffer
3. **Explicit Types**: Always annotate function returns and complex structures
4. **File Headers**: Document module purpose and key responsibilities at top
5. **Performance Comments**: Mark hot paths with "CRITICAL" or "optimized for" notes

## Testing Patterns

- Use `createLineStringColumn()` and `createMultiLineStringColumn()` helpers to build test data
- Test with both `geoIdentity()` (pass-through) and `geoOrthographic()` (reprojection)
- Verify `featureIds` mapping, especially for split geometries
- Check bounds calculation with `calculateBounds()` after projection
- Tests in: [src/tests/parser.test.ts](src/tests/parser.test.ts)

## Common Pitfalls

❌ **Don't** allocate objects in coordinate loops: `{x: values[i], y: values[i+1]}`  
✅ **Do** use direct indexing: `stream.point(values[i], values[i+1])`

❌ **Don't** call sink methods directly from driver  
✅ **Do** always use `projection.stream(sink)`

❌ **Don't** assume output path count = input feature count  
✅ **Do** use `featureIds` for attribute lookups

❌ **Don't** forget to call `sink.setFeatureId()` before each geometry  
✅ **Do** track featureId in driver iteration loops

## Key Examples

- **Basic usage**: [examples/basic-usage.ts](examples/basic-usage.ts) - Complete pipeline example
- **Test data**: [examples/test-data/](examples/test-data/) - GeoJSON + Arrow files demonstrating both encodings:
  - `*.interleaved.arrow` - Coordinates as `[x,y,x,y,...]` in single array
  - `*.separated.arrow` - Coordinates as separate `x[]` and `y[]` arrays
- **Conversion**: [examples/convert-all.sh](examples/convert-all.sh) - GeoJSON → Arrow pipeline

## Dependencies

- **Core**: `d3-geo` (streaming API)
- **Peer**: `apache-arrow`, `@deck.gl/core`, `@deck.gl/layers`
- **Dev**: `vitest`, TypeScript 5.9+

This is a library, not an application. Users import functions from `geoarrow-deck-stream` and integrate with their own Deck.gl rendering stack. GeoArrow data can originate from any source (DuckDB-WASM, GeoParquet, custom buffers) as long as it conforms to the official GeoArrow specification.
