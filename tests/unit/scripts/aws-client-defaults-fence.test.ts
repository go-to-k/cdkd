import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * that names neither the proxy nor the client. With ~160 construction sites and
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
      // Binding to the import ALONE reported 1726 sites against a real
      // population of ~160.
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

    it('flags a BARE `this.opts` argument, not only the spread form', () => {
      // Recorded as a checker bound on PR #2398 and closed here: the argument is
      // neither an identifier nor a literal, so the shared-bag pass returned
      // early while `resolveObjectLiteral`'s PropertyDeclaration arm still
      // classified both sites `defaults-first`.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         class A {
           private readonly opts = { ...awsClientDefaults(), region: 'x' };
           one() { return new S3Client(this.opts); }
           two() { return new ECRClient(this.opts); }
         }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('follows a getter to the once-evaluated field BEHIND it', () => {
      // The second recorded bound: `isEvaluatedOnce` was asked of the top name
      // only, while the defaults-credit recursion is transitive. The getter
      // shares nothing of its own and hands out the same `cached` object every
      // time, so both clients get one handler.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         class A {
           private readonly cached = { ...awsClientDefaults(), region: 'x' };
           private get opts() { return { ...this.cached }; }
           one() { return new S3Client({ ...this.opts }); }
           two() { return new ECRClient({ ...this.opts }); }
         }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('accepts a helper-calling getter whose other spreads carry no defaults', () => {
      // The paired ACCEPT for the recursion above, or "follow the chain" would
      // widen into flagging the correct per-access shape.
      //
      // RETITLED: this used to say "stops following at a getter that calls the
      // helper itself", naming a direct-call stop that no longer exists -- the
      // guard was removed because it was fail-open, unpinned, and wrong for the
      // shape the reject case below now covers. What this pins is what it always
      // measured: the walk finds no shared binding here because a bare helper
      // call has no binding name, and `this.plain` -- a once-evaluated bag, so
      // the walk DOES follow it -- carries no defaults. The spread is present on
      // purpose: without it the title spoke of "other spreads" the fixture did
      // not have, which is the same over-claim in miniature. The SITE literals
      // do not call the helper because, when this fixture was reshaped in an
      // earlier round, a site-level call WOULD have exited at the
      // argument-level exemption and `sharedRoot` would never have run. That
      // exemption is gone as of this change, so the shape no longer needs the
      // defense -- a site-level call is harmless either way, which the
      // argument-level reject fixture below demonstrates by carrying one and
      // still being flagged.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         class A {
           private readonly plain = { region: 'x' };
           private get opts() { return { ...awsClientDefaults(), ...this.plain }; }
           one() { return new S3Client({ ...this.opts }); }
           two() { return new ECRClient({ ...this.opts }); }
         }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first', 'defaults-first']);
    });

    it('flags a helper-calling getter that also spreads a defaults-bearing bag', () => {
      // The shape the removed guard got WRONG. The getter calls the helper, so
      // each access starts with a fresh handler -- and then `...this.cached`
      // spreads a once-evaluated bag over it, and later-key-wins hands both
      // clients the SAME `requestHandler`. The guard reported `defaults-first`
      // here; nothing in the tree writes it, which is why it went unnoticed
      // until the guard was mutated and no test redded.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         class A {
           private readonly cached = { ...awsClientDefaults(), region: 'x' };
           private get opts() { return { ...awsClientDefaults(), ...this.cached }; }
           one() { return new S3Client({ ...this.opts }); }
           two() { return new ECRClient({ ...this.opts }); }
         }`
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

    it('flags a defaults-bearing bag spread AFTER a direct call at the site', () => {
      // The argument-level twin of the getter-arm shape, and the reason the
      // "a direct call exempts the literal" rule was removed: the call makes a
      // fresh handler, then `...shared` puts the once-evaluated bag's handler
      // back on top by later-key-wins, so both clients get the same one.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         const shared = { ...awsClientDefaults(), region: 'x' };
         const a = new S3Client({ ...awsClientDefaults(), ...shared });
         const b = new ECRClient({ ...awsClientDefaults(), ...shared });`
      );
      expect(found.map((s) => s.verdict)).toEqual(['shared-defaults', 'shared-defaults']);
    });

    it('accepts the prescribed form — a defaults-FREE bag spread after the call', () => {
      // The paired ACCEPT, and what pins that the 158 real sites never leaned on
      // the removed exemption: this is clean because `plain` resolves to nothing
      // defaults-bearing, not because the direct call short-circuits anything.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         const plain = { region: 'x' };
         const a = new S3Client({ ...awsClientDefaults(), ...plain });
         const b = new ECRClient({ ...awsClientDefaults(), ...plain });`
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

    it('sees a DESTRUCTURED dynamic import — the hole that made the sweep incomplete', () => {
      // `sdkClientIdentifiers` read only top-level `ImportDeclaration`s, so this
      // shape contributed no identifiers and the site got no verdict at all --
      // not a gap, nothing. 17 real sites sat behind that, including
      // `deploy.ts`'s `GetCallerIdentity` on every deploy.
      const found = sites(
        `const { STSClient } = await import('@aws-sdk/client-sts');
         const c = new STSClient({ region: 'x' });`
      );
      expect(found.map((s) => s.verdict)).toEqual(['missing']);
    });

    it('accepts a migrated destructured dynamic import', () => {
      const found = sites(
        `const { STSClient } = await import('@aws-sdk/client-sts');
         const c = new STSClient({ ...awsClientDefaults(), region: 'x' });`
      );
      expect(found.map((s) => s.verdict)).toEqual(['defaults-first']);
    });

    it('follows an ALIAS through a destructured dynamic import', () => {
      // The suffix is tested on the EXPORTED name and the LOCAL name recorded,
      // same as the static arm. Handled from the start but unpinned, so the
      // branch could be lost without a test noticing.
      const found = sites(
        `const { S3Client: Bucket } = await import('@aws-sdk/client-s3');
         const c = new Bucket({ region: 'x' });`
      );
      expect(found.map((s) => s.verdict)).toEqual(['missing']);
    });

    it('sees the `new mod.XClient()` form of a dynamic namespace import', () => {
      // Six real sites in `httpv2-service-integration.ts` are written this way,
      // and the construction is a property access rather than an identifier, so
      // it needs BOTH halves: the namespace binding and the `new ns.X` arm.
      const found = sites(
        `const mod = await import('@aws-sdk/client-sns');
         const c = new mod.SNSClient({ region: 'x' });`
      );
      expect(found.map((s) => s.verdict)).toEqual(['missing']);
    });

    it('does not treat a NON-SDK module binding as a client namespace', () => {
      // The paired REFUSAL: `new helpers.FooClient()` over a local module must
      // not be swept in just because the name ends in Client.
      const found = sites(
        `const helpers = await import('./helpers.js');
         const c = new helpers.FooClient({ region: 'x' });`
      );
      expect(found).toEqual([]);
    });

    it('counts two same-named single-use local bags as shared — fail-closed, by design', () => {
      // The reject side of the documented file-global `uses` polarity, which
      // was closed by comment only. Neither function shares anything, and both
      // flip: a false accusation costs a reviewer one look, a miss ships the
      // correctness bug.
      const found = sites(
        `${IMPORT}import { ECRClient } from '@aws-sdk/client-ecr';
         function one() { const opts = { ...awsClientDefaults() }; return new S3Client(opts); }
         function two() { const opts = { ...awsClientDefaults() }; return new ECRClient(opts); }`
      );
      expect(found.map((s) => s.verdict)).toEqual(['shared-defaults', 'shared-defaults']);
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
      // Measured at the sweep: 158 sites across 79 files. The floors are ROUND
      // NUMBERS below that on purpose -- they catch a collapsed parse, and a
      // literal count here would just be a fourth place for the number to drift.
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

  describe('the detected population IS the real one', () => {
    /**
     * The reconciliation that would have caught this checker's own blind spot,
     * turned into an assertion.
     *
     * PR 2465 shipped a review round claiming "there is no version of this
     * change that forgets one and still passes" on the strength of a green run
     * and an empty allow-list. That was false: `sdkClientIdentifiers` read only
     * top-level `ImportDeclaration`s, so 18 destructured `await import(...)`
     * sites had no verdict at all -- 17 of them unmigrated, `deploy.ts`'s
     * `GetCallerIdentity` among those -- plus 6 more in the namespace form.
     * (The two counts differ by `config-loader.ts`, migrated by hand in the
     * previous PR, so it had no verdict while already being correct.)
     *
     * A green run tells you about the population the detector can SEE, and
     * nothing about the size of that population.
     *
     * So the population is checked against a method that is wrong in DIFFERENT
     * ways: a text scan for the construction itself. Every hit it finds must
     * either be a site the AST walk also found, or a line of prose. A new
     * binding shape the AST misses lands here as an unexplained hit.
     */
    const CONSTRUCTION = /new\s+(?:[A-Za-z0-9_]+\.)?[A-Za-z0-9]+Client\s*\(/;

    function textScan(): { file: string; line: number; text: string }[] {
      const out: { file: string; line: number; text: string }[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
              if (CONSTRUCTION.test(text)) out.push({ file: full, line: i + 1, text });
            });
          }
        }
      };
      walk(join(repoRoot, 'src'));
      return out;
    }

    /**
     * BOTH cases below read the SAME immutable tree, and each of them used to
     * pay for it twice over: `textScan()` walks all 334 `src/**` files (10.8 MB)
     * and was called twice per case, and `findClientSites` -- a full TypeScript
     * parse -- ran once per HIT (171) rather than once per distinct FILE (83),
     * because `textScan().map(...)` parses before `new Map` dedupes and the
     * SIZE case loops hits directly. Measured on a 12-core host: 751 + 631 ms
     * as written against 237 ms for one shared scan and one parse per file.
     * That is what put these two cases at 3.7-4.1 s of the 5 s budget under
     * partial parallel load and made them flake on CI (issue #2491).
     *
     * SCOPED TO THIS DESCRIBE ON PURPOSE. The `regression probes against the
     * REAL tree` block below rewrites a scratch COPY of `src/` and re-reports
     * it; a module-level cache keyed by absolute path would be consulted there
     * too and could hand a probe its PRE-MUTATION verdict, which is a probe
     * that passes without testing anything. These two cases never mutate, so
     * sharing between them changes no verdict.
     */
    let scanned: ReturnType<typeof textScan> | undefined;
    const scanOnce = (): ReturnType<typeof textScan> => (scanned ??= textScan());
    const siteCache = new Map<string, ReturnType<typeof findClientSites>>();
    function sitesOnce(file: string): ReturnType<typeof findClientSites> {
      let found = siteCache.get(file);
      if (found === undefined) {
        found = findClientSites(file, readFileSync(file, 'utf8'));
        siteCache.set(file, found);
      }
      return found;
    }

    it('finds no construction the AST walk did not, except in prose', () => {
      const detected = new Set<string>();
      for (const hit of scanOnce()) {
        for (const site of sitesOnce(hit.file)) detected.add(`${hit.file}:${site.line}`);
      }

      const unexplained = scanOnce().filter(
        (hit) =>
          !detected.has(`${hit.file}:${hit.line}`) &&
          // A construction NAMED in a comment is not a construction.
          !/^\s*(\*|\/\/)/.test(hit.text)
      );

      expect(
        unexplained.map((u) => `${u.file.replace(repoRoot + '/', '')}:${u.line}`),
        'a text scan found a client construction the AST walk has no verdict for. Either it ' +
          'is a binding shape `sdkClientIdentifiers` does not know (teach it, and add an ' +
          'accept/reject pair), or the line is prose (then it needs no action but this list ' +
          'needs re-reading). Do NOT widen the comment filter to make this pass.'
      ).toEqual([]);
    });

    it('the two methods agree on the SIZE, not just on the absence of surprises', () => {
      // The floor's other direction: if the AST walk started reporting sites the
      // text scan cannot see, one of them is wrong and it is worth knowing.
      const scannedLines = new Set(scanOnce().map((h) => `${h.file}:${h.line}`));
      const detectedNotScanned: string[] = [];
      for (const hit of scanOnce()) {
        for (const site of sitesOnce(hit.file)) {
          if (!scannedLines.has(`${hit.file}:${site.line}`)) {
            detectedNotScanned.push(`${hit.file}:${site.line}`);
          }
        }
      }
      expect([...new Set(detectedNotScanned)]).toEqual([]);
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
      //
      // The victim is SYNTHESISED rather than read from the real list, which is
      // now empty. Taking `allowList.files[0]` made this case die with an
      // `undefined` index the moment the sweep finished -- a probe that stops
      // running exactly when the thing it guards starts mattering.
      const srcDir = scratchCopyOfSrc();
      const victim = 'src/utils/expected-bucket-owner.ts';
      expect(
        allowList.files,
        'the victim must NOT be genuinely allow-listed, or this proves nothing'
      ).not.toContain(victim);
      const report = buildReport(srcDir, { files: [victim] });
      expect(report.staleAllowList).toContain(victim);
    });

    it('is EMPTY, which is the endpoint the ratchet was pointed at', () => {
      // Every other assertion about the list passes vacuously once it is empty
      // (sorted, deduplicated, names only existing files), so without this the
      // suite would stop noticing an entry being added back. Re-adding one is a
      // decision that needs a rationale in the JSON comment and a reviewer.
      expect(
        allowList.files,
        'a file was re-added to the allow-list — say why in the $comment and in the PR'
      ).toEqual([]);
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
  // FILE-LEVEL, not on the two cases the flake report named (issue #2491).
  // Eight of the 48 cases here read the REAL tree, and the memoisation above
  // only helps the two that were WASTING work. The six `regression probes
  // against the REAL tree` cases each `cpSync` the whole 10.8 MB `src/` tree
  // and then run `buildReport` over all 334 files, which is legitimately about
  // a second apiece and does not get cheaper by rewriting; measured under
  // partial parallel load they sit at 1.5-2.8 s, the largest within 12% of the
  // two named cases when idle. A timeout on the named pair alone would move
  // the next flake one test over.
  //
  // 15 s rather than the 30 s the report suggested: after the memoisation the
  // whole file runs in about 2-3 s, so this is ~10x headroom and still fails
  // loudly. 30 s would silently absorb another 6x regression in a file whose
  // entire job is to fail loudly. The repo already spells per-test budgets as
  // `}, 15_000)` and sets no global `testTimeout`, so this adds no mechanism.
}, 15_000);
