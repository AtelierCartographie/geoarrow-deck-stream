#!/bin/bash

# Script de conversion GeoJSON → Arrow
# Pour geoarrow-deck-stream
#
# Structure:
# - primitives/: fichiers simples convertis en SEPARATED et INTERLEAVED
# - real-data/: fichiers réels convertis en INTERLEAVED avec normalisation

set -e

cd "$(dirname "$0")/test-data"

echo "🔄 Converting GeoJSON files to Arrow format..."
echo ""

# ============================================
# 1. Conversion des primitives (fichiers simples)
# ============================================
echo "📦 Converting primitives (SEPARATED + INTERLEAVED)..."
echo ""

cd primitives

for file in *.geojson; do
  if [ ! -f "$file" ]; then
    continue
  fi
  
  basename="${file%.geojson}"
  
  # SEPARATED encoding (skip if not supported)
  echo "   🔹 $file → ${basename}.separated.arrow"
  if ogr2ogr \
    -f Arrow \
    -lco GEOMETRY_ENCODING=GEOARROW \
    -lco COMPRESSION=NONE \
    -skipfailures \
    "${basename}.separated.arrow" \
    "$file" 2>&1 | grep -q "Unsupported GEOMETRY_ENCODING"; then
    echo "      ⚠ SEPARATED encoding not supported by GDAL (skipped)"
  elif [ -f "${basename}.separated.arrow" ] && [ -s "${basename}.separated.arrow" ]; then
    size=$(ls -lh "${basename}.separated.arrow" | awk '{print $5}')
    echo "      ✓ SEPARATED (${size})"
  else
    echo "      ✗ SEPARATED failed"
  fi
  
  # INTERLEAVED encoding
  echo "   🔹 $file → ${basename}.interleaved.arrow"
  ogr2ogr \
    -f Arrow \
    -lco GEOMETRY_ENCODING=GEOARROW_INTERLEAVED \
    -lco COMPRESSION=NONE \
    -skipfailures \
    "${basename}.interleaved.arrow" \
    "$file" 2>&1 | grep -v "Warning" || true
  
  if [ -f "${basename}.interleaved.arrow" ]; then
    size=$(ls -lh "${basename}.interleaved.arrow" | awk '{print $5}')
    echo "      ✓ INTERLEAVED (${size})"
  else
    echo "      ✗ INTERLEAVED failed"
  fi
  
  echo ""
done

# WKB encoding for primitives
echo "   🔸 WKB encoding..."
for file in *.geojson; do
  if [ ! -f "$file" ]; then
    continue
  fi
  
  basename="${file%.geojson}"
  
  echo "   🔹 $file → ${basename}.wkb.arrow"
  ogr2ogr \
    -f Arrow \
    -lco GEOMETRY_ENCODING=WKB \
    -lco COMPRESSION=NONE \
    -skipfailures \
    "${basename}.wkb.arrow" \
    "$file" 2>&1 | grep -v "Warning" || true
  
  if [ -f "${basename}.wkb.arrow" ]; then
    size=$(ls -lh "${basename}.wkb.arrow" | awk '{print $5}')
    echo "      ✓ WKB (${size})"
  else
    echo "      ✗ WKB failed"
  fi
done
echo ""

cd ..

# ============================================
# 2. Conversion des fichiers réels (volumineux)
# ============================================
echo "📦 Converting real-data files (INTERLEAVED with normalization)..."
echo ""

cd real-data

for file in *.geojson; do
  if [ ! -f "$file" ]; then
    continue
  fi
  
  basename="${file%.geojson}"
  temp_normalized="${basename}.normalized.geojson"
  
  echo "   🔹 $file"
  
  # Étape 1: Normalisation (conversion GeoJSON → GeoJSON avec PROMOTE_TO_MULTI)
  echo "      → Normalizing geometries..."
  ogr2ogr \
    -f GeoJSON \
    -nlt PROMOTE_TO_MULTI \
    -skipfailures \
    "$temp_normalized" \
    "$file" 2>&1 | grep -v "Warning" || true
  
  if [ ! -f "$temp_normalized" ]; then
    echo "      ✗ Normalization failed"
    continue
  fi
  
  # Étape 2: Conversion vers Arrow INTERLEAVED
  echo "      → Converting to Arrow..."
  ogr2ogr \
    -f Arrow \
    -lco GEOMETRY_ENCODING=GEOARROW_INTERLEAVED \
    -lco COMPRESSION=NONE \
    -skipfailures \
    "${basename}.arrow" \
    "$temp_normalized" 2>&1 | grep -v "Warning" || true
  
  # Nettoyage du fichier temporaire
  rm -f "$temp_normalized"
  
  if [ -f "${basename}.arrow" ]; then
    size=$(ls -lh "${basename}.arrow" | awk '{print $5}')
    echo "      ✓ ${basename}.arrow (${size})"
  else
    echo "      ✗ Conversion to Arrow failed"
  fi
  
  echo ""
done

cd ..

# ============================================
# Résumé
# ============================================
echo "✅ Conversion complete!"
echo ""
echo "📊 Files created:"
echo ""
echo "Primitives (SEPARATED):"
ls -lh primitives/*.separated.arrow 2>/dev/null || echo "   (none)"
echo ""
echo "Primitives (INTERLEAVED):"
ls -lh primitives/*.interleaved.arrow 2>/dev/null || echo "   (none)"
echo ""
echo "Primitives (WKB):"
ls -lh primitives/*.wkb.arrow 2>/dev/null || echo "   (none)"
echo ""
echo "Real data (INTERLEAVED):"
ls -lh real-data/*.arrow 2>/dev/null || echo "   (none)"

echo ""
echo "🚀 To test, run:"
echo "   cd ../.."
echo "   python3 -m http.server 8000"
echo "   # Then open http://localhost:8000/examples/test-viewer.html"
