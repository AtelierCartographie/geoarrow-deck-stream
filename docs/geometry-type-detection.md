# Détection du Type de Géométrie GeoArrow

## Vue d'ensemble

La bibliothèque utilise **exclusivement les métadonnées d'extension Arrow** pour détecter le type de géométrie. Cette approche simple et fiable est conforme à la spécification GeoArrow officielle.

## Spécification GeoArrow

La [spécification GeoArrow officielle](https://geoarrow.org/) utilise le mécanisme **Arrow Extension Type** pour indiquer le type de géométrie dans les métadonnées du Field :

```
ARROW:extension:name = "geoarrow.linestring"
ARROW:extension:name = "geoarrow.polygon"
ARROW:extension:name = "geoarrow.multilinestring"
ARROW:extension:name = "geoarrow.multipolygon"
```

## Accès aux métadonnées

Les métadonnées sont **stockées au niveau du Field** dans le Schema de la Table :

```typescript
const table = tableFromIPC(buffer);
const geomField = table.schema.fields.find((f) => f.name === "geometry");
const extensionName = geomField.metadata?.get("ARROW:extension:name");
// => "geoarrow.multilinestring"
```

## Utilisation

```typescript
import { tableFromIPC, parseGeometry } from "geoarrow-deck-stream";

// Charger le fichier Arrow
const buffer = readFileSync("data.arrow");
const table = tableFromIPC(buffer);

// Parser la Table (détection automatique via métadonnées)
const result = parseGeometry(table, {
  projection: geoOrthographic(),
});
```

**Avantages** :

- ✅ Standard GeoArrow officiel
- ✅ Fonctionne avec tous les producteurs (GDAL, DuckDB, GeoParquet)
- ✅ Distingue sans ambiguïté tous les types de géométrie
- ✅ Code simple et maintenable

## Exigences

### Pour les utilisateurs

**Vous devez toujours passer une Table** avec les métadonnées GeoArrow :

```typescript
// ✅ CORRECT
const table = tableFromIPC(buffer);
parseGeometry(table, options);

// ❌ NON SUPPORTÉ
const vector = table.getChild("geometry");
parseGeometry(vector, options); // TypeError
```

### Pour les producteurs de données

Assurez-vous que vos fichiers GeoArrow incluent les métadonnées d'extension :

```bash
# GDAL ajoute automatiquement les métadonnées
ogr2ogr -f Arrow output.arrow input.geojson
```

## Implémentation

La fonction `detectGeometryType()` lit simplement les métadonnées :

```typescript
export function detectGeometryType(
  table: Table,
  geometryColumnName = "geometry"
): "linestring" | "polygon" | "multilinestring" | "multipolygon" | "unknown" {
  const geomField = table.schema.fields.find(
    (f) => f.name === geometryColumnName
  );
  const extensionName = geomField?.metadata?.get("ARROW:extension:name");

  switch (extensionName) {
    case "geoarrow.linestring":
      return "linestring";
    case "geoarrow.polygon":
      return "polygon";
    case "geoarrow.multilinestring":
      return "multilinestring";
    case "geoarrow.multipolygon":
      return "multipolygon";
    default:
      return "unknown";
  }
}
```

Code : [src/arrow-reader.ts](../src/arrow-reader.ts)

## Pourquoi uniquement les métadonnées ?

Les approches alternatives (noms de champs enfants, inférence structurelle) sont :

- ❌ **Moins fiables** : ne distinguent pas toujours Polygon vs MultiLineString
- ❌ **Plus complexes** : nécessitent une cascade de fallbacks
- ❌ **Non standard** : dépendent de conventions non officielles

La détection par métadonnées est :

- ✅ **100% fiable** : définie par la spec
- ✅ **Simple** : une seule méthode, sans fallbacks
- ✅ **Performante** : lecture directe sans analyse de structure

## Références

- [Spécification GeoArrow](https://geoarrow.org/)
- [Arrow Extension Types](https://arrow.apache.org/docs/format/Columnar.html#extension-types)
- [@geoarrow/geoarrow-js](https://github.com/geoarrow/geoarrow-js)
