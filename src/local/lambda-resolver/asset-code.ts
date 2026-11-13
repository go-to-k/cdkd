import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import {
  absoluteAssemblyPathEscape,
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../utils/assembly-path.js';
import { displayIdent } from '../../utils/display-safe.js';
import { getLogger } from '../../utils/logger.js';
import { plainOrDescribed } from '../../utils/pasteable-command.js';
import { LocalInvokeResolutionError } from './types.js';

/**
 * Every value that decides what {@link resolveAssetCodeDirectory} does, as a
 * BAG rather than positionals (issue
 * [#3549](https://github.com/go-to-k/cdkd/issues/3549)).
 *
 * Declared ABOVE its function deliberately. Four of these interfaces have had
 * their doc block detach from the declaration below them in this repo, each
 * time by an edit that inserted between the two; putting the interface at the
 * top of the region leaves nothing to insert into.
 */
export interface AssetCodeResolveOptions {
  /**
   * Where a RELATIVE `assetPath` resolves FROM — the manifest's own directory,
   * which is assembly-derived. Distinct from `assetOutdir`, which is what the
   * result must stay inside.
   */
  manifestDir: string;
  /**
   * The Lambda's `Metadata['aws:asset:path']`. Attacker-chosen under an
   * assembly the user did not synthesize, and BIND-MOUNTED into a running
   * container, which is why it and `manifestDir` must not be swappable.
   */
  assetPath: string;
  /** Wrap the refusal in the caller's own typed error class. */
  wrapError: (message: string) => Error;
  /**
   * The app's outdir, the CONTAINMENT bound. NOT the manifest's directory —
   * the function's own doc says why, and getting it wrong refuses every Stage
   * asset rather than opening a hole, which no refusal test can see.
   */
  assetOutdir: string;
  /** How to name the Lambda in a refusal. Only ever interpolated into a message. */
  logicalId: string;
}

/**
 * Where a Lambda's `Metadata['aws:asset:path']` really lives on this host
 * (issue [#3494](https://github.com/go-to-k/cdkd/issues/3494)).
 *
 * THE one spelling shared by `cdkd local invoke`'s resolver and
 * `cdkd local start-api`'s, which each carried their own copy of
 * `isAbsolute(p) ? p : resolve(dir, p)`. A second hand-written copy is how a
 * guard on one twin becomes a guard on neither — the argument
 * `resolveFileAssetSourcePath` and `resolveDockerContextDirectory` each
 * make about their own pair. It throws through the CALLER's `wrapError` so
 * each keeps its own typed error class and names its own command.
 *
 * TWO VALUE SHAPES, ANSWERED DIFFERENTLY, and the asymmetry is the decision
 * rather than an accident:
 *
 * - RELATIVE, escaping. REFUSED. `path.resolve` folds `..` exactly as
 *   `path.join` does, so `../../../home/<user>/.aws` leaves the assembly, and
 *   nothing a real `cdk synth` emits has that shape.
 * - ABSOLUTE. ACCEPTED, with a WARNING naming the path when it leaves the
 *   asset outdir.
 *
 * **Why absolute is accepted, when the security axis argued for refusing it.**
 * `cdk synth --no-staging` (context flag `aws:cdk:disable-asset-staging`) makes
 * upstream `AssetStaging.relativeStagedPath` return the staged path verbatim
 * instead of relativising it, so `aws:asset:path` is the asset's absolute
 * SOURCE directory, normally outside the outdir. Measured on aws-cdk-lib 2.268:
 * `noStaging=false` gives `asset.<hash>`, `noStaging=true` gives
 * `/abs/path/to/srcdir`. Refusing it therefore rejects the output of a
 * documented CDK CLI flag — AWS's own pre-step for `sam local invoke` — and the
 * user's view is simply that cdkd will not read what `cdk` just wrote.
 *
 * The maintainer weighed that against the security reading and chose
 * acceptance. Record BOTH halves, because the trade is real and a later reader
 * must not "restore" the refusal as an oversight:
 *
 * - The security cost is genuine. This value is BIND-MOUNTED read-only at
 *   `/var/task` (or `/opt` for a layer) into a container running handler code
 *   the SAME assembly supplied, and `cdkd local invoke` forwards the caller's
 *   credentials, so an absolute path a hostile assembly chose reaches the host
 *   filesystem. cdkd cannot distinguish a `--no-staging` value from a planted
 *   one: both are an absolute directory the assembly named.
 * - What bounds it: this is a LOCAL developer command run against an assembly
 *   the user pointed at, the mount is read-only, and the warning names the path
 *   so an unexpected one is visible rather than silent.
 *
 * The `..` containment is NOT relaxed with it — but be precise about what that
 * still buys, because an earlier revision of this comment claimed it "keeps the
 * shape go-to-k/cdkd#3489 closed" and that is FALSE. Against an ADVERSARY it
 * stops nothing: they write the ABSOLUTE spelling and reach the same place with
 * a warning instead of a refusal (`/Users/<user>/.aws` directly, or a path
 * `path.resolve` folds for them). What it still catches is an ACCIDENTAL or
 * legacy `..`, and it costs nothing, which is why the arm stays. **There is no
 * containment boundary here any more; the warning is the whole signal.** The
 * docs say so to users in the same words.
 *
 * CONTAIN WITHIN `assetOutdir`, NOT the manifest's directory. A Lambda inside a
 * `cdk.Stage` legitimately carries `../asset.<hash>`, because `cdk synth`
 * stages a Stage's assets into the APP's outdir while the Stage's manifest sits
 * in `cdk.out/assembly-<Stage>/`. Binding to the manifest directory refuses
 * every Stage asset as "hand-modified" — go-to-k/cdkd#3493's B1, fixed there
 * and re-provable here by the Stage acceptance cases in
 * `tests/unit/local/local-asset-code-path-containment.test.ts`.
 *
 * Exported for unit testing and for `local-start-api.ts`'s copy of the caller.
 *
 * **Takes EVERY value in a bag** (issue
 * [#3549](https://github.com/go-to-k/cdkd/issues/3549)), the shape
 * [#3544](https://github.com/go-to-k/cdkd/issues/3544) gave the Docker twin
 * and for a sharper version of the same reason. Positionals left FOUR `string`
 * parameters in a row, of which two pairs were transposable and neither
 * typechecked its way out:
 *
 * - `(manifestDir, assetPath)` — the assembly-derived base a relative value
 *   resolves FROM, and the attacker-chosen `aws:asset:path`. Swapping them
 *   changes which directory is resolved and which is contained, for a value
 *   that is then BIND-MOUNTED into a running container. That is the Docker
 *   twin's hazard with a worse sink.
 * - `(assetOutdir, logicalId)` — the containment bound and a string that only
 *   ever reaches a message. A swap made the bound `path.resolve('<logicalId>')`
 *   under the cwd, disjoint from the base, so every path was refused. Caught
 *   by tests rather than by the compiler, which is the wrong layer for it.
 *
 * Required-ness caught a DROP and never a TRANSPOSITION, and the DROP it
 * caught was real: a call passing the outdir as the fourth argument and
 * stopping there used to COMPILE while binding the outdir to `logicalId` and
 * defaulting the bound to `manifestDir`, silently reinstating
 * [#3493](https://github.com/go-to-k/cdkd/issues/3493)'s B1 and naming the
 * Lambda `/path/to/cdk.out` in the refusal.
 *
 * **What the bag does NOT do, because the first draft of this paragraph
 * claimed it did**: it does not make a transposition inexpressible, only
 * UNORDERABLE. `{ manifestDir: assetOutdir, assetOutdir: manifestDir }` still
 * compiles, and it is still the defect. Measured: that spelling passes every
 * source-level check and reds three cases in
 * `local-asset-code-path-containment.test.ts`, which drives both call sites
 * against a STAGE manifest where the two directories differ. The compiler now
 * rejects the silent POSITIONAL swap; that suite is what catches the named
 * one. Do not write a source scan that claims to cover this — one was written
 * here and passed the real defect.
 *
 * Two conventions this comment has learned the hard way and keeps:
 *
 * - **No count of how often it has been wrong.** Such a tally ticks on the
 *   very revision that fixes it, so it is stale the moment it is written —
 *   which is how the previous one went stale.
 * - **Do not cite the Docker twin's PARAMETER LIST.** Two revisions did, and
 *   both were left describing a signature that had moved. Citing its SHAPE
 *   (an options bag, as above) is stable; citing its arguments is not.
 */
export function resolveAssetCodeDirectory(opts: AssetCodeResolveOptions): string {
  const { manifestDir, assetPath, wrapError, assetOutdir, logicalId } = opts;
  if (isAbsolute(assetPath)) {
    // ACCEPTED — see the header. `path.resolve` only normalises here, the value
    // already being absolute; it is what makes the warning name the directory
    // that is really mounted rather than an unfolded spelling of it.
    const absolute = resolve(assetPath);
    const escape = absoluteAssemblyPathEscape(assetOutdir, absolute);
    if (escape !== undefined) {
      // WARN, never throw: the one producer of this shape is a real
      // `cdk synth --no-staging`, and refusing it rejects the output of a
      // documented CDK CLI flag. The warning exists so an absolute path the
      // user did NOT expect is visible rather than silent, so it names the
      // directory and says what is done with it.
      // cdkd-raw-beside-safe: every RENDERED operand is a `displaySafe(...)`
      // or `displayAssemblyPath(...)` call. What the fence reads as a raw
      // neighbour is `escape.escape === 'symlink'`, a DISCRIMINANT comparison
      // choosing between two of this file's literals — it selects text, it
      // does not render a value.
      getLogger().warn(
        `Lambda ${displayIdent(logicalId)} has an absolute ` +
          `Metadata['aws:asset:path'] pointing outside the assembly: ` +
          `${displayAssemblyPath(absolute)}` +
          (escape.escape === 'symlink'
            ? ` (through a symbolic link to ${displayAssemblyPath(escape.realPath)})`
            : '') +
          `. cdkd will bind-mount that directory into the container read-only, where ` +
          `the code in this assembly can read it. This is what ` +
          `cdk synth --no-staging emits, and is expected for it; if you did not ` +
          `synthesize with that flag, treat this assembly as untrusted.`
      );
    }
    return absolute;
  }
  // RESOLVE against the manifest's directory, CONTAIN within the app's outdir.
  const resolved = resolveAssemblyPath(manifestDir, assetPath, {
    containWithin: assetOutdir,
  });
  // NAMING THE BOUND ITSELF is not an escape here, and the two arms must agree
  // about that. `resolveAssemblyPath`'s `isInside` is false for an empty
  // `path.relative`, and `renderAssemblyPathEscape` then says the value "names
  // the directory ... rather than a file inside it" — a true and useful
  // diagnosis for its other nineteen callers, every one of which READS A FILE,
  // and a false one here, where the value is a DIRECTORY to bind-mount by
  // design. Left alone it also contradicts the absolute arm, which accepts the
  // same directory, and it already disagreed with ITSELF: with `containWithin`
  // set, `.` from a Stage manifest resolves INSIDE the wider bound and is
  // accepted, while `.` from a top-level one lands on the bound and is refused.
  // So accept it HERE rather than changing the shared helper, whose refusal is
  // right for a file. No real synth emits either shape.
  if (
    !resolved.contained &&
    resolved.escape === 'lexical' &&
    resolved.path === resolve(assetOutdir)
  ) {
    return resolved.path;
  }
  if (!resolved.contained) {
    // cdkd-raw-beside-safe: `renderAssemblyPathEscape` is a safe RENDERER, not
    // a value — it renders every path through `displayAssemblyPath` and the
    // rest of its text is this file's own literal.
    throw wrapError(
      `Lambda ${displayIdent(logicalId)} has ` +
        `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} which ` +
        `${renderAssemblyPathEscape(resolved, assetOutdir, 'mount it')}`
    );
  }
  return resolved.path;
}

/**
 * The two directories an asset path is judged against — THE one spelling both
 * resolvers derive them with, for the same reason
 * {@link resolveAssetCodeDirectory} is one function: go-to-k/cdkd#3493's own
 * defect was two sites disagreeing about the BOUND, which no refusal test can
 * see.
 *
 * Asset paths are relative to the manifest's own directory: the stack's
 * `assetManifestPath` is `<cdk.out>/<stack>.assets.json` (for a Stage stack,
 * `<assembly-dir>/<artifactId>.assets.json`), so stripping the filename gives
 * the base.
 *
 * `assetOutdir` is the app's outdir and is the CONTAINMENT bound. An ABSENT one
 * falls back to the base, which is correct for a top-level stack and NARROWS
 * for a Stage — it never opens past the base, so a hand-built `StackInfo`
 * carrying neither field is refused rather than admitted. `AssemblyReader`
 * always sets it.
 *
 * **The two fallbacks are asymmetric, and the base's prefers `assetOutdir` over
 * `process.cwd()` for a reason that is not stylistic.** `AssemblyReader` always
 * sets `assetOutdir` but may leave `assetManifestPath` undefined, so taking
 * `process.cwd()` there produced a base DISJOINT from the bound — nothing under
 * the cwd is inside `cdk.out` — and every asset path was refused with a message
 * blaming the assembly. Fail-closed, so never a hole, but a wrong diagnosis.
 * `process.cwd()` survives only for a `StackInfo` carrying NEITHER field, where
 * base and bound coincide again.
 *
 * Exported for `local-start-api.ts`'s copy of the caller, and for unit
 * testing.
 */
export function assetPathDirs(stack: Pick<StackInfo, 'assetManifestPath' | 'assetOutdir'>): {
  manifestDir: string;
  assetOutdir: string;
} {
  const manifestDir = stack.assetManifestPath
    ? dirname(stack.assetManifestPath)
    : (stack.assetOutdir ?? process.cwd());
  return { manifestDir, assetOutdir: stack.assetOutdir ?? manifestDir };
}

/**
 * Resolve the local directory that corresponds to a function's deployed
 * asset, using the CDK-blessed `Metadata['aws:asset:path']` hint (D2). The
 * value is a directory path relative to `cdk.out` (e.g. `asset.abc123def`)
 * and CDK has already unzipped it for us — we bind-mount the directory
 * directly, no re-zipping.
 *
 * Falls back to a clear error when the metadata is missing OR the resolved
 * directory does not exist (CDK should always emit it for asset-backed
 * Lambdas; absence usually means the user pre-synthesized with a different
 * cdk.out and pointed `--output` at a stale one). Through
 * {@link resolveAssetCodeDirectory} it REFUSES an escaping RELATIVE value and
 * WARNS on an ABSOLUTE one that leaves the asset outdir -- see that function
 * for why the two differ.
 */
export function resolveAssetCodePath(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource,
  /**
   * Also accept a `.zip` file asset (a layer CDK ships pre-packaged, such as
   * `s3deploy`'s `AwsCliLayer`); the caller extracts it (go-to-k/cdkd#6206).
   */
  options: { acceptZipFile?: boolean } = {}
): string {
  const meta = resource.Metadata;
  const assetPath = meta?.['aws:asset:path'];
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    throw new LocalInvokeResolutionError(
      `Lambda ${plainOrDescribed(logicalId, 'logical id')} has no Metadata['aws:asset:path']. ` +
        'cdkd local invoke needs this hint to find the local asset directory. ' +
        "Re-synthesize the app (without `--output '<stale-dir>'`) and retry."
    );
  }

  const { manifestDir, assetOutdir } = assetPathDirs(stack);
  const abs = resolveAssetCodeDirectory({
    manifestDir,
    assetPath,
    wrapError: (message) => new LocalInvokeResolutionError(message),
    assetOutdir,
    logicalId,
  });
  if (
    options.acceptZipFile === true &&
    abs.toLowerCase().endsWith('.zip') &&
    existsSync(abs) &&
    statSync(abs).isFile()
  ) {
    return abs;
  }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new LocalInvokeResolutionError(
      `Lambda ${displayIdent(logicalId)} asset directory ${displayAssemblyPath(abs)} does not exist ` +
        'or is not a directory. Re-synthesize the app and retry.'
    );
  }
  return abs;
}
