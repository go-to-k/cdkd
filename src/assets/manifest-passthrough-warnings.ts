import type { DockerImageAssetSource } from '../types/assets.js';
import { assemblyPathEscape, renderAssemblyPathEscape } from '../utils/assembly-path.js';
import { displaySafe } from '../utils/display-safe.js';
import { redactDockerArgvValues } from '../utils/docker-cmd.js';
import { getLogger } from '../utils/logger.js';

/**
 * The warnings for everything in an asset manifest that cdkd forwards to
 * Docker or to AWS **as the manifest writes it** (issue
 * [#3497](https://github.com/go-to-k/cdkd/issues/3497)).
 *
 * The maintainer decision on that issue, applied here verbatim: **warn and
 * document; do not refuse and do not add an opt-in flag.** The reasoning,
 * because it is what stops someone later "hardening" this into a refusal:
 *
 * - `cdkd deploy -a <dir>` keeps CDK-CLI parity for every value here. cdkd's
 *   claim is speed, not "safer than the CDK CLI", and diverging buys a
 *   works-with-cdk / fails-with-cdkd incompatibility for a threat the upstream
 *   tool accepts.
 * - The attack presupposes someone who can rewrite the manifest — who can
 *   equally rewrite the Dockerfile, the Lambda asset and the template, so the
 *   account is already theirs. Pointing `-a` at an assembly you did not
 *   produce is the same decision as running someone else's build output, and
 *   it is the user's to make.
 * - A refusal would surface as "CI suddenly fails" on exactly the
 *   split-synth/deploy pipelines that are the common shape, and a default-deny
 *   plus opt-in flag reduces the population holding the capability without
 *   protecting the population that uses it — they set the flag permanently.
 *
 * **What IS cdkd's to fix is the silence.** `source.executable` breaks the
 * reasonable expectation that `-a <dir>` runs no code from the assembly, and
 * the BuildKit passthroughs read and write host paths the CloudFormation
 * template never shows. So each gets a line, at default verbosity, naming the
 * value — which returns the judgement to the user, where the decision puts it.
 */

/** Where a warning says the value came from, for a reader scanning a build log. */
type PassthroughField =
  | 'dockerFile'
  | 'dockerBuildContexts'
  | 'dockerBuildSecrets'
  | 'dockerBuildSsh'
  | 'cacheFrom'
  | 'cacheTo'
  | 'dockerOutputs';

interface HostPathRef {
  field: PassthroughField;
  /**
   * The key or index that located it, so a multi-valued field is navigable.
   * Stored WITHOUT brackets; the renderer adds them.
   */
  where: string;
  path: string;
  /**
   * Whether BuildKit WRITES there. Decided by the `dest=` KEY, not by the
   * field: `cacheFrom` can carry a `dest=` and `cacheTo` a `src=`, so keying
   * on the field name labelled one of each backwards.
   */
  write: boolean;
}

/**
 * Every candidate host path in a buildx option value.
 *
 * **Uniform, and over-inclusive on purpose.** Three review rounds found this
 * parser short in three different ways — `dest=` only (missing the
 * `--output=<path>` shorthand), case-sensitive `src` (missing `source=` and
 * `SRC=`), and a per-entry `=` requirement (missing every key after the first
 * in `--ssh k=./a.key,/home/victim/.ssh/id_rsa`). Each fix was a new special
 * case, and the next round found the next gap. So the rule is now one rule:
 * **a part with a key yields its value, a part without one yields itself**,
 * for every field. An over-inclusive candidate costs at most a warning about
 * a string that was never a path — and a value that is not a path resolves
 * inside the build context and is dropped before anything is printed.
 *
 * `write` is true only for an explicit `dest=`, or when the caller says the
 * whole field is a write target (`dockerOutputs`, whose bare-path form IS a
 * destination). It is NOT inferred from the field name: `cacheFrom` can carry
 * a `dest=` and `cacheTo` a `src=`.
 *
 * KNOWN INCOMPLETE, recorded rather than built: buildx parses these as CSV, so
 * a quoted value containing a comma (`dest="/tmp/a,b"`) is split wrongly here
 * and its path is missed. A miss costs a warning, never a refusal, which is
 * what keeps a CSV parser out of this module.
 *
 * Tolerant by construction: an unparseable value yields nothing rather than
 * throwing. This module only ever ADDS a warning and must never be why a
 * legitimate build fails.
 */
