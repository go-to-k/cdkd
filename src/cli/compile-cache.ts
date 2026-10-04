import { enableCompileCache } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Where cdkd keeps Node's compile cache: a directory in the user's own cache
 * home, `$XDG_CACHE_HOME/cdkd/compile-cache` (an absolute `XDG_CACHE_HOME`
 * only) or `~/.cache/cdkd/compile-cache`.
 *
 * NOT Node's default, `node-compile-cache` under the OS temp directory: on a
 * multi-user host with a shared `/tmp`, another local user can create that
 * directory first, and Node validates entries only by checksum, so cached
 * code planted there would be loaded by cdkd. A directory under the user's
 * home is writable by that user alone.
 *
 * `undefined` when no home directory can be determined; the cache then stays
 * off rather than falling back to a shared location.
 */
export function compileCacheDirectory(
  env: NodeJS.ProcessEnv,
  home: () => string = homedir
): string | undefined {
  const xdg = env['XDG_CACHE_HOME'];
  // A relative value is ignored, as the XDG Base Directory spec requires: it
  // would resolve against the cwd, i.e. inside the CDK project a user may have
  // just cloned, which could ship planted cache entries.
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, 'cdkd', 'compile-cache');
  let dir: string;
  try {
    dir = home();
  } catch {
    return undefined;
  }
  return dir === '' ? undefined : join(dir, '.cache', 'cdkd', 'compile-cache');
}

/**
 * Enable Node's on-disk compile cache in {@link compileCacheDirectory}.
 *
 * Call it BEFORE importing the command tree: only modules loaded afterwards
 * are cached. Node honours `NODE_DISABLE_COMPILE_CACHE`, and a
 * `NODE_COMPILE_CACHE` the user set has already enabled the cache at startup,
 * in which case this call changes nothing. An unwritable directory only
 * yields a failure status; Node never throws or prints for it.
 */
export function enableUserCompileCache(): void {
  const dir = compileCacheDirectory(process.env);
  if (dir !== undefined) enableCompileCache(dir);
}
