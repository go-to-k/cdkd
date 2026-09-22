/**
 * The warnings for the parts of an asset manifest cdkd forwards VERBATIM
 * (issue go-to-k/cdkd#3497).
 *
 * The maintainer decision on that issue is warn-and-document: no refusal, no
 * opt-in flag. So every case here asserts a LINE and a RETURN, never a throw —
 * a regression that "hardened" one of these into a refusal must red, because
 * the refusal is the thing the decision rejected, not a stricter version of it.
 *
 * Each warning also has its silent twin. A warning that fires on ordinary
 * input is worse than none: this layer has already shipped one cry-wolf line
 * (go-to-k/cdkd#3532's `/var` vs `/private/var`) and the negatives are what
 * stop the next.
 */
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resetDestinationWarnings,
  warnEscapingBuildKitPaths,
  warnManifestExecutable,
  warnUnrecognizedAssetDestination,
} from '../../../src/assets/manifest-passthrough-warnings.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { DockerImageAssetSource } from '../../../src/types/assets.js';

function captureWarn(): { warned: () => string[] } {
  const lines: string[] = [];
  vi.spyOn(getLogger(), 'child').mockImplementation(
    () =>
      ({
        warn: (m: string) => lines.push(m),
        debug: () => {},
        info: () => {},
        error: () => {},
        child: () => getLogger().child(''),
      }) as never
  );
  return { warned: () => lines };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetDestinationWarnings();
});

/** An outdir with a real asset directory inside and a victim beside it. */
function assembly(): { outdir: string; context: string; victim: string } {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-passthrough-')));
  const outdir = join(outer, 'cdk.out');
  const context = join(outdir, 'asset.abc123');
  mkdirSync(context, { recursive: true });
  const victim = join(outer, 'victim');
  mkdirSync(victim);
  return { outdir, context, victim };
}

const source = (over: Partial<DockerImageAssetSource>): DockerImageAssetSource =>
  ({ directory: '.', ...over }) as DockerImageAssetSource;

