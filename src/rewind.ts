import { geoTransform, geoContains, geoArea, type GeoStream } from 'd3-geo';

export function createRewindStream(simple: boolean = true): { stream: (s: GeoStream) => GeoStream } {
  // Use typed arrays or generic arrays but manage strict typing to avoid "any"
  let ring: [number, number][] = [];
  let polygon: [number, number][][] = [];

  // Reusable objects for D3 checks to avoid allocating distinct objects per feature if possible
  // NOTE: D3 geometry objects are simple JSON, we create them on the fly.
  
  return geoTransform({
    polygonStart() {
      // @ts-ignore
      this.stream.polygonStart();
      polygon = [];
    },
    lineStart() {
      if (polygon) {
        ring = []; 
        polygon.push(ring);
      } else {
        // @ts-ignore
        this.stream.lineStart();
      }
    },
    lineEnd() {
      if (!polygon) {
        // @ts-ignore
        this.stream.lineEnd();
      }
    },
    point(x, y) {
      if (polygon) {
        // CRITICAL PATH: This allocation [x,y] happens for every vertex.
        // Unavoidable if using d3.geoContains later which expects GeoJSON structure.
        ring.push([x, y]);
      } else {
        // @ts-ignore
        this.stream.point(x, y);
      }
    },
    polygonEnd() {
      const ringCount = polygon.length;
      
      // Optimization: If simple polygon (no holes) and we trust input winding (optionally),
      // we could skip checks. But here we assume input is dirty.

      for (let i = 0; i < ringCount; i++) {
        const currentRing = polygon[i];
        if (currentRing.length < 3) continue; // Degenerate ring

        // Ensure closure for D3 logic
        const start = currentRing[0];
        const end = currentRing[currentRing.length - 1];
        const isClosed = start[0] === end[0] && start[1] === end[1];
        
        // GeoJSON for D3 analysis requires closure
        if (!isClosed) {
          currentRing.push([start[0], start[1]]);
        }

        let shouldReverse = false;
        
        // We construct a temporary GeoJSON object for D3 algorithms
        const polyGeo = {
          type: "Polygon" as const,
          coordinates: [currentRing]
        };

        if (i === 0) {
          // Exterior Ring
          if (ringCount > 1) {
            // Check containment of first hole
            // Exterior must contain the hole's first point
            const holePoint = polygon[1][0];
            if (!geoContains(polyGeo, holePoint)) {
              shouldReverse = true;
            }
          } else if (simple) {
             // Single Ring: Check size. 
             // If larger than hemisphere (2*PI), it's likely inverted "ocean" polygon.
             if (geoArea(polyGeo) > 2 * Math.PI) {
               shouldReverse = true;
             }
          }
        } else {
          // Hole
          // Hole (CW) SHOULD contain the exterior's first point (because CW hole = "everything except the hole")
          // If it DOES NOT contain the exterior point, it means it's CCW (small polygon), so we reverse it.
          const exteriorPoint = polygon[0][0];
          if (!geoContains(polyGeo, exteriorPoint)) {
            shouldReverse = true;
          }
        }

        if (shouldReverse) {
          currentRing.reverse();
        }
        
        // Remove the closure point we added if it wasn't there originally?
        // Actually, for d3-geo streaming output, we usually DO NOT repeat the last point.
        // d3-geo `lineEnd` implies closure.
        // If we reversed, the points are swapped.
        // We will just iterate length-1 if it is closed.
      }

      // Stream Output
      for (const r of polygon) {
        // @ts-ignore
        this.stream.lineStart();
        
        const len = r.length;
        // Determine if we need to trim the last point (if closed loop)
        // because stream.lineEnd() closes it virtually.
        const start = r[0];
        const end = r[len - 1];
        const effectivelyClosed = start[0] === end[0] && start[1] === end[1];
        const outputLen = effectivelyClosed ? len - 1 : len;
        
        for (let j = 0; j < outputLen; j++) {
          // @ts-ignore
          this.stream.point(r[j][0], r[j][1]);
        }
        // @ts-ignore
        this.stream.lineEnd();
      }
      
      // @ts-ignore
      this.stream.polygonEnd();
      
      // Release memory helpers
      polygon = []; // Assigning new array might be safer than .length=0 for type stability in loop
      ring = [];
    }
  });
}
