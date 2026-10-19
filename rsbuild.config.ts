import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  source: {
    entry: {
      index: './src/index.ts',
      cli: './src/cli.ts',
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
    },
  },
});
