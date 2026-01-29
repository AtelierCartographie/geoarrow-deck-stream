// rollup.config.js
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/geoarrow-deck-stream.mjs',
      format: 'es',
      sourcemap: true,
    },
    {
      file: 'dist/geoarrow-deck-stream.min.mjs',
      format: 'es',
      plugins: [terser()],
      sourcemap: true
    }
  ],
  external: [
    'apache-arrow', 
    '@geoarrow/geoarrow-js', 
    '@deck.gl/core', 
    '@deck.gl/layers',
    // d3-geo and earcut are dependencies, so they can be bundled 
    // to provide a "standalone" feeling for the logic, 
    // OR kept external if we expect the user to have them.
    // Given the previous size check (43KB minified with them), 
    // it is often better to bundle small libs like earcut/d3-geo 
    // to reduce dependency hell for the user, UNLESS they are huge.
    // d3-geo is medium. let's keep them bundled for the "distribution" build,
    // but the 'package.json' will still list them as dependencies for NPM consumers.
    // Actually, for a library consumed via bundlers, we usually leave dependencies external.
    // But for a "production build" artifact (like for a CDN), we bundle them.
    // Let's stick to the previous config which seemed to satisfy the user:
    // bundling d3-geo & earcut.
  ],
  plugins: [
    resolve(),
    // We use tsconfig.json but override declaration emission as tsc handles it separately usually,
    // or we let rollup handle it. Since we already have `npm run build` -> `tsc`,
    // let's make rollup just strictly for the JS bundle.
    typescript({ 
      tsconfig: './tsconfig.json',
      compilerOptions: {
        declaration: false,
        declarationMap: false,
        outDir: null // let rollup handle output
      }
    })
  ]
};