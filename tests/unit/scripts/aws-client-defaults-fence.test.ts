import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vite-plus/test';

import ts from 'typescript-v6';

import {
  buildReport,
  findClientSites,
  readAllowList,
  sdkClientIdentifiers,
} from '../../../scripts/check-aws-client-defaults.ts';

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('fake.ts', source, ts.ScriptTarget.Latest, true);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const allowListPath = join(repoRoot, 'tests/aws-client-defaults-allowlist.json');
const allowList = readAllowList(allowListPath);

const scratchDirs: string[] = [];
function scratchCopyOfSrc(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-client-fence-'));
  scratchDirs.push(dir);
  cpSync(join(repoRoot, 'src'), join(dir, 'src'), { recursive: true });
  return join(dir, 'src');
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function sites(source: string) {
  return findClientSites(join(repoRoot, 'src/fake.ts'), source);
}

/**
 * The regression fence for issue #2388.
 *
 * The invariant it guards is invisible in review and invisible to every test:
 * a client built without `awsClientDefaults()` behaves identically everywhere
 * except behind a proxy, where it fails at credential resolution with an error
 * that names neither the proxy nor the client. With ~134 construction sites and
 * a repository that gains providers steadily, the next new provider is where it
 * decays.
 */
describe('SDK client construction critic', () => {
  describe('identifier resolution', () => {
    it('binds to identifiers imported from @aws-sdk/client-*', () => {
      const source = `
        import { S3Client } from '@aws-sdk/client-s3';
        import { S3StateBackend } from './state.js';
      `;
      expect([...sdkClientIdentifiers(parse(source))]).toEqual(['S3Client']);
    });

    it('follows an import alias, which a name regex cannot', () => {
      const source = `import { S3Client as Bucket } from '@aws-sdk/client-s3';`;
      expect([...sdkClientIdentifiers(parse(source))]).toEqual(['Bucket']);
    });

    it('ignores commands, which share the package but take an input bag', () => {
      // Binding to the import ALONE reported 1726 sites where there are 134.
      const source = `import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';`;
      expect([...sdkClientIdentifiers(parse(source))]).toEqual(['S3Client']);
    });

    it('ignores a same-named class that is not the SDK\'s', () => {
      const source = `
        import { FakeClient } from './local.js';
        const c = new FakeClient({ region: 'us-east-1' });
      `;
      expect(sites(source)).toEqual([]);
    });
  });

  describe('verdicts', () => {
    const IMPORT = `import { S3Client } from '@aws-sdk/client-s3';\n`;

    it('accepts a literal that opens with the defaults', () => {
      const found = sites(`${IMPORT}new S3Client({ ...awsClientDefaults(), region: 'x' });`);
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first']);
    });

    it('rejects a bare construction', () => {
      const found = sites(`${IMPORT}new S3Client({ region: 'x' });`);
      expect(found.map((s) => s.verdict)).toEqual(['missing']);
    });

    it('rejects a construction with no config at all', () => {
      expect(sites(`${IMPORT}new S3Client();`).map((s) => s.verdict)).toEqual(['missing']);
    });

    it('rejects the defaults spread LAST, which would clobber explicit credentials', () => {
      // The order is the property, not the presence: a site that supplies its
      // own `credentials` must keep them.
      const found = sites(`${IMPORT}new S3Client({ credentials: c, ...awsClientDefaults() });`);
      expect(found.map((s) => s.verdict)).toEqual(['defaults-not-first']);
    });

    it('sees through a shared config bag', () => {
      const found = sites(
        `${IMPORT}const opts = { ...awsClientDefaults(), region: 'x' };\nnew S3Client(opts);`
      );
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first']);
    });

    it('sees through a `this.x` getter — how all 22 aws-clients.ts sites are written', () => {
      const found = sites(
        `${IMPORT}class A {
           private get clientOptions() { return { ...awsClientDefaults(), region: 'x' }; }
           make() { return new S3Client({ ...this.clientOptions, logger: undefined }); }
         }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first']);
    });

    it('rejects a getter that does NOT open with the defaults', () => {
      // The paired REFUSAL for the indirection above: without it, the
      // resolution would credit any `this.x` spread whatsoever.
      const found = sites(
        `${IMPORT}class A {
           private get clientOptions() { return { region: 'x' }; }
           make() { return new S3Client({ ...this.clientOptions }); }
         }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['missing']);
    });

    it('rejects ONE bag handed to two clients — they would share a routing agent', () => {
      // The per-client-agent rule broken through the back door. Both sites read
      // as correct on their own: the bag opens with the defaults, so presence
      // and order are both satisfied. What is wrong is that there is one
      // `requestHandler`, and therefore one agent, between two clients whose
      // `destroy()` calls are independent.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         const opts = { ...awsClientDefaults(), region: 'x' };
         const a = new S3Client(opts);
         const b = new ECRClient(opts);`
      );
      expect(found.map((s) => s.verdict)).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('rejects a shared bag reached by SPREAD, not only as a bare argument', () => {
      // The hole that let `aws-region-resolver.ts` through the first cut. Both
      // sites classify `defaults-first` via the `opensWithDefaults` recursion,
      // which is right about the ORDER and blind to the SHARING.
      const found = sites(
        `${IMPORT}const auth = { ...awsClientDefaults(), profile: 'p' };
         const a = new S3Client({ ...auth, region: 'x' });
         const b = new S3Client({ ...auth, region: 'y' });`
      );
      expect(found.map((s) => s.verdict)).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('does NOT flag a getter spread — it is re-evaluated per client', () => {
      // The discrimination the rule turns on, and the one that decides 22 real
      // sites: sharing is one VALUE reaching two clients, and a getter hands
      // out a new one on every read. Without this, all of `aws-clients.ts`
      // reported as gaps.
      const found = sites(
        `${IMPORT}class A {
           private get clientOptions() { return { ...awsClientDefaults(), region: 'x' }; }
           one() { return new S3Client({ ...this.clientOptions }); }
           two() { return new S3Client({ ...this.clientOptions }); }
         }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first', 'defaults-first']);
    });

    it('flags a class FIELD spread, which unlike a getter is computed once', () => {
      // The paired REJECT for the rule above, so "getter is fine" cannot widen
      // into "anything reached through `this` is fine".
      const found = sites(
        `${IMPORT}class A {
           private readonly opts = { ...awsClientDefaults(), region: 'x' };
           one() { return new S3Client({ ...this.opts }); }
           two() { return new S3Client({ ...this.opts }); }
         }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('accepts the same bag SPREAD, because the helper is then called per client', () => {
      // The paired ACCEPT. This is the correct form and must not be flagged, or
      // the rule would forbid sharing a region between two clients.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         const opts = { region: 'x' };
         const a = new S3Client({ ...awsClientDefaults(), ...opts });
         const b = new ECRClient({ ...awsClientDefaults(), ...opts });`
      );
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first', 'defaults-first']);
    });

    it('does not relabel a shared bag that lacks the defaults', () => {
      // `missing` is the worse and more actionable of the two, so saying
      // "shared" there would name the lesser problem.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         const opts = { region: 'x' };
         const a = new S3Client(opts);
         const b = new ECRClient(opts);`
      );
      expect(found.map((s) => s.verdict)).toEqual(['missing', 'missing']);
    });

    it('leaves a bag used by ONE client alone', () => {
      const found = sites(
        `${IMPORT}const opts = { ...awsClientDefaults(), region: 'x' };\nnew S3Client(opts);`
      );
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first']);
    });

    it('reports a config it cannot read as opaque rather than assuming it clean', () => {
      const found = sites(`${IMPORT}new S3Client(buildConfig());`);
      expect(found.map((s) => s.verdict)).toEqual(['opaque']);
    });

    it('finds a construction split across lines', () => {
      const found = sites(`${IMPORT}new S3Client(\n  {\n    region: 'x',\n  }\n);`);
      expect(found).toHaveLength(1);
      expect(found[0]!.verdict).toBe('missing');
    });
  });

  describe('the real tree', () => {
    const report = buildReport(join(repoRoot, 'src'), allowList);

    it('is green', () => {
      expect(report.gaps).toEqual([]);
      expect(report.staleAllowList).toEqual([]);
      expect(report.deadAllowList).toEqual([]);
    });

    it('still sees the population — a collapsed parse must fail loudly', () => {
      // FLOORS. Without them a walk that silently stops matching reports zero
      // gaps and passes vacuously, which is indistinguishable from clean.
      // Measured on the PR 1 tree: 134 sites across 67 files, 33 clean.
      expect(report.totalSites).toBeGreaterThanOrEqual(100);
      expect(report.filesWithSites).toBeGreaterThanOrEqual(50);
      expect(report.cleanSites).toBeGreaterThanOrEqual(25);
    });

    it('counts the aws-clients.ts bag, whose sites all go through one getter', () => {
      const found = findClientSites(
        join(repoRoot, 'src/utils/aws-clients.ts'),
        readFileSync(join(repoRoot, 'src/utils/aws-clients.ts'), 'utf8')
      );
      expect(found.length).toBeGreaterThanOrEqual(20);
      expect(found.every((site) => site.verdict === 'defaults-first')).toBe(true);
    });
  });

  describe('the allow-list', () => {
    it('names only files that exist', () => {
      const missing = allowList.files.filter((file) => !existsSync(join(repoRoot, file)));
      expect(missing).toEqual([]);
    });

    it('is sorted and deduplicated, so regeneration produces a stable diff', () => {
      expect(allowList.files).toEqual([...new Set(allowList.files)].sort());
    });

    it('does not name a file PR 1 migrated', () => {
      // The ratchet's direction, asserted rather than assumed: these are the
      // files that make the reporter's own repro pass, so an entry for one of
      // them would silently re-open the issue.
      const migrated = [
        'src/utils/aws-clients.ts',
        'src/utils/aws-client-defaults.ts',
        'src/cli/commands/bootstrap.ts',
        'src/utils/expected-bucket-owner.ts',
        'src/utils/aws-region-resolver.ts',
        'src/utils/bucket-region-client.ts',
        'src/assets/asset-storage.ts',
        'src/cli/config-loader.ts',
      ];
      expect(allowList.files.filter((file) => migrated.includes(file))).toEqual([]);
    });
  });

  describe('regression probes against the REAL tree', () => {
    it('reports a migrated file that loses its defaults', () => {
      // COLLAPSE-TOWARD-GREEN defence: a clean report from a checker that
      // cannot fail looks exactly like a clean report from a clean tree.
      const srcDir = scratchCopyOfSrc();
      const target = join(srcDir, 'utils/expected-bucket-owner.ts');
      writeFileSync(
        target,
        readFileSync(target, 'utf8').replace('...awsClientDefaults(),\n', '')
      );
      const report = buildReport(srcDir, allowList);
      expect(report.gaps.map((gap) => gap.file)).toContain('src/utils/expected-bucket-owner.ts');
    });

    it('reports the defaults moved out of first position', () => {
      const srcDir = scratchCopyOfSrc();
      const target = join(srcDir, 'utils/bucket-region-client.ts');
      writeFileSync(
        target,
        readFileSync(target, 'utf8').replace(
          '...awsClientDefaults({ profile: opts.profile }),\n    region: bucketRegion,',
          'region: bucketRegion,\n    ...awsClientDefaults({ profile: opts.profile }),'
        )
      );
      const report = buildReport(srcDir, allowList);
      const verdicts = report.gaps
        .filter((gap) => gap.file === 'src/utils/bucket-region-client.ts')
        .map((gap) => gap.verdict);
      expect(verdicts).toEqual(['defaults-not-first']);
    });

    it('reports an allow-listed file that has become clean', () => {
      // The other direction of the ratchet: an entry that outlives its reason
      // silently withholds protection from the file it names.
      const srcDir = scratchCopyOfSrc();
      const victim = allowList.files[0]!;
      const target = join(srcDir, victim.replace(/^src\//, ''));
      writeFileSync(
        target,
        readFileSync(target, 'utf8').replace(
          /new (\w+Client)\(\s*\{/g,
          'new $1({ ...awsClientDefaults(),'
        )
      );
      const report = buildReport(srcDir, allowList);
      expect(report.staleAllowList).toContain(victim);
    });

    it('reports the shared-bag shape restored in the REAL asset-storage.ts', () => {
      // The shape this file actually shipped with for an hour before the
      // inline review caught it, so the probe is the real regression rather
      // than a fixture of one.
      const srcDir = scratchCopyOfSrc();
      const target = join(srcDir, 'assets/asset-storage.ts');
      const source = readFileSync(target, 'utf8');
      const start = source.indexOf(
        '  const clientOpts = { region, ...(opts.profile && { profile: opts.profile }) };'
      );
      const end = source.indexOf('  try {\n    try {\n      await s3Client.send(');
      expect(start, 'the anchored shape moved — re-point this probe').toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      writeFileSync(
        target,
        source.slice(0, start) +
          '  const clientOpts = {\n' +
          '    ...awsClientDefaults({ profile: opts.profile }),\n' +
          '    region,\n' +
          '    ...(opts.profile && { profile: opts.profile }),\n' +
          '  };\n' +
          '  const s3Client = new S3Client(clientOpts);\n' +
          '  const ecrClient = new ECRClient(clientOpts);\n' +
          source.slice(end)
      );
      const report = buildReport(srcDir, allowList);
      const verdicts = report.gaps
        .filter((gap) => gap.file === 'src/assets/asset-storage.ts')
        .map((gap) => gap.verdict);
      expect(verdicts).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('reports the spread-shared bag restored in the REAL aws-region-resolver.ts', () => {
      // The shape review found after the bare-identifier probe passed, so the
      // regression this pins is the CHECKER's blind spot rather than the
      // provider code's.
      const srcDir = scratchCopyOfSrc();
      const target = join(srcDir, 'utils/aws-region-resolver.ts');
      const source = readFileSync(target, 'utf8');
      const start = source.indexOf('    // `auth` deliberately does NOT carry');
      const end = source.indexOf('    // With no caller-supplied region the client resolves its own;');
      expect(start, 'the anchored shape moved — re-point this probe').toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      writeFileSync(
        target,
        (
          source.slice(0, start) +
          '    const auth = {\n' +
          '      ...awsClientDefaults({ profile: opts.profile }),\n' +
          '      ...(opts.profile && { profile: opts.profile }),\n' +
          '    };\n' +
          '    const explicitRegion = opts.region ?? opts.fallbackRegion;\n' +
          '    let client = new S3Client({ ...auth, region: explicitRegion });\n' +
          source.slice(end)
        ).replace(
          '      client = new S3Client({\n' +
            '        ...awsClientDefaults({ profile: opts.profile }),\n' +
            '        ...auth,\n' +
            '        region: probeRegion,\n' +
            '      });',
          '      client = new S3Client({ ...auth, region: probeRegion });'
        )
      );
      const report = buildReport(srcDir, allowList);
      const verdicts = report.gaps
        .filter((gap) => gap.file === 'src/utils/aws-region-resolver.ts')
        .map((gap) => gap.verdict);
      expect(verdicts).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('the SHIPPED --check consults all of that, not just the exported helpers', () => {
      // Without this, `main()` dropping the call is unobservable, because every
      // assertion above calls `buildReport` directly.
      const srcDir = scratchCopyOfSrc();
      const target = join(srcDir, 'utils/expected-bucket-owner.ts');
      writeFileSync(
        target,
        readFileSync(target, 'utf8').replace('...awsClientDefaults(),\n', '')
      );
      const result = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'scripts/check-aws-client-defaults.ts'),
          '--check',
          `--src-dir=${srcDir}`,
          `--allow-list=${allowListPath}`,
        ],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('expected-bucket-owner.ts');
    });

    it('refuses --src-dir= outside --check, so it can never rewrite anything', () => {
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/check-aws-client-defaults.ts'), '--src-dir=/tmp'],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('only valid with --check');
    });
  });
});
