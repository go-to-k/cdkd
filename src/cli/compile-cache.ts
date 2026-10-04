import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { getCdkdVersion } from '../version.js';

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
  // A relative (or empty) HOME would resolve against the cwd the same way.
  return isAbsolute(dir) ? join(dir, '.cache', 'cdkd', 'compile-cache') : undefined;
}

/** A version string usable as one path segment: no separator, no `..`. */
const VERSION_SEGMENT = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/**
 * The directory one cdkd version caches into: `<root>/<version>`, or
 * `undefined` for a version that is not a plain path segment.
 *
 * Per version because Node never removes an entry: every upgrade compiles new
 * chunks and the old entries would stay forever. Scoping by version lets
 * {@link pruneOtherVersions} drop the previous version's directory whole.
 */
export function compileCacheVersionDirectory(root: string, version: string): string | undefined {
  return VERSION_SEGMENT.test(version) && !version.includes('..') ? join(root, version) : undefined;
}

/**
 * Delete every entry of `root` except `keep`: the caches of other cdkd
 * versions, and the version-less layout cdkd used before. Synchronous, since
 * a command like `--help` exits before a background delete would finish; it
 * costs time only on the first run after an upgrade, when there is something
 * to delete. Every failure is ignored, since a leftover entry only costs
 * disk. Nothing is deleted when `root` is a symlink or belongs to another
 * user: `readdirSync` follows a symlinked root, so a misconfigured
 * `XDG_CACHE_HOME` would otherwise empty whatever directory it points at.
 * Two cdkd
 * versions used side by side delete each other's cache, so each runs cold —
 * the same as with no cache at all.
 */
export function pruneOtherVersions(root: string, keep: string): void {
  let entries: string[];
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory()) return;
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return;
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === keep) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      // A leftover entry only costs disk.
    }
  }
}

/**
 * Enable Node's on-disk compile cache in this version's directory under
 * {@link compileCacheDirectory}, and prune the other versions' directories.
 *
 * Call it BEFORE importing the command tree: only modules loaded afterwards
 * are cached. Node honours `NODE_DISABLE_COMPILE_CACHE`, and a
 * `NODE_COMPILE_CACHE` the user set has already enabled the cache at startup,
 * in which case this call changes nothing. An unwritable directory only
 * yields a failure status; Node never throws or prints for it.
 */
export function enableUserCompileCache(): void {
  const root = compileCacheDirectory(process.env);
  if (root === undefined) return;
  const version = getCdkdVersion();
  const dir = compileCacheVersionDirectory(root, version);
  if (dir === undefined) return;
  pruneOtherVersions(root, version);
  enableCompileCache(dir);
}
