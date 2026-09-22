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
        dockerBuildContexts: { extra: victim },
        dockerBuildSecrets: { npmrc: `type=file,src=${join(victim, '.npmrc')}` },
        cacheFrom: [{ type: 'local', params: { src: join(victim, 'cache') } }],
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
    for (const field of [
      'dockerFile',
      'dockerBuildContexts',
      'dockerBuildSecrets',
      'cacheFrom',
      'cacheTo',
      'dockerOutputs',
    ]) {
      const line = lines.find((l) => l.includes(field));
      expect(line, `no warning named ${field}`).toBeDefined();
      expect(line).toContain(victim);
    }
  });

  it('says WRITE for the two fields that are write targets, and read for the rest', () => {
    // The distinction a reader acts on: `dockerOutputs` / `cacheTo` create
    // files on the host, the others only read.
    const { outdir, context, victim } = assembly();
    const cap = captureWarn();

    warnEscapingBuildKitPaths(
      source({
        dockerFile: join(victim, 'Dockerfile'),
        dockerOutputs: [`type=local,dest=${join(victim, 'out')}`],
        cacheTo: { type: 'local', params: { dest: join(victim, 'cache-out') } },
      }),
      context,
      outdir
    );

    const lines = cap.warned();
    expect(lines.find((l) => l.includes('dockerOutputs'))).toContain('cdkd will WRITE to it');
    expect(lines.find((l) => l.includes('cacheTo'))).toContain('cdkd will WRITE to it');
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
    // build fails. A malformed value yields no path and no line.
    const { outdir, context } = assembly();
    const cap = captureWarn();

    expect(() =>
      warnEscapingBuildKitPaths(
        source({
          dockerBuildSecrets: { a: 'no-equals-here', b: 'src=' },
          dockerOutputs: ['', ',,,', 'type=local'],
        }),
        context,
        outdir
      )
    ).not.toThrow();
    expect(cap.warned()).toEqual([]);
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
