import { afterAll, describe, it, expect } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { NESTED_KEY_TARGETS, loadReport } from '../../../scripts/gen-nested-key-coverage.ts';

// Kept apart from gen-nested-key-coverage.test.ts so these ~2s spawns run in a
// worker of their own; vitest's concurrent mode is not an option because the
// stream fence buffers per worker.

const repoRoot = process.cwd();
const SCRIPT = resolve(repoRoot, 'scripts/gen-nested-key-coverage.ts');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');

// The probes in gen-nested-key-coverage.test.ts drive the library functions. This block drives the
// SHIPPED command — argv parsing, `loadReport`, the failure text and the EXIT
// CODE — because that is what CI actually runs, and because a collapse of the
// hand-off walk on REAL provider code is only reachable by swapping the
// providers tree itself (#1448).
describe('the shipped --check command', { timeout: 30_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-nkc-cli-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const runCheck = (providersDir?: string): { status: number; stderr: string } => {
    const args = ['--check', ...(providersDir ? [`--providers-dir=${providersDir}`] : [])];
    const run = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.error, 'the critic must be spawnable').toBeUndefined();
    return { status: run.status ?? -1, stderr: run.stderr };
  };

  /** A scratch COPY of the REAL providers tree, with one regression injected. */
  const regressedTree = (name: string, file: string, edit: (source: string) => string): string => {
    const dir = join(scratch, name);
    cpSync(PROVIDERS_DIR, dir, { recursive: true });
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    expect(after, `the ${name} probe changed nothing — anchor drifted?`).not.toBe(before);
    writeFileSync(path, after);
    return dir;
  };

  it('exits 0 and reports its coverage on the real providers tree', () => {
    const { status, stderr } = runCheck();
    expect(status).toBe(0);
    expect(stderr).toContain('nested-key-coverage: OK — shape pass 0 divergences across');
    expect(stderr).toMatch(/; \d+ of \d+ nested paths delivered whole\)/);
  });

  // One spawned case per CI-BLOCKING verdict, per the repo's checker rules —
  // "each" means each. Each regression below is the same one the
  // corresponding library-level probe in gen-nested-key-coverage.test.ts
  // injects, so the two stay in step.
  const BLOCKING_VERDICT_PROBES: ReadonlyArray<{
    readonly bucket: string;
    readonly file: string;
    readonly named: string;
    readonly edit: (source: string) => string;
  }> = [
    {
      bucket: 'array-vs-wrapper',
      file: 'cloudfront-distribution-provider.ts',
      named: 'AWS::CloudFront::Distribution: Aliases [array-vs-wrapper]',
      edit: (source) => source.replaceAll('Aliases', 'Xliases'),
    },
    {
      bucket: 'definition-member-missing',
      file: 'cloudfront-distribution-provider.ts',
      named: 'AWS::CloudFront::Distribution: CachedMethods [definition-member-missing]',
      edit: (source) => source.replaceAll('CachedMethods', 'XachedMethods'),
    },
  ];

  for (const { bucket, file, named, edit } of BLOCKING_VERDICT_PROBES) {
    it(`exits 1 naming a real ${bucket} divergence from the seam`, () => {
      const dir = regressedTree(`providers-${bucket}`, file, edit);
      const { status, stderr } = runCheck(dir);
      expect(status).toBe(1);
      expect(stderr).toContain(
        'nested-key-coverage: FAIL — nested CFn->SDK shape divergence(s) detected.'
      );
      expect(stderr).toContain(named);
    });
  }

  it('exits 1 on a collapsed hand-off walk, naming the walk', () => {
    // Renaming the desired-state bag out of `HANDOFF_BAG_PARAM_NAMES` is a real
    // shape of collapse: only the dedicated floor can name the cause.
    const dir = regressedTree('providers-handoff-collapsed', 'apigatewayv2-provider.ts', (source) =>
      source.replaceAll(/\bproperties\b/g, 'bag')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('whole-blob hand-off walk for apigatewayv2-provider.ts collapsed');
    expect(stderr).toContain('parser regression?');
    // ...and NOT a wall of shape verdicts standing in for the cause.
    expect(stderr).not.toContain('shape divergence(s) detected');
  });

  it('exits 1 when the spread seed stops being bag-derived (#1475)', () => {
    // Every CloudFront hand-off point derives from the root spread (the nested
    // seeds spread `result['X']`, whose taint flows from `{ ...config }`), so
    // removing the seed collapses the walk to zero points and the
    // `minHandoffPoints` floor fires — one legible error. This is the collapse
    // mode that floor exists for, proven on real code.
    const dir = regressedTree(
      'providers-spread-seedless',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          '    const result = { ...config };\n',
          '    const result: Record<string, unknown> = {};\n'
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('whole-blob hand-off walk for cloudfront-distribution-provider.ts');
    expect(stderr).toContain('collapsed to 0 blob-carrying hand-off point(s)');
  });

  it('exits 1 naming a STALE segmentRenames entry (#1464)', () => {
    // The other staleness fence, proven RED against real code. Renaming the SDK
    // member `properties` back to the CFn spelling makes the un-renamed chain
    // resolve, so `ProxyConfigurationProperties -> properties` stops earning
    // its place and must be reported rather than left as an inert exception —
    // the discipline `NESTED_KEY_ALLOW_LIST` has carried since #1373.
    const dir = regressedTree('providers-stale-rename', 'ecs-provider.ts', (source) =>
      source.replace(
        "      properties: this.convertEnvironment(\n",
        "      proxyConfigurationProperties: this.convertEnvironment(\n"
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale segmentRenames');
    expect(stderr).toContain('AWS::ECS::TaskDefinition#ProxyConfigurationProperties');
  });

  it('exits 1 naming a STALE allow-list entry', () => {
    // The stale-entry fence, red-proven on real code. `S3Origin` is
    // allow-listed only because the provider never names the legacy member;
    // a literal naming it makes the shape verdict `provider-handled`, the entry
    // stops matching, and `--check` must report it rather than silently keep
    // it.
    const dir = regressedTree(
      'providers-stale',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          'export class CloudFrontDistributionProvider',
          "const NAMES_THE_KEY = ['S3Origin'];\nvoid NAMES_THE_KEY;\nexport class CloudFrontDistributionProvider"
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale NESTED_KEY_ALLOW_LIST');
    expect(stderr).toContain('AWS::CloudFront::Distribution#S3Origin');
  });

  it('exits 1 when a target fixture has no nestedPropertyPaths capture (#1464)', () => {
    // The RED direction of `loadReport`'s loud failure, the twin of the
    // `definitionShapes` probe. A fixture tree that was only PARTIALLY
    // re-captured must name the missing capture and the command that fixes it,
    // not silently audit zero paths.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'cdkd-nkc-fx-'));
    cpSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas'), fixtureDir, { recursive: true });
    const path = join(fixtureDir, 'AWS-CodeBuild-Project.json');
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete fixture['nestedPropertyPaths'];
    writeFileSync(path, JSON.stringify(fixture, null, 2));
    const target = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::CodeBuild::Project')!;
    expect(() => loadReport([target], undefined, undefined, fixtureDir)).toThrow(
      /has no nestedPropertyPaths capture/
    );
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('rejects an unrecognized flag instead of falling through to WRITER mode', () => {
    // `--chekc` used to REWRITE the committed matrix and exit 0 — the same
    // silent-full-run trap `refresh-cfn-schemas.mjs --help` had before its
    // guard (#1378 rider). The SPACE form of the seam is caught here too: it
    // does not match the `--providers-dir=` prefix, so without this guard it
    // would slip into the writer path.
    for (const flag of ['--chekc', '-c', '--providers-dir']) {
      const run = spawnSync(process.execPath, [SCRIPT, flag, '/tmp'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(run.status, flag).toBe(1);
      expect(run.stderr, flag).toContain('Usage:');
      expect(run.stdout, flag).not.toContain('wrote nested-key-coverage');
    }
  });

  it('--help prints usage and exits 0 without writing anything', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage:');
    expect(run.stderr).not.toContain('wrote nested-key-coverage');
  });

  it('refuses --providers-dir= in WRITER mode instead of rewriting the matrix', () => {
    // Without the guard the seam renders docs/_generated from a scratch tree.
    const run = spawnSync(process.execPath, [SCRIPT, `--providers-dir=${PROVIDERS_DIR}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--check-only test seam');
  });
});
