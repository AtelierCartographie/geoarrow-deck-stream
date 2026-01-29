/**
 * Tests for Composite Projection Builder
 * 
 * Tests the multiplex streaming pattern and composite projection functionality.
 */

import { describe, it, expect } from 'vitest';
import { geoMercator, geoConicConformal, geoIdentity } from 'd3-geo';
import type { GeoStream } from 'd3-geo';

import {
  buildCompositeProjection,
  createInsetBorderData,
  createInsetBorderBinaryData,
  PRESET_LAYOUTS,
  TERRITORY_BOUNDS,
  type SubProjectionEntry,
  type CompositeProjection,
} from '../composite-projection.js';

describe('buildCompositeProjection', () => {
  // Helper to create a simple 2-region composite
  function createTestComposite(): CompositeProjection {
    return buildCompositeProjection({
      width: 800,
      height: 600,
      entries: [
        {
          id: 'main',
          projection: geoMercator(),
          bounds: [-10, 35, 5, 45],
          layout: { x: 0.3, y: 0, width: 0.7, height: 1 },
        },
        {
          id: 'inset',
          projection: geoMercator(),
          bounds: [-65, 10, -55, 20],
          layout: { x: 0, y: 0.6, width: 0.25, height: 0.35 },
          scaleMultiplier: 1.5,
        },
      ],
    });
  }

  it('creates a composite projection with stream method', () => {
    const composite = createTestComposite();
    
    expect(composite).toBeDefined();
    expect(typeof composite.stream).toBe('function');
    expect(typeof composite).toBe('function'); // Can be called as projection(coords)
  });

  it('implements the d3 stream interface', () => {
    const composite = createTestComposite();
    
    // Create a mock sink
    const collected: { type: string; args?: number[] }[] = [];
    const mockSink: GeoStream = {
      point: (x, y) => collected.push({ type: 'point', args: [x, y] }),
      lineStart: () => collected.push({ type: 'lineStart' }),
      lineEnd: () => collected.push({ type: 'lineEnd' }),
      polygonStart: () => collected.push({ type: 'polygonStart' }),
      polygonEnd: () => collected.push({ type: 'polygonEnd' }),
      sphere: () => collected.push({ type: 'sphere' }),
    };
    
    const stream = composite.stream(mockSink);
    
    // Stream interface should have all required methods
    expect(typeof stream.point).toBe('function');
    expect(typeof stream.lineStart).toBe('function');
    expect(typeof stream.lineEnd).toBe('function');
    expect(typeof stream.polygonStart).toBe('function');
    expect(typeof stream.polygonEnd).toBe('function');
    expect(typeof stream.sphere).toBe('function');
  });

  it('projects points within main region', () => {
    const composite = createTestComposite();
    
    // Point in the main region (Spain)
    const result = composite([-3, 40]);
    
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(2);
    expect(Number.isFinite(result![0])).toBe(true);
    expect(Number.isFinite(result![1])).toBe(true);
  });

  it('projects points within inset region', () => {
    const composite = createTestComposite();
    
    // Point in the inset region (Caribbean)
    const result = composite([-60, 15]);
    
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns null for points outside all regions', () => {
    const composite = createTestComposite();
    
    // Point in the Pacific Ocean - outside both regions
    const result = composite([-150, 0]);
    
    expect(result).toBeNull();
  });

  it('caches stream for performance', () => {
    const composite = createTestComposite();
    const mockSink: GeoStream = {
      point: () => {},
      lineStart: () => {},
      lineEnd: () => {},
      polygonStart: () => {},
      polygonEnd: () => {},
      sphere: () => {},
    };
    
    const stream1 = composite.stream(mockSink);
    const stream2 = composite.stream(mockSink);
    
    // Same sink should return cached stream
    expect(stream1).toBe(stream2);
  });

  it('exposes sub-projections via getSubProjections()', () => {
    const composite = createTestComposite();
    const subProjections = composite.getSubProjections();
    
    expect(subProjections.length).toBe(2);
    expect(subProjections[0].id).toBe('main');
    expect(subProjections[1].id).toBe('inset');
    
    // Each should have computed screen extents
    expect(subProjections[0].screenExtent).toBeDefined();
    expect(subProjections[1].screenExtent).toBeDefined();
  });

  it('supports invert() for reverse projection', () => {
    const composite = createTestComposite();
    
    // Project a point
    const projected = composite([-3, 40]);
    expect(projected).not.toBeNull();
    
    // Invert should return close to original coordinates
    const inverted = composite.invert!(projected!);
    expect(inverted).not.toBeNull();
    expect(inverted![0]).toBeCloseTo(-3, 1);
    expect(inverted![1]).toBeCloseTo(40, 1);
  });

  it('throws error for empty entries array', () => {
    expect(() => {
      buildCompositeProjection({
        entries: [],
      });
    }).toThrow('CompositeProjection requires at least one entry');
  });
});