function candidateHostPaths(
  value: string,
  opts: { bareIsWrite: boolean }
): { path: string; write: boolean }[] {
  const out: { path: string; write: boolean }[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      // No key: the part IS the value. `--output=/tmp/out` and the second and
      // later keys of `--ssh id=a,b,c` both take this branch.
      const bare = part.trim();
      if (bare.length > 0) out.push({ path: bare, write: opts.bareIsWrite });
      continue;
    }
    // buildx lower-cases keys and accepts `source` as an alias for `src`.
    const key = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (v.length === 0) continue;
    // `type=local` / `id=mysecret` / `mode=max` name no path. Everything else
    // with a key is a candidate; the containment check filters the rest.
    if (key === 'type' || key === 'id' || key === 'mode' || key === 'name') continue;
    out.push({ path: v, write: key === 'dest' || opts.bareIsWrite });
  }
  return out;
}

/** Every host path this source hands to BuildKit, with where it came from. */
function hostPathsOf(source: DockerImageAssetSource): HostPathRef[] {
  const refs: HostPathRef[] = [];

  if (source.dockerFile) {
    refs.push({ field: 'dockerFile', where: 'dockerFile', path: source.dockerFile, write: false });
  }
  for (const [k, v] of Object.entries(source.dockerBuildContexts ?? {})) {
    // No remote-reference filter here, and a probe is why. A first revision
    // skipped `docker-image://` / `https://` / `git@` values as "not host
    // paths"; deleting that guard reddened nothing, because each of those
    // THREE is a RELATIVE string that folds to `<context>/docker-image:/…`,
    // inside the assembly and silent already. A guard that cannot change an
    // outcome is a branch nobody can test.
    //
    // The claim is about those three and not about every scheme:
    // `oci-layout://<path>` carries a real host path behind a scheme, and the
    // extra `oci-layout:` component makes the fold one level deeper than the
    // path really is — so a value exactly one level outside reads as inside.
    // It is buildx-experimental (`BUILDX_EXPERIMENTAL=1`), and the miss costs
    // a warning rather than a refusal, so it is recorded here rather than
    // special-cased back in.
    refs.push({ field: 'dockerBuildContexts', where: k, path: v, write: false });
  }
  // `--ssh <id>=<socket|key>[,<key>...]` — the keys AFTER the first carry no
  // `=`, which is how a first revision dropped them. `default` alone is the
  // agent socket from the environment, not a manifest-chosen path, and is
  // skipped for that reason rather than by accident.
  for (const { path: p } of candidateHostPaths(source.dockerBuildSsh ?? '', {
    bareIsWrite: false,
  })) {
    if (p === 'default') continue;
    refs.push({ field: 'dockerBuildSsh', where: 'dockerBuildSsh', path: p, write: false });
  }
  for (const [k, v] of Object.entries(source.dockerBuildSecrets ?? {})) {
    // `bareIsWrite: false` — the bare-path shorthand is `--output`'s, not
    // this field's, and labelling a secret READ as a WRITE alarms in the
    // wrong direction (buildx rejects the spelling outright anyway).
    for (const { path: p, write } of candidateHostPaths(v, { bareIsWrite: false })) {
      refs.push({ field: 'dockerBuildSecrets', where: k, path: p, write });
    }
  }
  (source.cacheFrom ?? []).forEach((c, i) => {
    for (const [key, v] of Object.entries(c.params ?? {})) {
      const k = key.toLowerCase();
      if (k === 'src' || k === 'source' || k === 'dest') {
        refs.push({ field: 'cacheFrom', where: String(i), path: v, write: k === 'dest' });
      }
    }
  });
  for (const [key, v] of Object.entries(source.cacheTo?.params ?? {})) {
    const k = key.toLowerCase();
    if (k === 'src' || k === 'source' || k === 'dest') {
      refs.push({ field: 'cacheTo', where: 'cacheTo', path: v, write: k === 'dest' });
    }
  }
  (source.dockerOutputs ?? []).forEach((o, i) => {
    for (const { path: p, write } of candidateHostPaths(o, { bareIsWrite: true })) {
      refs.push({ field: 'dockerOutputs', where: String(i), path: p, write });
    }
  });

  return refs;
}

