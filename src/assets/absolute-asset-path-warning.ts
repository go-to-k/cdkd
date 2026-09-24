import { displayAssemblyPath, type ResolvedAssemblyPath } from '../utils/assembly-path.js';
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
   * **Any assembly-supplied text a caller interpolates must be `displaySafe`d
   * BY THE CALLER before it reaches here**, and one caller does interpolate:
   * `FileAssetPublisher` names the destination `s3://<bucket>/<key>`, both of
   * which the manifest chose, and sanitizes each before building the clause.
   * (An earlier revision of this line claimed the field was always a literal,
   * which was already false when written. `src/assets/**` is outside the
   * `cdkd-raw-beside-safe` scan, so nothing would have caught a caller that
   * believed it.)
   */
  sink: string;
}

/**
 * The one OTHER thing worth a line: the source resolves to the app's output
 * directory ITSELF, so the sink gets the whole assembly — every template and
 * every staged asset — rather than one asset directory.
 *
 * It is a WARNING and not a refusal for the same reason its sibling is, and it
 * must not be silent for a reason the sibling does not share: both resolvers
 * accept this value (issue
 * [#3532](https://github.com/go-to-k/cdkd/issues/3532)) because the absolute
 * arm treats the bound as inside and the two arms must agree, and because the
 * local twin legitimately bind-mounts a directory. But on THIS layer the sink
 * is an upload or an image build, so "package the whole output directory and
 * send it to a bucket this manifest named" is exactly the sentence a user
 * needs and exactly the one an accept-silently arm withholds. No real `cdk
 * synth` emits `source.path: "."`, so this costs a legitimate run nothing.
 */
export function warnWholeAssemblyAsSource(w: {
  subject: string;
  field: 'source.path' | 'source.directory';
  /** The output directory, which the value resolved onto. */
  outdir: string;
  /** As on {@link AbsoluteAssetPathWarning.sink}. */
  sink: string;
}): void {
  getLogger()
    .child('assets')
    .warn(
      `${w.subject} has ${w.field} naming the output directory ITSELF: ` +
        `${displayAssemblyPath(w.outdir)}. cdkd will ${w.sink} — that is the WHOLE ` +
        `assembly, every template and every staged asset, not one asset ` +
        `directory. No CDK synth emits this, so treat this assembly as ` +
        `untrusted unless you wrote that path yourself.`
    );
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
        `${displayAssemblyPath(w.absolute)}` +
        (w.escape.escape === 'symlink'
          ? ` (through a symbolic link to ${displayAssemblyPath(w.escape.realPath)})`
          : '') +
        `. cdkd will ${w.sink}. This is what cdk synth --no-staging emits, and is ` +
        `expected for it; if you did not synthesize with that flag, treat this ` +
        `assembly as untrusted: an absolute source path is honoured as written, ` +
        `so nothing but this line stands between it and that step.`
    );
}
