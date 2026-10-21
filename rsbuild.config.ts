import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  source: {
    entry: {
      index: './src/index.ts',
      'session-watcher': './src/session-watcher.ts',
    },
  },
  output: {
    target: 'node',
    distPath: {
      root: 'dist',
    },
    filename: {
      js: '[name].js',
    },
    cleanDistPath: true,
  },
  tools: {
    rspack: {
      externalsPresets: { node: true },
      externals: ['@larksuiteoapi/node-sdk'],
      // Each entry is deployed as a standalone file; the daemon and the supervisor must not depend on shared chunks.
      optimization: { splitChunks: false },
    },
  },
});
