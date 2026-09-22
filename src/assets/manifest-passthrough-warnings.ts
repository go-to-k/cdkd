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
 * Pull `src=` / `dest=` out of a comma-separated BuildKit option string
 * (`type=local,dest=/tmp/out`, `id=k,src=/etc/passwd`).
 *
 * Deliberately tolerant: an unparseable option yields nothing rather than
 * throwing, because this module only ever adds a warning and must never be
 * the reason a legitimate build fails.
 *
 * KNOWN INCOMPLETE, and better here than silently: buildx parses these as CSV,
 * so a quoted value containing a comma (`dest="/tmp/a,b"`) is split wrongly by
 * this naive scan and its path is missed. Closing that means a CSV parser, and
 * a miss costs a warning rather than a refusal, so it is recorded rather than
 * built.
 */
function hostPathsInOptionString(value: string): { path: string; write: boolean }[] {
  const out: { path: string; write: boolean }[] = [];
  const parts = value.split(',');
  // BARE-PATH SHORTHAND: `--output=/tmp/out` is valid and means
  // `type=local,dest=/tmp/out`. Keying only on `dest=` let that write through
  // unwarned, which is the worst direction for this field to be wrong in.
  if (parts.length === 1 && !parts[0]!.includes('=') && parts[0]!.trim().length > 0) {
    return [{ path: parts[0]!.trim(), write: true }];
  }
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    // buildx lower-cases option keys and accepts `source` as an alias for
    // `src`, so an exact case-sensitive match on `src` let
    // `--secret id=x,source=/etc/passwd` and `SRC=` through unwarned.
    const key = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if ((key === 'src' || key === 'source' || key === 'dest') && v.length > 0) {
      out.push({ path: v, write: key === 'dest' });
    }
  }
  return out;
}

/**
 * `--ssh` takes `default` (the agent socket from the environment, not a
 * manifest-chosen path) or `<id>=<path to a private key>`. Only the second
 * names a host file, and it is the more alarming one — a manifest that writes
 * `k=~/.ssh/id_rsa` has BuildKit read that key.
 */
function sshKeyPaths(value: string): string[] {
  const out: string[] = [];
  for (const entry of value.split(',')) {
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const v = entry.slice(eq + 1).trim();
    if (v.length > 0) out.push(v);
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
    // paths"; deleting that guard reddened nothing, because a remote
    // reference is a RELATIVE string and folds to `<context>/docker-image:/…`,
    // which is inside the assembly and silent already. A guard that cannot
    // change an outcome is a branch nobody can test.
    refs.push({ field: 'dockerBuildContexts', where: k, path: v, write: false });
  }
  for (const p of sshKeyPaths(source.dockerBuildSsh ?? '')) {
    refs.push({ field: 'dockerBuildSsh', where: 'dockerBuildSsh', path: p, write: false });
  }
  for (const [k, v] of Object.entries(source.dockerBuildSecrets ?? {})) {
    for (const { path: p, write } of hostPathsInOptionString(v)) {
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
    for (const { path: p, write } of hostPathsInOptionString(o)) {
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
  for (const ref of hostPathsOf(source)) {
    // INSIDE THE BUILD CONTEXT is never worth a line, even when the context
    // itself sits outside the outdir. Under `cdk synth --no-staging` the
    // context IS outside — that is what go-to-k/cdkd#3532's own warning
    // reports, once — and judging these against the outdir alone then
    // repeated it per passthrough for values that never leave the directory
    // BuildKit was already given.
    if (assemblyPathEscape(base, base, ref.path) === undefined) continue;
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
      `Docker asset ${ref.field}['${displaySafe(ref.where)}'] names a host path ` +
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
