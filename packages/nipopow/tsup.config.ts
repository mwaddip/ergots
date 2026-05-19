import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/envelope.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  // OPS-04: published tarballs previously included source maps with full
  // sourcesContent and local-path references (~/projects/sigma-rust etc.),
  // which leak developer paths and bloat the tarball. Disable sourcemap
  // emission; consumers who need to debug can clone the repo or build
  // a sourcemap-enabled bundle locally from the published `src/`.
  sourcemap: false,
  target: 'es2022',
  platform: 'neutral',
});
