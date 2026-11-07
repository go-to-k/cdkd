import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * cdkd's directory in the user's own cache home: `$XDG_CACHE_HOME/cdkd` (an
 * absolute `XDG_CACHE_HOME` only) or `~/.cache/cdkd`.
 *
 * NEVER a directory under the OS temp root: on a multi-user host with a shared
 * `/tmp`, another local user can create it first and plant entries cdkd would
 * then load or execute. A directory under the user's home is writable by that
 * user alone.
 *
 * `undefined` when no home directory can be determined; the caller then skips
 * its cache rather than falling back to a shared location.
 */
export function cdkdCacheHome(
  env: NodeJS.ProcessEnv,
  home: () => string = homedir
): string | undefined {
  const xdg = env['XDG_CACHE_HOME'];
  // A relative value is ignored, as the XDG Base Directory spec requires: it
  // would resolve against the cwd, i.e. inside the CDK project a user may have
  // just cloned, which could ship planted cache entries.
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, 'cdkd');
  let dir: string;
  try {
    dir = home();
  } catch {
    return undefined;
  }
  // A relative (or empty) HOME would resolve against the cwd the same way.
  return isAbsolute(dir) ? join(dir, '.cache', 'cdkd') : undefined;
}
