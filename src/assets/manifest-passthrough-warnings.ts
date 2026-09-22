import { resolve } from 'path';
import type { DockerImageAssetSource } from '../types/assets.js';
import { cacheOptionToFlag } from './docker-cache-option.js';
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
 * KNOWN INCOMPLETE, recorded rather than built, and this list is the whole of
 * what is left "safe by argument" in this module — four of five review rounds
 * broke something that lived in that category, so it is written down instead:
 *
 * - buildx parses these as CSV, so a quoted value containing a comma
 *   (`dest="/tmp/a,b"`) is split wrongly here and its path is missed.
 * - the keyed rule takes `src` / `source` / `dest`, the documented spellings
 *   that make BuildKit open a file. An UNDOCUMENTED alias, or a NEW key in a
 *   future buildx, would slip past it, where the earlier take-every-key rule
 *   would have caught it — that rule was given up because it cost live false
 *   positives on `ref=` / `scope=` / `env=` at an ordinary project layout.
 *   What was audited, per backend: `--secret` opens a file only through
 *   `src` / `source` (`env` is a variable NAME); every `--output` exporter
 *   only through `dest` (`name`, `push`, `compression*`, `annotation.*`,
 *   `store`, the docker exporter's `context` are not paths); `--cache-to` and
 *   `--cache-from` only under `type=local` (`registry`, `s3`, `azblob`, `gha`
 *   reach the network or take inline values). `src/utils/docker-cmd.ts`'s
 *   `ARGV_PARAM_LIST_LOCATOR_PARAMS` enumerates the same backends for the
 *   redaction side and agrees; **update both or neither.**
 *
 * Both misses cost a WARNING, never a refusal, which is the whole reason
 * neither is worth a CSV parser or a wider net.
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
    // **A KEYED part is a candidate only under `src` / `source` / `dest`** —
    // the keys that make BuildKit touch a file. An earlier revision took every
    // key not on a small skip list, reasoning that a non-path folds inside the
    // build context and is dropped; that holds only while the context
    // exemption is ON, and it is off for a write and off whenever the context
    // CONTAINS the outdir — the ordinary `directory: '.'` shape. There it
    // announced a registry ref, a GHA cache scope and an env-var NAME as host
    // paths cdkd would read (`type=registry,ref=…` → `<root>/ghcr.io/…`).
    //
    // This gives up nothing the round that introduced it bought: all three CSV
    // injections closed then smuggle `src=` or `dest=`, because that is what
    // makes BuildKit open a file. What closed them was judging the RENDERED
    // string rather than the struct, which is untouched here.
    if (key !== 'src' && key !== 'source' && key !== 'dest') continue;
    // `bareIsWrite` governs the BARE branch only. Letting it decide here too
    // made every keyed parameter of `--output` a write, so
    // `dockerOutputs: ['type=image,push=true']` warned "cdkd will WRITE to"
    // `<context>/true` — and a write is exempt from the context skip, so the
    // false line survived to the user.
    out.push({ path: v, write: key === 'dest' });
  }
  return out;
}

