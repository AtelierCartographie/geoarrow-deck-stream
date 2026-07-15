/**
 * Serializable Projection Specification
 *
 * D3 projections are closures and cannot cross a `postMessage` boundary.
 * A ProjectionSpec is the structured-cloneable description of a projection:
 * a d3 factory *name* plus its configuration parameters. It is resolved to a
 * live projection instance with `resolveProjectionSpec()` on the receiving
 * side (typically inside a Web Worker).
 *
 * The format is aligned with the `D3Usage` shape of
 * `@ateliercartographie/proj-suggest` (`projection` = factory function name,
 * `rotate`/`center`/`parallels` map to the d3 method calls), extended with
 * the remaining standard d3 projection methods (scale, translate, precision,
 * clipping, fitting...).
 *
 * The default registry contains every d3-geo factory. Exotic projections
 * (d3-geo-projection, d3-geo-polygon, hand-built `geoInterrupt` setups...)
 * are supported by extending the registry on the worker side:
 *
 * ```typescript
 * // parse.worker.ts
 * import * as d3GeoProjection from 'd3-geo-projection';
 * import { setupParseWorker, createProjectionRegistry } from '@ateliercartographie/geoarrow-deck-stream/worker';
 *
 * setupParseWorker({
 *   projections: createProjectionRegistry(d3GeoProjection, {
 *     // custom assembly (proj-suggest `snippet` cases) — register under an id
 *     mollweideOceans: () => geoInterrupt(geoMollweideRaw, [...]).rotate([-200, 0])
 *   })
 * });
 * ```
 *
 * @packageDocumentation
 */

import * as d3Geo from 'd3-geo';
import type { GeoProjection } from 'd3-geo';

import type { ProjectionLike } from './types.js';
import {
  buildCompositeProjection,
  type CompositeProjection,
  type GeoBounds,
} from './composite-projection.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * A factory returning a fresh, unconfigured projection instance.
 * This is the standard d3 style: `geoConicConformal` is a factory,
 * `geoConicConformal()` is an instance.
 */
export type ProjectionFactory = () => GeoProjection | ProjectionLike;

/**
 * Registry mapping factory names to factories.
 * Keys are the names used in `SimpleProjectionSpec.projection`.
 */
export type ProjectionRegistry = Record<string, ProjectionFactory>;

/**
 * Serializable description of a single d3 projection.
 *
 * Field names match the d3 method they configure. Only the fields present
 * are applied, so any projection that lacks a given method (e.g. `parallels`
 * on a non-conic) can simply omit it.
 */
export interface SimpleProjectionSpec {
  /** Discriminant (optional for simple specs, which are the default). */
  type?: 'simple';

  /**
   * d3 factory function name resolved against the registry,
   * e.g. `"geoConicConformal"`, `"geoBertin1953"`, or a custom id.
   */
  projection: string;

  /** `.rotate([λ, φ])` or `.rotate([λ, φ, γ])` */
  rotate?: [number, number] | [number, number, number];

  /** `.center([lon, lat])` */
  center?: [number, number];

  /** `.parallels([lat1, lat2])` (conic projections) */
  parallels?: [number, number];

  /** `.scale(k)` — ignored when `fitExtent`/`fitSize` is present */
  scale?: number;

  /** `.translate([x, y])` — ignored when `fitExtent`/`fitSize` is present */
  translate?: [number, number];

  /** `.precision(p)` — adaptive resampling threshold. `0` disables resampling. */
  precision?: number;

  /** `.clipAngle(angle)` — small-circle clipping (e.g. 90 for hemispheres) */
  clipAngle?: number;

  /** `.clipExtent(extent)` — planar clip rectangle, or null to clear */
  clipExtent?: [[number, number], [number, number]] | null;

  /** `.angle(a)` — post-projection rotation (d3-geo >= 1.12) */
  angle?: number;

  /** `.reflectX(true)` */
  reflectX?: boolean;