describe('BuildKit passthrough host paths', () => {
  it('WARNS for every field that can name a host path, naming the field and the path', () => {
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({
        dockerFile: join(victim, 'Dockerfile'),
        dockerBuildContexts: { extra: join(victim, 'ctx-dir') },
        dockerBuildSecrets: { npmrc: `type=file,src=${join(victim, '.npmrc')}` },
        cacheFrom: [{ type: 'local', params: { src: join(victim, 'cache-in') } }],
        cacheTo: { type: 'local', params: { dest: join(victim, 'cache-out') } },
        dockerOutputs: [`type=local,dest=${join(victim, 'out')}`],
      }),
      context,
      outdir
    );

    const lines = cap.warned();
    // One per field: a single line covering six values would make a reader
    // guess which one they need to look at.
    expect(lines).toHaveLength(6);
    const leaves: Record<string, string> = {
      dockerFile: 'Dockerfile',
      dockerBuildContexts: 'ctx-dir',
      dockerBuildSecrets: '.npmrc',
      cacheFrom: 'cache-in',
      cacheTo: 'cache-out',
      dockerOutputs: 'out',
    };
    for (const field of Object.keys(leaves)) {
      const line = lines.find((l) => l.includes(field));
      expect(line, `no warning named ${field}`).toBeDefined();
      // The LEAF, not the shared parent. Every fixture path sits under
      // `victim`, so asserting `victim` alone passed even if a field were
      // paired with another field's path.
      expect(line, `${field} named the wrong path`).toContain(leaves[field]);
    }
  });

  it('says WRITE from the dest= KEY, not from the field name', () => {
    // The distinction a reader acts on, and the one the implementation gets
    // wrong if it keys on the field: `cacheFrom` can carry a `dest=` and
    // `cacheTo` a `src=`, so the two DIVERGENT pairs are what this asserts.
    // A first version used only `cacheTo`+`dest=` and `dockerOutputs`+`dest=`,
    // where field and key agree — reverting to a field lookup reddened
    // nothing.
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({
        dockerFile: join(victim, 'Dockerfile'),
        dockerOutputs: [`type=local,dest=${join(victim, 'out')}`],
        // DIVERGENT: a write key on the "read" field, and a read key on the
        // "write" field.
        cacheFrom: [{ type: 'local', params: { dest: join(victim, 'cf-dest') } }],
        cacheTo: { type: 'local', params: { src: join(victim, 'ct-src') } },
      }),
      context,
      outdir
    );

    const lines = cap.warned();
    expect(lines.find((l) => l.includes('dockerOutputs'))).toContain('cdkd will WRITE to it');
    expect(lines.find((l) => l.includes('cacheFrom'))).toContain('cdkd will WRITE to it');
    expect(lines.find((l) => l.includes('cacheTo'))).toContain('cdkd will read it');
    expect(lines.find((l) => l.includes('dockerFile'))).toContain('cdkd will read it');

    // **The whole line, because the verb alone passed for the wrong reason.**
    // A first revision passed the verb as `renderAssemblyPathEscape`'s
    // `action` positional, which fills `Refusing to ${action}.` — so this
    // case was satisfied by the string `Refusing to WRITE to it silently.`,
    // in the one change whose entire point is that it does NOT refuse, and
    // the line went on to say cdkd forwards the path anyway.
    for (const line of lines) {
      expect(line).not.toContain('Refusing');
      expect(line).toContain('matching the CDK CLI');
    }
  });

  it('WARNS for EVERY dockerBuildSsh key, not just the first', () => {
    // `--ssh <id>=<socket|key>[,<key>...]`: the keys AFTER the first carry no
    // `=`. A revision that required one per entry saw only `k=./ok.key`,
    // which is inside the context and silent — so the victim's key produced
    // NO line at all, and the hole a previous round closed was still open for
    // exactly the input that matters.
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({ dockerBuildSsh: `k=ok.key,${join(victim, 'id_rsa')}` }),
      context,
      outdir
    );

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(victim, 'id_rsa'));
  });

  it('does NOT label a dockerBuildSecrets bare path as a WRITE', () => {
    // The bare-path shorthand belongs to `--output`. Applying it everywhere
    // made a secret READ announce itself as a write, which alarms in the
    // wrong direction about a spelling buildx rejects outright.
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({ dockerBuildSecrets: { k: join(victim, '.npmrc') } }),
      context,
      outdir
    );

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cdkd will read it');
  });

  it('judges the RENDERED argv, so CSV injected through a non-path field still warns', () => {
    // cdkd sees the struct; BuildKit sees the concatenation, and neither `,`
    // nor `=` is quoted on the way. Walking the struct therefore missed every
    // value a manifest smuggled through a field the walk did not treat as a
    // path — the same "my enumeration was short" shape as the three rounds
    // before, one level up. All three of these produced NO line.
    const { outdir, context, victim } = assembly();
    const secret = join(victim, 'credentials');

    // 1. A cache `type` carrying the whole CSV, with no params at all.
    let cap = captureWarn();
    warnEscapingBuildKitPaths(
      source({ cacheTo: { type: `local,dest=${secret}` } }),
      context,
      outdir
    );
    expect(cap.warned(), 'cacheTo type= injection').toHaveLength(1);
    expect(cap.warned()[0]).toContain('cdkd will WRITE to it');
    vi.restoreAllMocks();

    // 2. A params VALUE under a key the old allowlist rejected.
    cap = captureWarn();
    warnEscapingBuildKitPaths(
      source({ cacheFrom: [{ type: 'local', params: { tag: `v1,src=${secret}` } }] }),
      context,
      outdir
    );
    expect(cap.warned(), 'cacheFrom params-key injection').toHaveLength(1);
    expect(cap.warned()[0]).toContain(secret);
    vi.restoreAllMocks();

    // 3. A secret's KEY, which the argv interpolates as `id=${k},${v}`.
    cap = captureWarn();
    warnEscapingBuildKitPaths(
      source({ dockerBuildSecrets: { [`x,src=${secret}`]: 'type=file' } }),
      context,
      outdir
    );
    expect(cap.warned(), 'dockerBuildSecrets key injection').toHaveLength(1);
    expect(cap.warned()[0]).toContain(secret);
  });

  it('does NOT call a keyed non-dest --output parameter a WRITE', () => {
    // `write` is exempt from the build-context skip, so an over-eager write
    // label survives to the user: `type=image,push=true` announced a WRITE to
    // `<context>/true`. Only `dest=` and the bare-path form are writes.
    const { outdir, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({ dockerOutputs: ['type=image,push=true'] }),
      victim,
      outdir
    );

    expect(cap.warned()).toEqual([]);
  });

  it("splits --ssh where buildx splits it: the WHOLE string at the FIRST `=`", () => {
    // `ParseSSHSpecs` is `strings.SplitN(s, '=', 2)`, so a comma BEFORE that
    // `=` belongs to the ID, not to the path list. Splitting per entry instead
    // diverged exactly there: `,k=<victim key>` gave buildx the id `,k` and
    // the key, while cdkd read `k=<victim key>` whole — a relative string that
    // folds inside the context, and printed nothing. Third patch to this
    // field, and the first where cdkd's split IS the consumer's.
    const { outdir, context, victim } = assembly();
    const key = join(victim, 'id_rsa');

    let cap = captureWarn();
    warnEscapingBuildKitPaths(source({ dockerBuildSsh: `,k=${key}` }), context, outdir);
    expect(cap.warned(), 'comma before the first =').toHaveLength(1);
    expect(cap.warned()[0]).toContain(key);
    vi.restoreAllMocks();

    // Every path right of the first `=`, however many.
    cap = captureWarn();
    warnEscapingBuildKitPaths(
      source({ dockerBuildSsh: `k=ok.key,${key},${join(victim, 'ok2.key')}` }),
      context,
      outdir
    );
    expect(cap.warned(), 'continuation keys').toHaveLength(2);
    vi.restoreAllMocks();

    // No `=` at all is the agent-socket form and names no manifest path, so
    // `default` needs no special case — nor does any other bare id.
    cap = captureWarn();
    warnEscapingBuildKitPaths(source({ dockerBuildSsh: 'default' }), context, outdir);
    expect(cap.warned(), 'bare id').toEqual([]);
  });

  it('stays SILENT for an EMPTY --build-context value, which would name the context itself', () => {
    // `{ a: '' }` renders `a=`, whose "path" is the context directory — a true
    // sentence pointing at the wrong thing. `candidateHostPaths` guards this;
    // the build-context arm no longer goes through it, so it carries the guard.
    const { outdir, outer } = { ...assembly(), outer: '' };
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-emptyctx-')));
    const od = join(root, 'cdk.out');
    mkdirSync(od);
    const cap = captureWarn();

    warnEscapingBuildKitPaths(source({ dockerBuildContexts: { a: '' } }), root, od);

    expect(cap.warned()).toEqual([]);
    void outdir;
    void outer;
  });

  it('judges the RENDERED --build-context element, key included', () => {
    // `args.push('--build-context', `${k}=${v}`)` and buildx takes everything
    // after the FIRST `=` as the value, so a key containing `=` makes
    // BuildKit's value a superset of `v`. No exploit is reachable — anything
    // hidden that way must itself contain `=`, and real targets do not — but
    // this was the last place left safe BY ARGUMENT, and four rounds running
    // the place left safe by argument is what broke next. A probe on the fix
    // came back GREEN until this case existed, which is the point.
    const { outdir, context } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      // `v` alone folds inside the context and is silent; the rendered
      // element escapes, so the two spellings genuinely differ here.
      // The key's own TAIL is what lands in BuildKit's path: for
      // `name=../../outside`, the rendered element is
      // `name=../../outside=inner` and BuildKit reads `../../outside=inner`,
      // while `v` alone is `inner` — inside the context and silent.
      source({ dockerBuildContexts: { 'name=../../outside': 'inner' } }),
      context,
      outdir
    );

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dockerBuildContexts');
  });

  it('does NOT turn a registry ref or an env-var NAME into a host-path line', () => {
    // The configuration that makes this reachable is ORDINARY, not hostile:
    // a context CONTAINING the outdir (`directory: '.'` at a project root)
    // switches the build-context exemption off, because a context that
    // contains the bound would otherwise widen it. A revision that treated
    // every keyed option part as a path then announced `<root>/ghcr.io/u/app:cache`
    // and `<root>/MY_TOKEN` as host paths cdkd would read.
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-nonpath-')));
    const outdir = join(outer, 'cdk.out');
    mkdirSync(outdir);
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({
        cacheFrom: [{ type: 'registry', params: { ref: 'ghcr.io/u/app:cache' } }],
        cacheTo: { type: 'gha', params: { scope: 'build', mode: 'max' } },
        dockerBuildSecrets: { t: 'type=env,env=MY_TOKEN' },
        dockerOutputs: ['type=image,push=true'],
      }),
      outer,
      outdir
    );

    expect(cap.warned()).toEqual([]);
  });

  it('does NOT let a source.directory of "/" silence the whole set', () => {
    // The build-context read exemption makes `base` a second bound, and
    // `resolveDockerContextDirectory` HONOURS an absolute `source.directory`
    // — so one field could make every path "inside the context". That is the
    // ancestor-bound hole `resolveAssemblyPath`'s own `containWithin` note
    // already writes down: `containWithin: '/'` admits `/etc/passwd`. The
    // exemption switches off when the context contains the bound.
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-ancestor-')));
    const outdir = join(outer, 'cdk.out');
    mkdirSync(outdir);
    const cap = captureWarn();

    warnEscapingBuildKitPaths(source({ directory: '/', dockerFile: '/etc/passwd' }), '/', outdir);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/etc/passwd');
  });

  it('WARNS for a WRITE inside the build context when the context is outside the outdir', () => {
    // The read exemption must not carry to writes. Under `--no-staging` the
    // context is the user's own source tree; "BuildKit already has that
    // directory to read" does not license creating files in it.
    const { outdir, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({ dockerFile: 'Dockerfile', dockerOutputs: ['out'] }),
      victim,
      outdir
    );

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dockerOutputs');
    expect(lines[0]).toContain('cdkd will WRITE to it');
  });

  it('WARNS for a dockerBuildSsh private key path, which is a host file too', () => {
    // `--ssh <id>=<key path>` makes BuildKit read that key and serve it to a
    // `RUN --mount=type=ssh` the same manifest wrote. Missing from a first
    // revision's enumeration, which claimed to cover every host path.
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({ dockerBuildSsh: `k=${join(victim, 'id_rsa')}` }),
      context,
      outdir
    );

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dockerBuildSsh');
    expect(lines[0]).toContain(join(victim, 'id_rsa'));
  });

  it('WARNS for the dockerOutputs BARE PATH shorthand, which is a write', () => {
    // `--output=<path>` with no `=`-keyed part is valid shorthand for
    // `type=local,dest=<path>`. A first revision required a `dest=` key, so
    // this write passed unwarned — the worst direction for this field.
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(source({ dockerOutputs: [victim] }), context, outdir);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cdkd will WRITE to it');
  });

  it('WARNS for `source=` and for an upper-case key, which buildx also accepts', () => {
    // buildx lower-cases option keys and takes `source` as an alias for `src`.
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({
        dockerBuildSecrets: {
          a: `type=file,source=${join(victim, '.npmrc')}`,
          b: `type=file,SRC=${join(victim, '.netrc')}`,
        },
      }),
      context,
      outdir
    );

    expect(cap.warned()).toHaveLength(2);
  });

  it('stays SILENT for a value inside the BUILD CONTEXT, even when the context is outside the outdir', () => {
    // The `cdk synth --no-staging` shape: the context itself is outside the
    // outdir, which go-to-k/cdkd#3532's warning already reports once. Judging
    // these against the outdir alone repeated that per passthrough, for values
    // that never leave the directory BuildKit was already handed.
    const { outdir, victim } = assembly();
    mkdirSync(join(victim, 'sub'));
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({ dockerFile: 'Dockerfile', dockerBuildContexts: { extra: 'sub' } }),
      victim,
      outdir
    );

    expect(cap.warned()).toEqual([]);
  });

  it('stays SILENT for ordinary values inside the assembly', () => {
    const { outdir, context } = assembly();
    mkdirSync(join(context, 'sub'));
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({
        dockerFile: 'Dockerfile',
        dockerBuildContexts: { extra: 'sub' },
        dockerBuildSecrets: { npmrc: 'type=file,src=.npmrc' },
        dockerOutputs: ['type=local,dest=sub'],
      }),
      context,
      outdir
    );

    expect(cap.warned()).toEqual([]);
  });

  it('stays SILENT for a REMOTE build context, and NOT by special-casing one', () => {
    // `docker-image://`, a git URL and an https URL are legitimate BuildKit
    // contexts and must not warn. They do not, and the reason matters: a
    // remote reference is a RELATIVE string, so it folds to
    // `<context>/docker-image:/alpine:3.20`, which is inside the assembly.
    // A first revision carried a scheme filter for this; a probe deleting it
    // reddened nothing, so the filter went rather than the test.
    const { outdir, context } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({
        dockerBuildContexts: {
          img: 'docker-image://alpine:3.20',
          repo: 'https://github.com/example/repo.git',
          ssh: 'git@github.com:example/repo.git',
        },
      }),
      context,
      outdir
    );

    expect(cap.warned()).toEqual([]);
  });

  it('tolerates an unparseable option string rather than throwing', () => {
    // This module only ever ADDS a warning; it must never be why a legitimate
    // build fails.
    //
    // The ESCAPING spelling is deliberate, and it has to clear the OUTDIR,
    // not just the context. A first version used relative
    // junk and passed because it folded inside the build context, not
    // because the parser handled it — which hid that the bare-path shorthand
    // was labelling a secret READ as a WRITE. With `../` the line is emitted
    // and its verb is asserted, so that defect reds here.
    const { outdir, context } = assembly();
    const cap = captureWarn();

    expect(() =>
      warnEscapingBuildKitPaths(
        source({
          dockerBuildSecrets: { a: '../../no-equals-here', b: 'src=' },
          dockerOutputs: ['', ',,,', 'type=local'],
        }),
        context,
        outdir
      )
    ).not.toThrow();

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dockerBuildSecrets');
    expect(lines[0]).toContain('cdkd will read it');
  });
});

