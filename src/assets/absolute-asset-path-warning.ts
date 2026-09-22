import type { ResolvedAssemblyPath } from '../utils/assembly-path.js';
import { displaySafe } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';

/**
 * THE one spelling of the warning both asset resolvers emit when an ABSOLUTE
 * manifest-supplied path leaves the app's output directory (issue
 * [#3532](https://github.com/go-to-k/cdkd/issues/3532)).
 *
 * One function for the reason `resolveFileAssetSourcePath` is one function:
 * two hand-written copies of a warning drift, and the twin the user compares
 * it against is the one that did not change. What must NOT be shared is the
 * SINK clause — see {@link AbsoluteAssetPathWarning.sink}.
 */
export interface AbsoluteAssetPathWarning {
  /** The subject clause, already rendered — e.g. `File asset 'X'`. */
  subject: string;
  /** The manifest field, a literal of the calling module. */
  field: 'source.path' | 'source.directory';
  /** The resolved absolute path. Rendered here; pass it RAW. */
  absolute: string;
  /** The verdict from `absoluteAssemblyPathEscape`; never `undefined`. */
  escape: Extract<ResolvedAssemblyPath, { contained: false }>;
  /**
   * What THIS caller does with the directory next, as a sentence completing
   * "cdkd will ...". **Caller-supplied, and that is the point.** The resolvers
   * are shared by callers with different sinks: the file one is reached both
   * from `FileAssetPublisher.publish`, which zips and uploads, and from
   * `cdkd local invoke --agentcore`, which only reads; the Docker one is
   * reached from the BuildKit context AND from the `source.executable` arm,
   * where the directory becomes the working directory of a manifest-supplied
   * argv — a different and larger risk. A single baked-in "will upload it"
   * narrates something that does not happen on half the paths, which teaches
   * users to discount the line.
   *
   * Written as a literal at each call site, never interpolated from
   * assembly-supplied text.
   */
  sink: string;
}

/**
 * Emit it. Deliberately `warn`, never `throw`: the one producer of this shape
 * is a real `cdk synth --no-staging`, and refusing rejects the output of a
 * documented CDK CLI flag.
 */
export function warnAbsoluteAssetPath(w: AbsoluteAssetPathWarning): void {
  // The child names the LAYER, not one module: both resolvers are shared, so
  // naming either misattributes the line at the other's call sites (a
  // `FileAssetPublisher.publish` warning used to read `[AssetManifestLoader]`).
  getLogger()
    .child('assets')
    .warn(
      `${w.subject} has an absolute ${w.field} pointing outside the assembly: ` +
        `'${displaySafe(w.absolute)}'` +
        (w.escape.escape === 'symlink'
          ? ` (through a symbolic link to '${displaySafe(w.escape.realPath)}')`
          : '') +
        `. cdkd will ${w.sink}. This is what cdk synth --no-staging emits, and is ` +
        `expected for it; if you did not synthesize with that flag, treat this ` +
        `assembly as untrusted — before this release an absolute path could not ` +
        `reach that step at all.`
    );
}