/**
 * Warn for each BuildKit passthrough whose host path leaves the assembly.
 *
 * `base` is the build context directory (what a relative value resolves
 * against); `bound` is the app's outdir.
 */
export function warnEscapingBuildKitPaths(
  source: DockerImageAssetSource,
  base: string,
  bound: string
): void {
  const logger = getLogger().child('assets');
  // **The context may only NARROW the question, never widen it.** The read
  // exemption below treats `base` as a second bound, and
  // `resolveDockerContextDirectory` HONOURS an absolute `source.directory` —
  // so a manifest writing `source.directory: "/"` would make every path
  // "inside the context" and silence the whole set from one field.
  // `resolveAssemblyPath`'s own `containWithin` note states the rule this
  // rediscovered: an ANCESTOR of the real bound WIDENS, and `'/'` admits
  // `/etc/passwd`. When `bound` lies inside `base`, the context is an
  // ancestor and the exemption is switched off entirely.
  const contextNarrows = assemblyPathEscape(base, base, bound) !== undefined;
  for (const ref of hostPathsOf(source)) {
    // INSIDE THE BUILD CONTEXT is not worth a line FOR A READ: BuildKit was
    // handed that directory already, and under `cdk synth --no-staging` the
    // context itself sits outside the outdir — which go-to-k/cdkd#3532's own
    // warning reports once — so judging reads against the outdir alone
    // repeated it per passthrough for values that never leave the directory.
    //
    // **A WRITE gets no such exemption, and the distinction is the whole
    // point.** "We already gave BuildKit that directory to READ" does not
    // license creating files in it: under `--no-staging` the context is the
    // user's own source tree, and a `dockerOutputs` dest inside it would
    // otherwise drop files there in silence.
    if (!ref.write && contextNarrows && assemblyPathEscape(base, base, ref.path) === undefined) {
      continue;
    }
    const escape = assemblyPathEscape(base, bound, ref.path);
    if (escape === undefined) continue;
    const verb = ref.write ? 'WRITE to' : 'read';
    // **`provenanceOverride`, NEVER the `action` positional.** `action` fills
    // `Refusing to ${action}.`, and a first revision passed the verb there —
    // so the warning in the one change whose point is that it does NOT refuse
    // read `Refusing to WRITE to it silently. cdkd forwards it ... anyway`,
    // and asserted the default provenance sentence ("hand-modified or
    // generated by a non-CDK toolchain") about `cacheTo` and `dockerOutputs`
    // values a real CDK synth emits.
    //
    // cdkd-raw-beside-safe: `renderAssemblyPathEscape` is a safe RENDERER — it
    // `displaySafe`s every path it interpolates and the rest is its own
    // literal text. `ref.field` and `verb` are this module's own literals.
    logger.warn(
      `Docker asset ${ref.field}` +
        (ref.where === ref.field ? '' : `['${displaySafe(ref.where)}']`) +
        ` names a host path ` +
        `outside the assembly, which ` +
        `${renderAssemblyPathEscape(
          escape,
          bound,
          'load',
          `cdkd will ${verb} it during the image build, matching the CDK CLI — a ` +
            `pre-synthesized assembly is trusted input. If you did not produce this ` +
            `assembly, that is a host path it chose and the CloudFormation template ` +
            `does not show.`
        )}`
    );
  }
}

/**
 * Warn that a manifest-chosen command line is about to run on the host.
 *
 * **This is the one the decision singles out**, and it is not a containment
 * question: `source.executable` is an arbitrary argv cdkd spawns, so no path
 * check applies and no value of it is "safe". It breaks the reasonable
 * expectation that `-a <dir>` runs no code from the assembly, and nothing said
 * so before. Rendered through `redactDockerArgvValues`, because a build script
 * wrapping `docker build` carries the very `--build-arg` pairs the rest of
 * this layer masks.
 */