describe('source.executable', () => {
  it('WARNS naming the command, and says -a <dir> executes assembly code', () => {
    const cap = captureWarn();

    warnManifestExecutable(['./build.sh', '--tag', 'x']);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('./build.sh');
    expect(lines[0]).toContain('2 argument(s)');
    // The expectation the decision says this exists to correct.
    expect(lines[0]).toContain('DOES execute code from it');
  });

  it('does NOT render the arguments at default verbosity', () => {
    // A first revision rendered the whole argv here through
    // `redactDockerArgvValues`. That masker covers `docker build` flag shapes
    // and NOTHING else, so a legitimate build script's own secret argument
    // would have been promoted from `--verbose`-only to a line in every CI
    // log, on every deploy — a new leak introduced by a warning about leaks.
    // The decision's words are "naming the command", which argv[0] satisfies.
    const cap = captureWarn();

    warnManifestExecutable(['./build.sh', '--token', 'ghp_not_a_real_token', '--password=hunter2']);

    const line = cap.warned()[0];
    expect(line).not.toContain('ghp_not_a_real_token');
    expect(line).not.toContain('hunter2');
    expect(line).toContain('./build.sh');
    expect(line).toContain('--verbose shows them');
  });

  it('omits the argument count when there are none', () => {
    const cap = captureWarn();
    warnManifestExecutable(['./build.sh']);
    expect(cap.warned()[0]).not.toContain('argument(s)');
  });
});

