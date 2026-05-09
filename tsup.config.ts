import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/host.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['react', 'react-dom', '@signalsandsorcery/plugin-sdk'],
  jsx: 'automatic',
});
