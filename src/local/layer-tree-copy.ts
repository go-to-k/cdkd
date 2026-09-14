import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Merge one Lambda Layer's asset tree into the directory that will be
 * bind-mounted at `/opt`, with AWS's "last layer wins" semantic and with
 * symlinks kept VERBATIM (issue #3106).
 *
 * Why this is a hand-written walk and not `cpSync`. The merge used to be
 * `cpSync(src, dest, { recursive: true, force: true })`, and every
 * `cpSync`-shaped repair of it was measured wrong in some direction:
 *
 *   - Without `verbatimSymlinks: true` (the default), `cpSync` rewrites a
 *     RELATIVE link target to the ABSOLUTE path of the source on the host —
 *     `bin/rel-link -> real.sh` arrives as `-> <cdk.out>/asset.<hash>/bin/
 *     real.sh`, which is dangling inside the container, where only `dest`
 *     is mounted. Measured on Node 22.12 / 24.21.
 *   - WITH `verbatimSymlinks: true`, Node's C++ `cpSync` (every release
 *     after 22.12) throws `EEXIST` when a later layer carries a symlink at a
 *     path an earlier layer already placed one — `nodejs/node_modules/.bin/
 *     <tool>` in two layers built from the same dependency is the ordinary
 *     case. Measured by the go-to-k/cdkd#3118 review on 22.23 / 24.15 /
 *     24.21; the JS implementation on 22.12 does not throw, which is why
 *     the floor alone did not show it.
 *   - A `cpSync` + `readdirSync({ recursive: true })` pair was worse:
 *     the recursive readdir DESCENDS INTO directory symlinks on every Node
 *     after 22.12 (not on 22.12), so a cyclic link (`sub/up -> ..`, or a
 *     pnpm-style `node_modules`) hung the merge, and an absolute link to a
 *     host directory made the walk delete and write INSIDE that host
 *     directory. And `cpSync`'s `force` writes THROUGH a destination that
 *     is already a directory symlink, so a later layer's real directory
 *     landed in the earlier layer's link target — on the host, when the
 *     link was absolute. Same review, same versions.
 *
 * So the walk is explicit and recurses only on a real directory (`d_type`,
 * via `Dirent.isDirectory()`, which reports a directory symlink as a
 * symlink on 22.12 and 24.21 alike). Per entry, "last layer wins" is applied
 * the same way for every kind: whatever sits at the destination path that is
 * not of the same kind is removed first — a link, a file, or a whole
 * directory an earlier layer placed — then the entry lands. A symlink is
 * recreated with the SOURCE's own target string and never resolved, so an
 * absolute link stays absolute and a dangling one stays dangling, exactly as
 * AWS extracts the layer ZIP into `/opt`; nothing is ever written through a
 * link. A file is copied with `cpSync` (single file, `force`), which is what
 * preserves the mode bits, so a layer's `bin/<script>` keeps its `+x` — the
 * property the `local-invoke-layers` fixture executes through.
 *
 * The ROOT may itself be a symlink (an asset dir handed over through a link
 * passes `resolveAssetCodePath`'s `statSync`); it is resolved once so the
 * walk starts from a real directory.
 *
 * Both layer merges (`cdkd local invoke` and `cdkd local start-api`) call
 * this; keep them on the one helper rather than re-spelling copy options.
 */
export function copyLayerTreeLastWins(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  copyDirLastWins(realpathSync(src), dest);
}

function copyDirLastWins(fromDir: string, toDir: string): void {
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = join(fromDir, entry.name);
    const to = join(toDir, entry.name);
    if (entry.isSymbolicLink()) {
      removeUnless(to, 'symlink');
      symlinkSync(readlinkSync(from), to);
    } else if (entry.isDirectory()) {
      removeUnless(to, 'directory');
      mkdirSync(to, { recursive: true });
      copyDirLastWins(from, to);
    } else {
      removeUnless(to, 'file');
      cpSync(from, to, { force: true });
    }
  }
}

/**
 * Clear the destination path unless what is there is already of `kind`. A
 * directory is kept so a later layer MERGES into it; a file is kept because
 * `cpSync` overwrites it in place; a symlink is always replaced (its target
 * string comes from the later layer).
 */
function removeUnless(to: string, kind: 'symlink' | 'directory' | 'file'): void {
  let st;
  try {
    st = lstatSync(to);
  } catch {
    return;
  }
  if (kind === 'directory' && st.isDirectory()) return;
  if (kind === 'file' && st.isFile()) return;
  rmSync(to, { recursive: true, force: true });
}
