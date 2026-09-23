import type { DockerImageAssetSource } from '../types/assets.js';
import {
  describeDockerFailure,
  getDockerCmd,
  redactDockerArgvValues,
  runDockerStreaming,
  spawnStreaming,
} from '../utils/docker-cmd.js';
import { isAbsolute, resolve } from 'path';
import { displaySafe } from '../utils/display-safe.js';
import {
  absoluteAssemblyPathEscape,
  namesTheSameDirectory,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../utils/assembly-path.js';
import {
  warnEscapingBuildKitPaths,
  warnManifestExecutable,
} from './manifest-passthrough-warnings.js';
import { warnAbsoluteAssetPath, warnWholeAssemblyAsSource } from './absolute-asset-path-warning.js';
import { cacheOptionToFlag } from './docker-cache-option.js';
import { getLogger } from '../utils/logger.js';

/**
 * The three values that decide what {@link resolveDockerContextDirectory}
 * does, as a BAG rather than positionals (issue
 * [#3537](https://github.com/go-to-k/cdkd/issues/3537)).
 *
 * **Every parameter, not just the trailing ones**, because this function had
 * two transposable pairs and only one of them was cosmetic.
 * [#3532](https://github.com/go-to-k/cdkd/issues/3532) made each required,
 * which catches a DROP and not a TRANSPOSITION;
 * [#3537](https://github.com/go-to-k/cdkd/issues/3537) bagged the trailing
 * values, where `(…, assetOutdir, assetId)` had compiled and printed
 * `cdkd will cdkd-asset-<hash>` — a wrong word. This bags the LEADING pair
 * too ([#3544](https://github.com/go-to-k/cdkd/issues/3544)), where a swap is
 * not cosmetic: `manifestDir` is the assembly-derived base and `directory` is
 * the attacker-chosen value, so exchanging them changes which directory is
 * resolved and which is contained.
 *
 * The file twin keeps positionals because it has no such pair — its second
 * parameter is a `FileAsset`, so the swap does not typecheck. The invariant is
 * "no transposable adjacent same-typed pair", not "both twins look alike".
 */
export interface DockerContextResolveOptions {
  /**
   * Where a RELATIVE `directory` resolves FROM — the manifest's own directory,
   * which is assembly-derived. Distinct from {@link assetOutdir}, which is
   * what the result must stay inside and comes from the user.
   */
  manifestDir: string;
  /**
   * The manifest-supplied `source.directory`. Attacker-chosen under
   * `cdkd deploy -a <dir>`, which is why it and `manifestDir` must not be
   * confusable: swapping them changes WHICH directory is resolved and WHICH
   * is contained.
   */
  directory: string;
  /** Wrap the refusal in the call site's own typed error class. */
  wrapError: (message: string) => Error;
  /**
   * The app's outdir; `FileAssetResolveOptions.assetOutdir` in
   * `asset-manifest-loader.ts` carries the full note on why it differs from
   * the manifest's directory. Named rather than `{@link}`ed: a type imported
   * only for a doc link is erased by `tsc` but is an eslint `no-unused-vars`
   * ERROR, which `typecheck` does not see. A dropped bound narrows to the
   * manifest directory and refuses every Stage asset, which no refusal test
   * can see.
   */
  assetOutdir: string;
  /**
   * What THIS caller does with the directory next, completing "cdkd will ...".
   * The two arms of `buildDockerImage` have DIFFERENT sinks, and describing
   * one on the other understates: the `executable` arm sends nothing to
   * BuildKit — the directory becomes the working directory of a
   * manifest-supplied argv.
   */
  sink: string;
  /**
   * How to name the asset in the warning. Absent renders a bare subject; with
   * several image assets under `--no-staging` that gives N indistinguishable
   * lines.
   */
  assetId?: string;
}

/**
 * Shared `docker build` invocation used by both
 * `src/assets/docker-asset-publisher.ts` (publish to ECR) and
 * `src/local/ecs-task-runner.ts` (build a `ContainerImage.fromAsset` image for
 * `cdkd local run-task`). The `cdkd local invoke` container-Lambda build is
 * NOT a caller: `src/local/docker-image-builder.ts` became a thin shim over
 * `cdk-local`'s own builder, so this doc's long-standing claim that it uses
 * this helper was stale (corrected while sweeping issue
 * [#2623](https://github.com/go-to-k/cdkd/issues/2623)).
 *
 * **Every argv this module renders into a log line or an error text goes
 * through `redactDockerArgvValues` / `describeDockerFailure`**
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623),
 * [.claude/rules/docker-argv-redaction.md](../../.claude/rules/docker-argv-redaction.md)).
 * `--build-arg` carries a `DockerImageAsset`'s `buildArgs`, which is a common
 * — if discouraged — place for a build-time registry token, and `--verbose`
 * output is routinely pasted into issues and kept in CI archives.
 *
 * Parity with CDK CLI's `@aws-cdk/cdk-assets-lib`:
 *   - Streaming spawn via `runDockerStreaming` (no `execFile` `maxBuffer`
 *     ceiling — BuildKit progress on a `# syntax=docker/dockerfile:1`
 *     frontend pull + multi-stage build can run into the tens of MB and
 *     used to silently die at the 50 MB cap cdkd previously set).
 *   - Sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1` so the resulting image stays
 *     a single-arch image suitable for ECR pull (Docker Buildx otherwise
 *     attaches provenance attestation manifests that confuse the publish
 *     path).
 *   - Resolves the docker binary via `getDockerCmd()` so users can swap to
 *     `podman` / `finch` / `nerdctl` via the `CDK_DOCKER` env var.
 *   - Full BuildKit flag set: `--build-context`, `--secret`, `--ssh`,
 *     `--network`, `--cache-from`, `--cache-to`, `--no-cache`,
 *     `--platform`, `--output`. Each is emitted only when the
 *     corresponding asset-source field is set, so legacy builds without
 *     these features still work unchanged.
 *
 * Build-arg iteration order is preserved per `Object.entries(...)` — this
 * is load-bearing for layer-cache reproducibility across both callers.
 *
 * The caller-supplied `wrapError` lets each consumer wrap the failure
 * with its own typed error class (`AssetError` for the publisher,
 * `LocalInvokeBuildError` for local invoke).
 */

export interface BuildDockerImageOptions {
  /**
   * Local image tag (`--tag`) for `directory` mode. The caller chooses a
   * deterministic tag so subsequent runs hit Docker's layer cache (the
   * publisher uses `cdkd-asset-<hash>`; local-invoke uses
   * `cdkd-local-invoke-<hash>`). Ignored in `executable` mode — there
   * the executable returns its own tag on stdout.
   */
  tag?: string;
  /**
   * Optional `--platform` override. When set, takes precedence over
   * `asset.source.platform` from the manifest. Used by `cdkd local invoke`
   * to thread Lambda's `Architectures: [x86_64|arm64]` through to docker
   * build / run.
   */
  platform?: string;
  /**
   * Wrap the underlying docker / build-script failure in a typed error
   * specific to the call site.
   */
  wrapError: (stderr: string) => Error;
  /**
   * The app's outdir, where assets are staged. Defaults to `cdkOutDir`;
   * a Stage's Docker asset needs the app root as the containment base
   * (go-to-k/cdkd#3489).
   */
  assetOutdir?: string;
}

/**
 * Where a Docker asset's build context lives, refusing a RELATIVE
 * `source.directory` that resolves outside `assetOutdir` (issue
 * [#3489](https://github.com/go-to-k/cdkd/issues/3489)) and HONOURING an
 * ABSOLUTE one with a warning when it leaves that bound (issue
 * [#3532](https://github.com/go-to-k/cdkd/issues/3532); the reasoning is in
 * `resolveFileAssetSourcePath`, and the two must not diverge).
 *
 * The field is assembly-supplied and used BOTH as the executable's cwd and as
 * the `docker build` cwd, so an escaping value sends a directory from outside
 * `cdk.out` to BuildKit and bakes it into the image pushed to a repository the
 * same manifest names. Both sites used raw `${a}/${b}` concatenation, which
 * honours `..` exactly as `join` does; this is the one spelling they share.
 *
 * It throws through the CALLER's `wrapError` so each consumer keeps its own
 * typed error class, exactly as this module's other pre-docker refusals do.
 *
 * Twin of `resolveFileAssetSourcePath` and `resolveVerboseTemplatePath`.
 * Exported for unit testing.
 */
export function resolveDockerContextDirectory(opts: DockerContextResolveOptions): string {
  const { manifestDir, directory, wrapError, assetOutdir, sink, assetId } = opts;
  if (isAbsolute(directory)) {
    // HONOURED and warned about, never refused — the twin decision to
    // `resolveFileAssetSourcePath`'s, for the same three reasons, and this is
    // the field `cdk synth --no-staging` turns absolute alongside it
    // (`dockerImages[*].source.directory`). Previously the fold sent BuildKit
    // a path under the outdir that does not exist: `unable to prepare
    // context: path "<outdir>/private/tmp/.../docker-src" not found`
    // (go-to-k/cdkd#3532).
    const absolute = resolve(directory);
    const escape = absoluteAssemblyPathEscape(assetOutdir, absolute);
    if (escape !== undefined) {
      warnAbsoluteAssetPath({
        subject: dockerSubject(assetId),
        field: 'source.directory',
        absolute,
        escape,
        sink,
      });
    } else if (namesTheSameDirectory(assetOutdir, absolute)) {
      warnWholeAssemblyAsSource({
        subject: dockerSubject(assetId),
        field: 'source.directory',
        outdir: absolute,
        sink,
      });
    }
    return absolute;
  }
  // RESOLVE against the manifest's directory, CONTAIN within the app's
  // outdir — a Stage's Docker asset is staged into the app's outdir and its
  // `source.directory` is `../asset.<hash>` by design (go-to-k/cdkd#3489).
  const resolved = resolveAssemblyPath(manifestDir, directory, {
    containWithin: assetOutdir,
  });
  // NAMING THE BOUND ITSELF is not an escape; the twin's comment in
  // `resolveFileAssetSourcePath` carries the reasoning — including why it
  // WARNS rather than accepting silently, which is the sink.
  // The test is "IS the bound", not "lands inside it", and that asymmetry is
  // deliberate: with `<parent>/back -> cdk.out`, a value of `../back` is
  // accepted and warned while `../back/asset.abc` is still refused, though it
  // too lands inside the assembly. Fail-closed, and widening it would mean
  // re-deciding containment through links for every value, which is
  // `resolveAssemblyPath`'s job and not this arm's.
  if (!resolved.contained && namesTheSameDirectory(assetOutdir, resolved.path)) {
    warnWholeAssemblyAsSource({
      subject: dockerSubject(assetId),
      field: 'source.directory',
      outdir: resolved.path,
      sink,
    });
    return resolved.path;
  }
  if (!resolved.contained) {
    throw wrapError(
      `asset source.directory='${displaySafe(directory)}' which ` +
        `${renderAssemblyPathEscape(resolved, assetOutdir, 'build it')}`
    );
  }
  return resolved.path;
}

/** One spelling of the warning subject, so the two arms cannot drift. */
function dockerSubject(assetId: string | undefined): string {
  return assetId === undefined ? 'A Docker asset' : `Docker asset '${displaySafe(assetId)}'`;
}

/**
 * Build a Docker image from a CDK asset source. Returns the local image
 * tag the caller should use for `docker tag` / `docker push` (publisher)
 * or `docker run` (local-invoke).
 *
 * Two source modes (mirrors CDK CLI):
 *   - `executable`: run the user-supplied command, capture stdout, return
 *     it as the local tag. The script is responsible for building AND
 *     tagging; cdkd just reads the tag from stdout. Used for Bazel /
 *     custom build pipelines that produce images outside `docker build`.
 *   - `directory`: standard `docker build <dir>` with the full BuildKit
 *     flag set described above. Caller must pass `options.tag`.
 *
 * `executable` takes precedence when both fields are set (matches CDK CLI).
 */
export async function buildDockerImage(
  asset: { source: DockerImageAssetSource },
  cdkOutDir: string,
  options: BuildDockerImageOptions
): Promise<string> {
  const source = asset.source;
  const logger = getLogger().child('docker-build');

  // `?? cdkOutDir` is the ONE place `BuildDockerImageOptions.assetOutdir`'s
  // absence is answered, and it NARROWS rather than opening: a caller with no
  // `StackInfo.assetOutdir` gets the manifest's own directory as the bound, so
  // a hand-built stack record is judged more strictly, never less.
  //
  // The SINK differs per arm and the caller must say which, because the
  // `executable` arm is not a build context at all: there the directory
  // becomes the working directory of a manifest-supplied argv, which is a
  // larger risk than a BuildKit context and was previously described as the
  // smaller one.
  // Takes a BAG for the same reason the callee does: `(directory, sink)` were
  // two adjacent `string`s, so a swap rendered a prose clause as the directory
  // and the directory as the sink clause (go-to-k/cdkd#3544).
  const contextDirectory = (args: { directory: string; sink: string }): string =>
    resolveDockerContextDirectory({
      manifestDir: cdkOutDir,
      directory: args.directory,
      wrapError: options.wrapError,
      assetOutdir: options.assetOutdir ?? cdkOutDir,
      sink: args.sink,
      ...(options.tag !== undefined && { assetId: options.tag }),
    });

  // Executable source: run the script and read stdout for the tag.
  //
  // We do NOT inject `BUILDX_NO_DEFAULT_ATTESTATIONS=1` into the
  // executable's env. The script may not be docker (Bazel, custom shell,
  // etc.) and even when it IS docker, the attestation suppression is the
  // SCRIPT's responsibility — CDK CLI's `cdk-assets-lib` `buildExternalAsset`
  // takes the same stance for parity. If the script invokes `docker build`
  // internally and the resulting image carries an attestation manifest
  // that breaks ECR pull, the user's script should set the env itself.
  if (source.executable && source.executable.length > 0) {
    const [cmd, ...args] = source.executable;
    if (!cmd) {
      throw options.wrapError('asset source.executable[] is empty');
    }
    // BEFORE anything is spawned, and before the cwd is even resolved: this is
    // the line that tells a user `-a <dir>` runs code from the assembly
    // (go-to-k/cdkd#3497). Warn, never refuse — the decision on that issue.
    warnManifestExecutable(source.executable);
    // The executable runs from the asset directory when one is provided
    // (mirrors CDK CLI's `cwd: assetPath` in `buildExternalAsset`). When
    // `directory` is unset, the executable runs from `cdkOutDir`.
    const cwd = source.directory
      ? contextDirectory({
          directory: source.directory,
          sink: "run this asset's source.executable with that directory as its working directory",
        })
      : cdkOutDir;

    // The user's build script is an ARBITRARY command line, and a script that
    // wraps `docker build` carries the very `--build-arg` pairs this module
    // masks on its own path. Redacted for display; `spawnStreaming` still gets
    // the raw `args`.
    const shownExecutable = redactDockerArgvValues(source.executable).join(' ');
    logger.debug(`Building Docker image via executable: ${shownExecutable} (cwd=${cwd})`);

    let result;
    try {
      result = await spawnStreaming(cmd, args, { cwd });
    } catch (err) {
      // `args`, NOT `source.executable`: the composer's spawn-refusal repair
      // resolves Node's `args[N]` index against the array handed to `spawn`,
      // which excludes the command itself. Passing the executable whole would
      // resolve every index one element early — the "pass the array you
      // actually spawned" rule in .claude/rules/docker-argv-redaction.md.
      throw options.wrapError(describeDockerFailure(err, args));
    }
    const tag = result.stdout.trim();
    if (!tag) {
      throw options.wrapError(
        `docker build executable produced no output (expected the local image tag on stdout): ${shownExecutable}`
      );
    }
    return tag;
  }

  // Directory source: standard docker build.
  if (!source.directory) {
    // FIELD NAMES only. This used to be `JSON.stringify(source)`, which is a
    // strictly WIDER disclosure than the `--build-arg` log line issue #2623
    // was filed about: it dumps every `dockerBuildArgs` VALUE plus
    // `dockerBuildSecrets`, into a thrown error rather than behind
    // `--verbose`. The diagnostic here is "which fields WERE set", since the
    // failure is that neither of two required ones is — and a key list answers
    // exactly that.
    //
    // "Present" means "carries a value", not "is a key": `{ directory: '' }`
    // takes this branch (the guard is `!source.directory`), so listing
    // `directory` would contradict the sentence it is appended to. Each name
    // goes through `displaySafe` because it is rendered into a terminal — the
    // keys are schema names today, but the escaping `JSON.stringify` used to
    // provide left with it.
    const carriesAValue = (v: unknown): boolean => {
      if (v === undefined || v === null || v === '') return false;
      // An empty ARRAY and an empty OBJECT are the same statement, and the
      // first cut answered them differently: `dockerBuildArgs: {}` was listed
      // as present while `executable: []` was not, from one predicate whose
      // name says "carries a value".
      if (typeof v !== 'object') return true;
      return (Array.isArray(v) ? v.length : Object.keys(v).length) > 0;
    };
    const present =
      Object.keys(source)
        .filter((k) => carriesAValue((source as Record<string, unknown>)[k]))
        // `asciiOnly` is the documented mode for a KNOWN charset, and these
        // are manifest schema identifiers. The denylist form leaves the
        // invisible formatters (U+200B-200D / U+FEFF) and the bidi MARKS
        // (U+200E / U+200F) in a terminal-rendered thrown error; the
        // allowlist has no such residual.
        .map((k) => displaySafe(k, { asciiOnly: true }))
        .filter((k) => k !== '')
        .sort()
        .join(', ') || '<no fields set>';
    throw options.wrapError(
      `DockerImageAssetSource must set either 'directory' or 'executable' (fields present: ${present})`
    );
  }
  if (!options.tag) {
    throw options.wrapError('buildDockerImage(directory mode) requires options.tag');
  }

  const buildArgs = buildDockerBuildCommand(source, options.tag, options.platform);
  // Use `.` as the context and set `cwd` to the asset directory. Mirrors
  // CDK CLI's `cdk-assets-lib` Docker.build — load-bearing because
  // BuildKit flags like `--secret id=X,src=relative.txt` /
  // `--build-context name=relative/path` resolve relative paths against
  // the build's cwd, NOT against the trailing context positional. Passing
  // an absolute context dir with no cwd silently breaks those flags.
  const contextDir = contextDirectory({
    directory: source.directory,
    sink:
      'send that directory to BuildKit as the build context and bake it into the ' +
      'image pushed to the repository this manifest names',
  });
  buildArgs.push('.');

  // Judge the BuildKit passthroughs against the SAME pair the context
  // directory was judged against, and do it HERE rather than inside
  // `buildDockerBuildCommand`: that function is a pure argv builder with no
  // outdir to compare to, and a relative `--secret src=` / `--build-context`
  // resolves against the build's cwd, which is `contextDir` and is only known
  // now (go-to-k/cdkd#3497). Above the spawn, so the line precedes the read or
  // the write it describes.
  warnEscapingBuildKitPaths(source, contextDir, options.assetOutdir ?? cdkOutDir);

  // The reported site of issue #2623: this rendered every `--build-arg` VALUE
  // into `cdkd deploy --verbose` output.
  logger.debug(
    `${getDockerCmd()} ${redactDockerArgvValues(buildArgs).join(' ')} (cwd=${displaySafe(contextDir)})`
  );

  try {
    await runDockerStreaming(buildArgs, {
      cwd: contextDir,
      // BUILDX_NO_DEFAULT_ATTESTATIONS=1 matches `cdk-assets-lib` — without
      // this, BuildKit/Buildx attaches provenance attestation manifests
      // that ECR's single-arch pull path rejects.
      env: { BUILDX_NO_DEFAULT_ATTESTATIONS: '1' },
    });
  } catch (err) {
    // `runDockerStreaming` spawns with exactly `buildArgs`, so the index in a
    // Node spawn refusal (`The argument 'args[N]' …`) resolves against it —
    // the shape that would otherwise print a whole `--build-arg` pair, NUL
    // escaping and all, into a user-visible error.
    throw options.wrapError(describeDockerFailure(err, buildArgs));
  }

  return options.tag;
}

/**
 * Construct the `docker build` argv (without the trailing context directory).
 *
 * Exported for unit-test inspection — keeps the flag-ordering assertions
 * independent of the spawn machinery.
 */
export function buildDockerBuildCommand(
  source: DockerImageAssetSource,
  tag: string,
  platformOverride?: string
): string[] {
  // `--tag` (not `-t`) and `--file` (not `-f`) are the long-form names CDK
  // CLI's `cdk-assets-lib` emits. docker treats short / long aliases
  // identically, so this is cosmetic — but matching CDK CLI verbatim makes
  // a side-by-side comparison of the rendered argv (in --verbose logs)
  // grep-clean and removes one source of "why is this slightly different?"
  // confusion.
  const args: string[] = ['build', '--tag', tag];

  // Build args (Object.entries order preserved for layer-cache stability).
  if (source.dockerBuildArgs) {
    for (const [k, v] of Object.entries(source.dockerBuildArgs)) {
      args.push('--build-arg', `${k}=${v}`);
    }
  }

  // Build contexts (BuildKit 1.4+).
  if (source.dockerBuildContexts) {
    for (const [k, v] of Object.entries(source.dockerBuildContexts)) {
      args.push('--build-context', `${k}=${v}`);
    }
  }

  // Build secrets (BuildKit).
  if (source.dockerBuildSecrets) {
    for (const [k, v] of Object.entries(source.dockerBuildSecrets)) {
      args.push('--secret', `id=${k},${v}`);
    }
  }

  // SSH agent (BuildKit).
  if (source.dockerBuildSsh) {
    args.push('--ssh', source.dockerBuildSsh);
  }

  if (source.dockerBuildTarget) {
    args.push('--target', source.dockerBuildTarget);
  }

  if (source.dockerFile) {
    args.push('--file', source.dockerFile);
  }

  if (source.networkMode) {
    args.push('--network', source.networkMode);
  }

  // Platform: caller-provided override wins; otherwise source.platform from manifest.
  const platform = platformOverride ?? source.platform;
  if (platform) {
    args.push('--platform', platform);
  }

  // Outputs: CDK uses `--output=<value>` (single arg) which is what BuildKit
  // expects; the older `--output <value>` two-arg form works too but we
  // match CDK exactly for parity.
  if (source.dockerOutputs) {
    for (const output of source.dockerOutputs) {
      args.push(`--output=${output}`);
    }
  }

  if (source.cacheFrom) {
    for (const c of source.cacheFrom) {
      args.push('--cache-from', cacheOptionToFlag(c));
    }
  }
  if (source.cacheTo) {
    args.push('--cache-to', cacheOptionToFlag(source.cacheTo));
  }
  if (source.cacheDisabled) {
    args.push('--no-cache');
  }

  return args;
}