  /** `.reflectY(true)` — common with geoIdentity for screen coordinates */
  reflectY?: boolean;

  /**
   * Serializable replacement for `.fitExtent(extent, geojson)`:
   * fits the geographic bounding box `bbox` [west, south, east, north]
   * into the screen extent [[x0, y0], [x1, y1]].
   */
  fitExtent?: {
    extent: [[number, number], [number, number]];
    bbox: GeoBounds;
  };

  /**
   * Serializable replacement for `.fitSize(size, geojson)`:
   * shorthand for `fitExtent` with extent [[0, 0], size].
   */
  fitSize?: {
    size: [number, number];
    bbox: GeoBounds;
  };
}

/**
 * Serializable description of one sub-projection entry of a composite.
 * Mirrors `SubProjectionEntry` with the live projection replaced by a spec.
 *
 * As with `buildCompositeProjection`, the spec should configure
 * center/rotate/parallels but NOT scale/translate/clipExtent — those are
 * computed from the layout.
 */
export interface SubProjectionEntrySpec {
  id: string;
  projection: SimpleProjectionSpec;
  bounds: GeoBounds;
  layout: { x: number; y: number; width: number; height: number };
  scaleMultiplier?: number;
}

/**
 * Serializable description of a composite projection
 * (mirrors `CompositeProjectionConfig`).
 */
export interface CompositeProjectionSpec {
  type: 'composite';
  entries: SubProjectionEntrySpec[];
  width?: number;
  height?: number;
  insetPadding?: number;
}

/**
 * Any serializable projection description accepted by the worker API.
 */
export type ProjectionSpec = SimpleProjectionSpec | CompositeProjectionSpec;

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Build a projection registry from one or more sources.
 *
 * Each source is either a module namespace (e.g. `import * as m from
 * 'd3-geo-projection'`) — every exported function whose name starts with
 * `geo` is registered under its export name — or a plain object of custom
 * factories registered under their keys.
 *
 * Later sources override earlier ones on name collision.
 */
export function createProjectionRegistry(
  ...sources: Record<string, unknown>[]
): ProjectionRegistry {
  const registry: ProjectionRegistry = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (typeof value !== 'function') continue;
      // Module namespaces: keep d3-style `geo*` factories, skip helpers
      // explicitly registered under custom names.
      registry[name] = value as ProjectionFactory;
    }
  }
  return registry;
}

/**
 * Default registry: every factory exported by d3-geo
 * (geoMercator, geoConicConformal, geoIdentity, geoAlbersUsa, ...).
 */
export const defaultProjectionRegistry: ProjectionRegistry =
  createProjectionRegistry(d3Geo as unknown as Record<string, unknown>);

// =============================================================================
// RESOLUTION
// =============================================================================

/** Minimal GeoJSON polygon covering a geographic bbox, for fitExtent. */
function bboxToFeature(bbox: GeoBounds): GeoJSON.Feature {
  const [west, south, east, north] = bbox;
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [west, south],
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      ],
    },
  };
}

/** Call a d3 projection method if the instance supports it, throw otherwise. */
function applyMethod(
  projection: Record<string, unknown>,
  factoryName: string,
  method: string,
  value: unknown,
): void {
  const fn = projection[method];
  if (typeof fn !== 'function') {
    throw new Error(
      `Projection "${factoryName}" does not support .${method}() (from spec field "${method}")`,
    );
  }
  (fn as (v: unknown) => unknown).call(projection, value);
}

/**
 * Resolve a `SimpleProjectionSpec` into a configured projection instance.
 */