describe('Inset Border Generation', () => {
  function createTestComposite(): CompositeProjection {
    return buildCompositeProjection({
      width: 800,
      height: 600,
      entries: [
        {
          id: 'main',
          projection: geoMercator(),
          bounds: [-10, 35, 5, 45],
          layout: { x: 0.3, y: 0, width: 0.7, height: 1 },
        },
        {
          id: 'inset1',
          projection: geoMercator(),
          bounds: [-65, 10, -55, 20],
          layout: { x: 0, y: 0, width: 0.25, height: 0.3 },
        },
        {
          id: 'inset2',
          projection: geoMercator(),
          bounds: [-62, 14, -60, 17],
          layout: { x: 0, y: 0.35, width: 0.25, height: 0.3 },
        },
      ],
    });
  }

  it('createInsetBorderData returns borders for insets only', () => {
    const composite = createTestComposite();
    const borders = createInsetBorderData(composite);
    
    // Should have 2 borders (inset1 and inset2, not main)
    expect(borders.length).toBe(2);
    expect(borders[0].id).toBe('inset1');
    expect(borders[1].id).toBe('inset2');
  });

  it('border paths form closed rectangles', () => {
    const composite = createTestComposite();
    const borders = createInsetBorderData(composite);
    
    for (const border of borders) {
      // Path should have 5 points (closed rectangle)
      expect(border.path.length).toBe(5);
      
      // First and last point should be the same (closed)
      expect(border.path[0]).toEqual(border.path[4]);
      
      // Should form a rectangle (4 unique corners)
      const uniquePoints = new Set(border.path.slice(0, 4).map(p => `${p[0]},${p[1]}`));
      expect(uniquePoints.size).toBe(4);
    }
  });

  it('createInsetBorderBinaryData returns Deck.gl-compatible format', () => {
    const composite = createTestComposite();
    const binaryData = createInsetBorderBinaryData(composite);
    
    expect(binaryData.positions).toBeInstanceOf(Float32Array);
    expect(binaryData.startIndices).toBeInstanceOf(Uint32Array);
    expect(binaryData.featureIds).toBeInstanceOf(Uint32Array);
    expect(binaryData.length).toBe(2);
    
    // 2 borders × 5 points × 2 coords = 20 floats
    expect(binaryData.positions.length).toBe(20);
    
    // Start indices: [0, 5, 10] (3 entries for 2 paths)
    expect(binaryData.startIndices.length).toBe(3);
    expect(binaryData.startIndices[0]).toBe(0);
    expect(binaryData.startIndices[1]).toBe(5);
    expect(binaryData.startIndices[2]).toBe(10);
  });
});

