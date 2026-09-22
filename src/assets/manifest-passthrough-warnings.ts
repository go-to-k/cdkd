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
  | 'cacheFrom'
  | 'cacheTo'
  | 'dockerOutputs';

interface HostPathRef {
  field: PassthroughField;
  /** The key or index that located it, so a multi-valued field is navigable. */
  where: string;
  path: string;
}

/**
 * Pull `src=` / `dest=` out of a comma-separated BuildKit option string
 * (`type=local,dest=/tmp/out`, `id=k,src=/etc/passwd`).
 *
 * Deliberately tolerant: an unparseable option yields nothing rather than
 * throwing, because this module only ever adds a warning and must never be
 * the reason a legitimate build fails.
 */
function hostPathsInOptionString(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if ((key === 'src' || key === 'dest') && v.length > 0) out.push(v);
  }
  return out;
}

/** Every host path this source hands to BuildKit, with where it came from. */
function hostPathsOf(source: DockerImageAssetSource): HostPathRef[] {
  const refs: HostPathRef[] = [];

  if (source.dockerFile) {
    refs.push({ field: 'dockerFile', where: 'dockerFile', path: source.dockerFile });
  }
  for (const [k, v] of Object.entries(source.dockerBuildContexts ?? {})) {
    // No remote-reference filter here, and a probe is why. A first revision
    // skipped `docker-image://` / `https://` / `git@` values as "not host
    // paths"; deleting that guard reddened nothing, because a remote
    // reference is a RELATIVE string and folds to `<context>/docker-image:/…`,
    // which is inside the assembly and silent already. A guard that cannot
    // change an outcome is a branch nobody can test.
    refs.push({ field: 'dockerBuildContexts', where: k, path: v });
  }
  for (const [k, v] of Object.entries(source.dockerBuildSecrets ?? {})) {
    for (const p of hostPathsInOptionString(v)) {
      refs.push({ field: 'dockerBuildSecrets', where: k, path: p });
    }
  }
  (source.cacheFrom ?? []).forEach((c, i) => {
    for (const [key, v] of Object.entries(c.params ?? {})) {
      if (key === 'src' || key === 'dest') {
        refs.push({ field: 'cacheFrom', where: `[${i}]`, path: v });
      }
    }
  });
  for (const [key, v] of Object.entries(source.cacheTo?.params ?? {})) {
    if (key === 'src' || key === 'dest') {
      refs.push({ field: 'cacheTo', where: 'cacheTo', path: v });
    }
  }
  (source.dockerOutputs ?? []).forEach((o, i) => {
    for (const p of hostPathsInOptionString(o)) {
      refs.push({ field: 'dockerOutputs', where: `[${i}]`, path: p });
    }
  });

  return refs;
}

/** `dest=` targets are WRITES; the rest are reads. Worth saying which. */
const WRITE_FIELDS = new Set<PassthroughField>(['dockerOutputs', 'cacheTo']);

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
    const escape = assemblyPathEscape(base, bound, ref.path);
    if (escape === undefined) continue;
    const verb = WRITE_FIELDS.has(ref.field) ? 'WRITE to' : 'read';
    // cdkd-raw-beside-safe: `renderAssemblyPathEscape` is a safe RENDERER — it
    // `displaySafe`s every path it interpolates and the rest is its own
    // literal text. `ref.field` and `verb` are this module's own literals.
    logger.warn(
      `Docker asset ${ref.field}${ref.where === ref.field ? '' : `['${displaySafe(ref.where)}']`} ` +
        `names a host path outside the assembly: '${displaySafe(ref.path)}', which ` +
        `${renderAssemblyPathEscape(escape, bound, `${verb} it silently`)} ` +
        `cdkd forwards it to the image build anyway, matching the CDK CLI — a ` +
        `pre-synthesized assembly is trusted input. If you did not produce this ` +
        `assembly, that is a host path it chose and the CloudFormation template ` +
        `does not show.`
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
  getLogger()
    .child('assets')
    .warn(
      `Docker asset source.executable runs a command line this asset manifest ` +
        `chose, on this machine: '${displaySafe(redactDockerArgvValues([...executable]).join(' '))}'. ` +
        `cdkd runs it, matching the CDK CLI — a pre-synthesized assembly is trusted ` +
        `input. Note that this means 'cdkd deploy -a <dir>' DOES execute code from ` +
        `the assembly, which the CloudFormation template does not show.`
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