function resolveSimpleSpec(
  spec: SimpleProjectionSpec,
  registry: ProjectionRegistry,
): GeoProjection {
  const factory = registry[spec.projection];
  if (!factory) {
    throw new Error(
      `Unknown projection "${spec.projection}". ` +
        `Register it via createProjectionRegistry() — e.g. pass d3-geo-projection ` +
        `or a custom factory to setupParseWorker({ projections }).`,
    );
  }

  const instance = factory();
  if (!instance || typeof (instance as ProjectionLike).stream !== 'function') {
    throw new Error(
      `Registry entry "${spec.projection}" did not produce a projection ` +
        `(missing .stream()). Is it a projection factory?`,
    );
  }
  const p = instance as unknown as Record<string, unknown>;
  const name = spec.projection;

  // Geographic configuration first...
  if (spec.parallels !== undefined) applyMethod(p, name, 'parallels', spec.parallels);
  if (spec.rotate !== undefined) applyMethod(p, name, 'rotate', spec.rotate);
  if (spec.center !== undefined) applyMethod(p, name, 'center', spec.center);
  if (spec.angle !== undefined) applyMethod(p, name, 'angle', spec.angle);
  if (spec.reflectX !== undefined) applyMethod(p, name, 'reflectX', spec.reflectX);
  if (spec.reflectY !== undefined) applyMethod(p, name, 'reflectY', spec.reflectY);
  if (spec.clipAngle !== undefined) applyMethod(p, name, 'clipAngle', spec.clipAngle);
  if (spec.precision !== undefined) applyMethod(p, name, 'precision', spec.precision);

  // ...then screen placement (fit wins over explicit scale/translate)...
  if (spec.fitExtent) {
    const fn = p['fitExtent'];
    if (typeof fn !== 'function') {
      throw new Error(`Projection "${name}" does not support .fitExtent()`);
    }
    (fn as (e: unknown, o: unknown) => unknown).call(
      p,
      spec.fitExtent.extent,
      bboxToFeature(spec.fitExtent.bbox),
    );
  } else if (spec.fitSize) {
    const fn = p['fitSize'];
    if (typeof fn !== 'function') {
      throw new Error(`Projection "${name}" does not support .fitSize()`);
    }
    (fn as (s: unknown, o: unknown) => unknown).call(
      p,
      spec.fitSize.size,
      bboxToFeature(spec.fitSize.bbox),
    );
  } else {
    if (spec.scale !== undefined) applyMethod(p, name, 'scale', spec.scale);
    if (spec.translate !== undefined) applyMethod(p, name, 'translate', spec.translate);
  }

  // ...and planar clipping last so fitExtent cannot clear it.
  if (spec.clipExtent !== undefined) applyMethod(p, name, 'clipExtent', spec.clipExtent);

  return instance as GeoProjection;
}

/**
 * Resolve a serializable `ProjectionSpec` into a live projection usable with
 * `parseGeometry` & co.
 *
 * @param spec - Simple or composite projection description
 * @param registry - Factory registry; defaults to all of d3-geo
 * @returns A configured projection instance
 *
 * @example
 * ```typescript
 * const projection = resolveProjectionSpec({
 *   projection: 'geoConicConformal',
 *   rotate: [-3, 0],
 *   center: [0, 46.5],
 *   parallels: [44, 49],
 *   fitExtent: { extent: [[0, 0], [960, 600]], bbox: [-5.5, 41, 10, 51.5] }
 * });
 * const data = parseGeometry(table, { projection });
 * ```
 */
export function resolveProjectionSpec(
  spec: ProjectionSpec,
  registry: ProjectionRegistry = defaultProjectionRegistry,
): GeoProjection | CompositeProjection {
  if (spec.type === 'composite') {
    return buildCompositeProjection({
      width: spec.width,
      height: spec.height,
      insetPadding: spec.insetPadding,
      entries: spec.entries.map((entry) => ({
        id: entry.id,
        projection: resolveSimpleSpec(entry.projection, registry),
        bounds: entry.bounds,
        layout: entry.layout,
        scaleMultiplier: entry.scaleMultiplier,
      })),
    });
  }
  return resolveSimpleSpec(spec, registry);
}