describe('asset destinations', () => {
  it('WARNS for a name that is neither bootstrap-shaped nor cdkd-managed', () => {
    const cap = captureWarn();

    warnUnrecognizedAssetDestination({
      kind: 'bucket',
      name: 'attacker-named-bucket',
      recognized: false,
    });

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('attacker-named-bucket');
    expect(lines[0]).toContain('with your credentials');
    // A custom bootstrap is legitimate, so the line must not read as an
    // accusation the user cannot act on.
    expect(lines[0]).toContain('custom');
  });

  it('warns ONCE per name, however many assets share it', () => {
    // Emitted per asset x per destination at graph construction. A legitimate
    // custom bootstrap or an AppStagingSynthesizer bucket is deliberately
    // outside the recognized shapes, so a thirty-asset stack printed thirty
    // identical lines, every deploy.
    const cap = captureWarn();

    for (let i = 0; i < 5; i++) {
      warnUnrecognizedAssetDestination({ kind: 'bucket', name: 'my-staging', recognized: false });
    }
    warnUnrecognizedAssetDestination({ kind: 'repository', name: 'my-staging', recognized: false });

    // Once for the bucket; the repository of the same NAME is a different
    // resource and gets its own line.
    expect(cap.warned()).toHaveLength(2);
  });

  it('stays SILENT for a recognized destination', () => {
    const cap = captureWarn();

    warnUnrecognizedAssetDestination({
      kind: 'repository',
      name: 'cdk-hnb659fds-container-assets-123456789012-us-east-1',
      recognized: true,
    });

    expect(cap.warned()).toEqual([]);
  });
});