describe('Preset Layouts and Bounds', () => {
  it('PRESET_LAYOUTS has expected regions', () => {
    expect(PRESET_LAYOUTS.FRANCE_DOM_TOM).toBeDefined();
    expect(PRESET_LAYOUTS.FRANCE_DOM_TOM.mainland).toBeDefined();
    expect(PRESET_LAYOUTS.FRANCE_DOM_TOM.guadeloupe).toBeDefined();
    
    expect(PRESET_LAYOUTS.USA_ALASKA_HAWAII).toBeDefined();
    expect(PRESET_LAYOUTS.USA_ALASKA_HAWAII.lower48).toBeDefined();
    expect(PRESET_LAYOUTS.USA_ALASKA_HAWAII.alaska).toBeDefined();
    expect(PRESET_LAYOUTS.USA_ALASKA_HAWAII.hawaii).toBeDefined();
    
    expect(PRESET_LAYOUTS.PORTUGAL_ISLANDS).toBeDefined();
  });

  it('TERRITORY_BOUNDS has valid geo bounds', () => {
    // Check France bounds
    const franceBounds = TERRITORY_BOUNDS.FRANCE_MAINLAND;
    expect(franceBounds).toBeDefined();
    expect(franceBounds.length).toBe(4);
    expect(franceBounds[0]).toBeLessThan(franceBounds[2]); // west < east
    expect(franceBounds[1]).toBeLessThan(franceBounds[3]); // south < north
    
    // Check USA bounds
    const usaBounds = TERRITORY_BOUNDS.USA_LOWER48;
    expect(usaBounds).toBeDefined();
    expect(usaBounds[0]).toBeLessThan(usaBounds[2]);
    expect(usaBounds[1]).toBeLessThan(usaBounds[3]);
  });
});

describe('Integration with parseGeometry', () => {
  it('composite projection can be used as ParserOptions.projection', async () => {
    // This test verifies that the composite projection satisfies the ProjectionLike interface
    const composite = buildCompositeProjection({
      width: 800,
      height: 600,
      entries: [
        {
          id: 'main',
          projection: geoMercator(),
          bounds: [-10, 35, 5, 45],
          layout: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    });
    
    // Verify it has the required stream method
    expect(typeof composite.stream).toBe('function');
    
    // The stream method should accept a GeoStream sink
    const collected: number[] = [];
    const mockSink: GeoStream = {
      point: (x, y) => {
        collected.push(x, y);
      },
      lineStart: () => {},
      lineEnd: () => {},
      polygonStart: () => {},
      polygonEnd: () => {},
      sphere: () => {},
    };
    
    const stream = composite.stream(mockSink);
    
    // Stream a simple point
    stream.point(-3, 40);
    
    // Should have projected coordinates in the sink
    expect(collected.length).toBe(2);
    expect(Number.isFinite(collected[0])).toBe(true);
    expect(Number.isFinite(collected[1])).toBe(true);
  });
});

describe('France DOM-TOM Example', () => {
  it('creates a working France DOM-TOM composite', () => {
    // This is a realistic example using the preset layouts and bounds
    const franceDomTom = buildCompositeProjection({
      width: 960,
      height: 600,
      entries: [
        {
          id: 'mainland',
          projection: geoConicConformal().parallels([44, 49]).rotate([-3, 0]),
          bounds: TERRITORY_BOUNDS.FRANCE_MAINLAND,
          layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.mainland,
        },
        {
          id: 'guadeloupe',
          projection: geoMercator(),
          bounds: TERRITORY_BOUNDS.GUADELOUPE,
          layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.guadeloupe,
          scaleMultiplier: 1.5,
        },
        {
          id: 'martinique',
          projection: geoMercator(),
          bounds: TERRITORY_BOUNDS.MARTINIQUE,
          layout: PRESET_LAYOUTS.FRANCE_DOM_TOM.martinique,
          scaleMultiplier: 1.5,
        },
      ],
    });
    
    // Test mainland projection (Paris)
    const paris = franceDomTom([2.35, 48.86]);
    expect(paris).not.toBeNull();
    
    // Test Guadeloupe projection
    const guadeloupe = franceDomTom([-61.5, 16.2]);
    expect(guadeloupe).not.toBeNull();
    
    // Test Martinique projection
    const martinique = franceDomTom([-61.0, 14.6]);
    expect(martinique).not.toBeNull();
    
    // Points should be in different screen regions
    expect(paris![0]).toBeGreaterThan(guadeloupe![0]); // Mainland is on the right
    expect(paris![0]).toBeGreaterThan(martinique![0]);
    
    // Get inset borders
    const borders = franceDomTom.getInsetBorders();
    expect(borders.length).toBe(2); // guadeloupe and martinique
  });
});
