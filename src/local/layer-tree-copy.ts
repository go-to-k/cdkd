import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Merge one Lambda Layer's asset tree into the directory that will be
 * bind-mounted at `/opt`, with AWS's "last layer wins" semantic and with
 * symlinks kept VERBATIM (issue #3106).
 *
 * Why this is not one `cpSync` call. The merge used to be
 * `cpSync(src, dest, { recursive: true, force: true })`, and that has two
 * defects that pull in opposite directions:
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
 *     case — so a merge that used to succeed would refuse. Measured by the
 *     review of go-to-k/cdkd#3118 on 22.23 / 24.15 / 24.21; the JS
 *     implementation on 22.12 does not throw, which is why the floor alone
 *     did not show it.
 *
 * So the copy is split: `cpSync` handles everything that is NOT a symlink
 * (it is what preserves the mode bits, so a layer's `bin/<script>` keeps its
 * `+x` — the property the `local-invoke-layers` fixture executes through),
 * and the symlinks are placed by hand afterwards: whatever sits at the
 * destination path is removed first, then the link is recreated with the
 * SOURCE's own target string. That gives last-wins for link-over-link,
 * link-over-file and file-over-link alike, and never resolves a target — an
 * absolute link stays absolute, a dangling one stays dangling, exactly as
 * AWS extracts the layer ZIP into `/opt`.
 *
 * Both layer merges (`cdkd local invoke` and `cdkd local start-api`) call
 * this; keep them on the one helper rather than re-spelling the options.
 */
export function copyLayerTreeLastWins(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (p) => !lstatSync(p).isSymbolicLink(),
  });
  for (const entry of readdirSync(src, { withFileTypes: true, recursive: true })) {
    if (!entry.isSymbolicLink()) continue;
    const from = join(entry.parentPath, entry.name);
    const to = join(dest, relative(src, from));
    mkdirSync(dirname(to), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    symlinkSync(readlinkSync(from), to);
  }
}