/** Every host path this source hands to BuildKit, with where it came from. */
function hostPathsOf(source: DockerImageAssetSource): HostPathRef[] {
  const refs: HostPathRef[] = [];

  if (source.dockerFile) {
    refs.push({ field: 'dockerFile', where: 'dockerFile', path: source.dockerFile, write: false });
  }
  // The RENDERED element, like every other field — `args.push('--build-context',
  // `${k}=${v}`)`, and buildx takes everything after the FIRST `=` as the
  // value, so a key containing `=` makes BuildKit's value a strict superset of
  // `v`. No reachable payload exists (anything hidden that way must itself
  // contain `=`, and a real target like `.ssh/id_rsa` does not), but four
  // rounds running it was the part left safe BY ARGUMENT that broke next, so
  // there is no argument left here to be wrong about. NOT through
  // `candidateHostPaths`: this value is not CSV, and splitting it on commas
  // would break a legitimate path containing one — which also means this arm
  // must carry that function's empty-value guard itself.
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
    const rendered = `${k}=${v}`;
    const contextPath = rendered.slice(rendered.indexOf('=') + 1).trim();
    // An empty value renders `a=`, whose "path" is the context directory
    // itself — a true sentence pointing at the wrong thing. buildx rejects
    // the spelling anyway.
    if (contextPath.length === 0) continue;
    refs.push({
      field: 'dockerBuildContexts',
      where: k,
      path: contextPath,
      write: false,
    });
  }
  // **buildx splits the WHOLE string at the FIRST `=`** — `ParseSSHSpecs` is
  // `strings.SplitN(s, "=", 2)`, matching the documented
  // `default|<id>[=<socket>|<key>[,<key>]]` — so the left side is the ID and
  // everything right of it, comma-separated, is a path. A per-ENTRY split
  // diverges the moment a comma precedes that `=`: `",k=/home/victim/.ssh/id_rsa"`
  // gave buildx the id `,k` and the victim's key, while cdkd read entry 1
  // whole as `k=/home/victim/.ssh/id_rsa`, a relative string folding inside
  // the context — silent. Third time this field was patched, and the first
  // time cdkd's split is the consumer's split, which is what ends it.
  //
  // `default` needs no special case any more: with no `=` there is no path
  // list at all, so the agent-socket form falls out structurally.
  //
  // The assumption this rests on, and the input that falsifies it: buildx's
  // grammar allows ONE id group per `--ssh` value. If that ever changes,
  // `k=/a,b=/home/victim/.ssh/id_rsa` makes the second group a relative
  // string that folds inside the context and goes silent again. Run that
  // value through here before trusting this split after a buildx upgrade.
  const ssh = source.dockerBuildSsh ?? '';
  const sshEq = ssh.indexOf('=');
  for (const entry of sshEq < 0 ? [] : ssh.slice(sshEq + 1).split(',')) {
    const p = entry.trim();
    if (p.length === 0) continue;
    refs.push({ field: 'dockerBuildSsh', where: 'dockerBuildSsh', path: p, write: false });
  }
  for (const [k, v] of Object.entries(source.dockerBuildSecrets ?? {})) {
    // **The string the argv pushes, not the value alone.** `buildDockerBuildCommand`
    // renders `--secret id=${k},${v}` with no quoting, so a manifest can put
    // CSV in the KEY — `{'x,src=/home/victim/.aws/credentials': 'type=file'}`
    // — and judging `v` alone saw nothing. `bareIsWrite: false` because the
    // bare-path shorthand is `--output`'s, not this field's.
    for (const { path: p, write } of candidateHostPaths(`id=${k},${v}`, {
      bareIsWrite: false,
    })) {
      refs.push({ field: 'dockerBuildSecrets', where: k, path: p, write });
    }
  }
  // **The RENDERED flag, not `params`.** These two carried their own
  // allowlist loop over the struct — the same shape that was short three
  // rounds running — while the argv is `cacheOptionToFlag`'s concatenation
  // with nothing quoted. `type: 'local,dest=/home/victim/.ssh'` with NO
  // params rendered a host WRITE that this walk could not see, and a
  // `params` key of `tag: 'v1,src=/home/victim/.aws/credentials'` hid a read
  // behind a key the allowlist rejected. Judging the string BuildKit parses
  // closes both by construction.
  (source.cacheFrom ?? []).forEach((c, i) => {
    for (const { path: p, write } of candidateHostPaths(cacheOptionToFlag(c), {
      bareIsWrite: false,
    })) {
      refs.push({ field: 'cacheFrom', where: String(i), path: p, write });
    }
  });
  if (source.cacheTo) {
    for (const { path: p, write } of candidateHostPaths(cacheOptionToFlag(source.cacheTo), {
      bareIsWrite: false,
    })) {
      refs.push({ field: 'cacheTo', where: 'cacheTo', path: p, write });
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
  //
  // `'/'` is the hostile shape, not the only one. The ORDINARY
  // `DockerImageAsset({ directory: '.' })` at a project root with `cdk.out`
  // beside it is also a context containing the outdir, and there the
  // exemption is off and every passthrough gets its own line. Those lines are
  // TRUE — the paths really are outside the assembly — so this is a trade,
  // not a bug: the exemption exists to stop a REPEATED report, and it is
  // given up wherever keeping it would let the context widen the bound.
  //
  // `bound` is `resolve`d because `assemblyPathEscape`'s third parameter is a
  // candidate resolved against `base`: a relative bound would be joined onto
  // the context and answer about `<context>/cdk.out` instead.
  const contextNarrows = assemblyPathEscape(base, base, resolve(bound)) !== undefined;
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