export function warnManifestExecutable(executable: readonly string[]): void {
  const [cmd, ...rest] = executable;
  const logger = getLogger().child('assets');
  // **The COMMAND, not the whole argv.** A first revision rendered every
  // argument here through `redactDockerArgvValues` — but that masker covers
  // the `docker build` flag shapes (`--build-arg`, `-e`, `--cache-*`) and
  // nothing else, so a legitimate build script's own `--token ghp_…` or
  // `--password=…` would have been promoted from `--verbose`-only to a line
  // in every CI log, on every deploy. That is a NEW leak introduced by a
  // warning about leaks. The decision's words are "naming the command", which
  // `executable[0]` satisfies; the full argv stays at debug, where it was.
  logger.debug(`source.executable argv: ${redactDockerArgvValues([...executable]).join(' ')}`);
  logger.warn(
    `Docker asset source.executable runs a command this asset manifest chose, on ` +
      `this machine: '${displaySafe(cmd ?? '')}'` +
      (rest.length > 0 ? ` (with ${rest.length} argument(s); --verbose shows them)` : '') +
      `. cdkd runs it, matching the CDK CLI — a pre-synthesized assembly is trusted ` +
      `input. Note that this means deploying from a pre-synthesized assembly DOES ` +
      `execute code from it, which the CloudFormation template does not show.`
  );
}

/**
 * One set per KIND rather than one set of composite keys. A `${kind}` + NUL +
 * `${name}` key would be a multi-part NUL-joined string, which this repo
 * fences as a record-key shape — and it is not one: it never leaves the
 * process, is never persisted, and a collision would suppress one duplicate
 * warning line. Two sets carry the same information with nothing to classify.
 */
const warnedDestinations: Record<'bucket' | 'repository', Set<string>> = {
  bucket: new Set(),
  repository: new Set(),
};

/** Test seam; a process deploys one app, so the sets are per invocation. */
export function resetDestinationWarnings(): void {
  warnedDestinations.bucket.clear();
  warnedDestinations.repository.clear();
}

/**
 * Warn that an asset destination is not bootstrap-shaped.
 *
 * `redirectFileAsset` rewrites a destination only when it matches a known
 * bootstrap shape, so anything else survives verbatim and cdkd uploads there
 * with the caller's credentials. A CUSTOM BOOTSTRAP IS LEGITIMATE — which is
 * why this warns and never refuses — but the name is worth printing, because
 * it is the one field a reader can recognise as not theirs.
 *
 * **Shape only, and an adversary can imitate a shape.**
 * `isDefaultBootstrapBucketName` accepts any qualifier, so
 * `cdk-<anything>-assets-<victim-account>-<region>` reads as recognized even
 * when the bucket lives in the attacker's account (S3 names are global and a
 * bucket policy can admit the victim's principal). This warning narrows what
 * a careless manifest gets away with; it is not an ownership check, and
 * nothing here should be read as one.
 *
 * `recognized` is whether the name is default-bootstrap-shaped for this
 * (account, region) or is cdkd's own asset storage. Judged on the FLATTENED
 * name and on shape, not on whether the redirect table rewrote it: in legacy
 * mode nothing is rewritten and every ordinary deploy would otherwise warn,
 * which is the cry-wolf failure this layer already learned once.
 */
export function warnUnrecognizedAssetDestination(opts: {
  kind: 'bucket' | 'repository';
  name: string;
  recognized: boolean;
}): void {
  if (opts.recognized) return;
  // ONCE per (kind, name). This fires per asset x per destination at graph
  // construction, so a legitimate custom bootstrap or an AppStagingSynthesizer
  // bucket — both deliberately outside the recognized shapes — printed one
  // identical line per asset, thirty of them for a thirty-asset stack, every
  // deploy. That is the cry-wolf failure this layer already shipped once.
  const seen = warnedDestinations[opts.kind];
  if (seen.has(opts.name)) return;
  seen.add(opts.name);
  getLogger()
    .child('assets')
    .warn(
      `Asset destination ${opts.kind} '${displaySafe(opts.name)}' is not a ` +
        `CDK-bootstrap or cdkd-managed name, so cdkd uploads there exactly as this ` +
        `asset manifest wrote it, with your credentials. That is what a custom ` +
        `bootstrap looks like and is expected for one; if you did not configure ` +
        `it, the manifest chose where your assets go.`
    );
}
