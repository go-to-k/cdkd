import { writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join } from 'node:path';

/**
 * The environment for a child process that loads `src/**`: dummy credentials,
 * an unroutable endpoint and no instance metadata, so a regression that lost the child's stubbed
 * client cannot reach a real AWS account (the in-process network fence in
 * `tests/setup.ts` does not cover a child process).
 */
export function isolatedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'test-secret-not-real',
    AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  delete env['AWS_SESSION_TOKEN'];
  delete env['AWS_PROFILE'];
  return env;
}

/**
 * Write a Node `--import` preload into `dir` that lets a child process load
 * `src/**` TypeScript directly: `src/` imports its siblings as `./x.js`
 * (AGENTS.md, ESM), which type stripping alone cannot resolve, so a relative
 * `.js` specifier imported FROM a `.ts` file is redirected to the `.ts` file
 * beside it when one exists. Returns the preload's path.
 *
 * For tests whose subject is the PROCESS (how it exits), which the in-process
 * suite cannot observe.
 */
export function writeSourceLoaderHooks(dir: string): string {
  if (typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== 'function') {
    throw new Error(
      `This test needs module.registerHooks (Node >= 22.15); running on ${process.version}.`
    );
  }
  const path = join(dir, 'source-loader-hooks.mjs');
  writeFileSync(
    path,
    `import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js') &&
      context.parentURL?.endsWith('.ts')
    ) {
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});
`
  );
  return path;
}
