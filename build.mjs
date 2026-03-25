#!/usr/bin/env node

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watchMode = process.argv.includes('--watch');

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  external: [
    // CDK libraries (don't bundle well, use Node.js built-in requires)
    '@aws-cdk/toolkit-lib',
    '@aws-cdk/cdk-assets-lib',
    '@aws-cdk/cloud-assembly-api',
    // AWS SDK clients (bundled separately by users)
    '@aws-sdk/*',
    // Dependencies that don't bundle well
    'commander',
    'graphlib',
    'p-limit',
  ],
  logLevel: 'info',
};

const cliConfig = {
  ...commonOptions,
  entryPoints: [join(__dirname, 'src/cli/index.ts')],
  outfile: join(__dirname, 'dist/cli.js'),
  format: 'esm',
  banner: {
    js: '#!/usr/bin/env node\n',
  },
};

const libConfig = {
  ...commonOptions,
  entryPoints: [join(__dirname, 'src/index.ts')],
  outfile: join(__dirname, 'dist/index.js'),
  format: 'esm',
};

async function build() {
  try {
    if (watchMode) {
      console.log('👀 Watching for changes...');
      const cliContext = await esbuild.context(cliConfig);
      const libContext = await esbuild.context(libConfig);
      await Promise.all([cliContext.watch(), libContext.watch()]);
    } else {
      console.log('🔨 Building...');
      await Promise.all([esbuild.build(cliConfig), esbuild.build(libConfig)]);
      console.log('✅ Build complete!');
    }
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
