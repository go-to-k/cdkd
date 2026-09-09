import { describe, it, expect, afterAll } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FLOORS,
  INTEG_ROOT_REL,
  SELF_PROBE_CASES,
  TEMPLATE_REL,
  checkIntegCdkLibFloor,
  compareFloors,
  declaredSpec,
  extractTemplateFloor,
  extractTemplateFloorDetailed,
  parseFloor,
  runSelfProbe,
} from '../../../scripts/check-integ-cdk-lib-floor.js';

/**
 * Enforcement for issue #2839: the `/new-integ` scaffold template's
 * `aws-cdk-lib` floor must not fall behind the integ-fixture corpus. As with
 * `check-verification-depth-rule.ts` and `check-source-control-bytes.ts`, this
 * unit test IS the CI enforcement — there is no `vp run` task and no `ci.yml`
 * step. The script's CLI exists so a human can read the current numbers.
 *
 * See the script header for WHY the rule is "template >= corpus minimum"
 * rather than "all floors equal": dependabot bumps one directory at a time, so
 * an equality fence would red-flag every one of its PRs.
 */

/**
 * Every arm that SPAWNS the checker declares this. Per `.claude/rules/testing.md`
 * a subprocess-spawning test must not ride vitest's 5 s in-process default: the
 * spawn pays Node startup plus type-stripping, which passes locally and times
 * out on a loaded CI runner. Module scope, not inside a describe — arms in
 * EARLIER blocks reference it, and a `const` in a later block is in its TDZ
 * when their `it()` calls are evaluated.
 */
const TIMEOUT = 60_000;

const REPO_ROOT = join(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-integ-cdk-lib-floor.ts');
const REAL_INTEG_ROOT = join(REPO_ROOT, INTEG_ROOT_REL);
const REAL_TEMPLATE = join(REPO_ROOT, TEMPLATE_REL);

/**
 * Every temp dir this file makes, swept in `afterAll`. Each probe copies ~292
 * manifests; without the sweep a run leaves ~21 such trees behind.
 */
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Run the SHIPPED binary, so `main()`, `parseArgs` and the seam are all live. */
function runCli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  // A spawn that never ran reports `status: null`, which satisfies
  // `not.toBe(0)` — a failure indistinguishable from the refusal being tested.
  // Throwing here makes it a loud test error instead.
  if (res.error) throw res.error;
  if (res.status === null) {
    throw new Error(`checker was killed by signal ${String(res.signal)}; stderr: ${res.stderr}`);
  }
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '' };
}

/**
 * A COPY of the real corpus's manifests — the only files this checker reads.
 * Copying the manifests rather than a synthetic tree keeps the mutation probes
 * real-code probes, and never writes to `tests/integration` itself.
 */
function copyRealManifests(): string {
  const dir = scratch('cdkd-floor-integ-');
  for (const entry of readdirSync(REAL_INTEG_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(REAL_INTEG_ROOT, entry.name, 'package.json');
    if (!existsSync(src)) continue;
    mkdirSync(join(dir, entry.name), { recursive: true });
    writeFileSync(join(dir, entry.name, 'package.json'), readFileSync(src, 'utf8'));
  }
  return dir;
}

/** A COPY of the real scaffold template, optionally mutated. */
function copyRealTemplate(mutate?: (text: string) => string): string {
  const dir = scratch('cdkd-floor-tpl-');
  const path = join(dir, 'SKILL.md');
  const text = readFileSync(REAL_TEMPLATE, 'utf8');
  writeFileSync(path, mutate ? mutate(text) : text);
  return path;
}

function setFixtureSpec(integRoot: string, fixture: string, spec: string): void {
  const path = join(integRoot, fixture, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const bucket = manifest.dependencies?.['aws-cdk-lib'] ? 'dependencies' : 'devDependencies';
  const deps = manifest[bucket];
  if (!deps || !deps['aws-cdk-lib']) {
    throw new Error(`${fixture} declares no aws-cdk-lib in ${bucket}; the probe would be vacuous`);
  }
  deps['aws-cdk-lib'] = spec;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('parseFloor / compareFloors', () => {
  it.each(SELF_PROBE_CASES.map((c) => [c.label, c] as const))(
    'self-probe case %s behaves as declared',
    (_label, testCase) => {
      const got = parseFloor(testCase.spec);
      if (testCase.expected === 'refused') {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      const [major, minor, patch] = testCase.floor!;
      expect([got!.major, got!.minor, got!.patch]).toEqual([major, minor, patch]);
      // `.operator` and `.raw` were unasserted for every case but one, so a
      // mutated operator default and a dropped `.trim()` both stayed green.
      expect(got!.operator).toBe(testCase.spec.trim()[0]?.match(/[\^~]/) ? testCase.spec.trim()[0] : '=');
      expect(got!.raw).toBe(testCase.spec.trim());
    },
  );

  // The probe set is the primary defence against a predicate that stopped
  // discriminating, so its SIZE and its negative majority are pinned. A set
  // silently trimmed to its passing cases would leave every other assertion
  // in this file green.
  it('keeps a probe set that is majority-negative', () => {
    expect(SELF_PROBE_CASES.length).toBe(12);
    expect(SELF_PROBE_CASES.filter((c) => c.expected === 'refused').length).toBe(8);
  });

  it('runSelfProbe passes against the shipped classifier', () => {
    expect(runSelfProbe()).toEqual([]);
  });

  it('runSelfProbe honors the force-fail seam', () => {
    const prev = process.env['CDKD_SELF_PROBE_FORCE_FAIL'];
    process.env['CDKD_SELF_PROBE_FORCE_FAIL'] = '1';
    try {
      expect(runSelfProbe()).toEqual([{ label: 'forced', detail: 'CDKD_SELF_PROBE_FORCE_FAIL=1' }]);
    } finally {
      if (prev === undefined) delete process.env['CDKD_SELF_PROBE_FORCE_FAIL'];
      else process.env['CDKD_SELF_PROBE_FORCE_FAIL'] = prev;
    }
  });

  it('orders by the floor, across every segment', () => {
    const f = (s: string) => parseFloor(s)!;
    expect(compareFloors(f('^2.169.0'), f('^2.260.0'))).toBeLessThan(0);
    expect(compareFloors(f('^2.260.0'), f('^2.260.0'))).toBe(0);
    expect(compareFloors(f('^3.0.0'), f('^2.999.999'))).toBeGreaterThan(0);
    expect(compareFloors(f('^2.260.1'), f('^2.260.0'))).toBeGreaterThan(0);
    // The OPERATOR does not change the floor — `~2.260.0` and `^2.260.0` admit
    // the same lowest version, which is the only thing being compared.
    expect(compareFloors(f('~2.260.0'), f('^2.260.0'))).toBe(0);
  });
});

describe('extractTemplateFloor', () => {
  it('reads the floor out of the real scaffold template', () => {
    const floor = extractTemplateFloor(readFileSync(REAL_TEMPLATE, 'utf8'));
    expect(floor).not.toBeNull();
    expect(floor!.operator).toBe('^');
  });

  it('refuses a template with no aws-cdk-lib key', () => {
    expect(extractTemplateFloor('```json\n{ "dependencies": {} }\n```\n')).toBeNull();
  });

  // Two occurrences mean the template grew a second manifest; picking the
  // first would fence whichever happened to come first in the file.
  it('refuses a template declaring the key twice', () => {
    const twice = '"aws-cdk-lib": "^2.260.0"\n...\n"aws-cdk-lib": "^2.169.0"\n';
    expect(extractTemplateFloor(twice)).toBeNull();
  });

  it('refuses a template whose spec has no decidable floor', () => {
    expect(extractTemplateFloor('"aws-cdk-lib": "latest"\n')).toBeNull();
  });

  // One refusal string used to cover all three failures, so "someone added a
  // second example manifest" read as "the key is gone" and pointed the fix at
  // the wrong edit. The counting form is what lets the message discriminate.
  it.each([
    ['none', '```json\n{ "dependencies": {} }\n```\n', 0],
    ['two', '"aws-cdk-lib": "^2.260.0"\n"aws-cdk-lib": "^2.169.0"\n', 2],
    ['one, undecidable', '"aws-cdk-lib": "latest"\n', 1],
  ])('counts the declarations it found: %s', (_label, markdown, expected) => {
    const extraction = extractTemplateFloorDetailed(markdown);
    expect(extraction.matches).toBe(expected);
    expect(extraction.floor).toBeNull();
  });
});

/**
 * The corpus is UNIFORM today (292 x `^2.260.0`), which makes min-SELECTION,
 * dedup and ordering unobservable: swapping `sorted[0]` for the last element
 * still names a `^2.260.0` fixture. Every case here deliberately builds a
 * NON-UNIFORM corpus, so the value under test is not pinned by the fixture.
 */
describe('a non-uniform corpus (the uniform real one cannot see these)', () => {
  function corpus(specs: Record<string, string>): string {
    const dir = scratch('cdkd-floor-mixed-');
    for (const [name, spec] of Object.entries(specs)) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(
        join(dir, name, 'package.json'),
        JSON.stringify({ name, dependencies: { 'aws-cdk-lib': spec } }, null, 2),
      );
    }
    return dir;
  }

  // Pins `sorted[0]`. With a uniform corpus, taking the LAST element instead
  // still printed a `^2.260.0` fixture and every test stayed green.
  it('names the LOWEST fixture and its spec in the below-the-floor message', () => {
    const integRoot = corpus({
      aaa: '^2.300.0',
      mmm: '^2.100.0', // the lowest, and neither first nor last alphabetically
      zzz: '^2.200.0',
    });
    const template = copyRealTemplate((t) =>
      t.replace(/"aws-cdk-lib": "\^2\.\d+\.\d+"/, '"aws-cdk-lib": "^2.050.0"'),
    );
    const report = checkIntegCdkLibFloor({ integRoot, templatePath: template });
    expect(report.minFloor?.raw).toBe('^2.100.0');
    const text = report.violations.join('\n');
    expect(text).toContain('below the lowest floor');
    expect(text).toContain('^2.100.0');
    expect(text).toContain(join(integRoot, 'mmm'));
    // The discriminating half: a max-selection mutant names one of these.
    expect(text).not.toContain(join(integRoot, 'aaa'));
    expect(text).not.toContain(join(integRoot, 'zzz'));
  });

  // Pins `distinctFloors`, which had ZERO references: replacing it with `[]`
  // exited 0 printing "0 distinct".
  it('reports distinct floors, deduped and ascending', () => {
    const integRoot = corpus({
      a: '^2.300.0',
      b: '^2.100.0',
      c: '^2.300.0', // duplicate of a
      d: '^2.200.0',
    });
    const report = checkIntegCdkLibFloor({ integRoot, templatePath: REAL_TEMPLATE });
    expect(report.distinctFloors).toEqual(['^2.100.0', '^2.200.0', '^2.300.0']);
  });

  // The template sitting between two corpus floors must still PASS: the rule
  // is "not below the MINIMUM", not "at or above every fixture".
  it('passes when the template is above the minimum but below other fixtures', () => {
    const integRoot = corpus({ low: '^2.100.0', high: '^2.900.0' });
    const template = copyRealTemplate((t) =>
      t.replace(/"aws-cdk-lib": "\^2\.\d+\.\d+"/, '"aws-cdk-lib": "^2.150.0"'),
    );
    const report = checkIntegCdkLibFloor({ integRoot, templatePath: template });
    expect(report.violations).toEqual([]);
  });
});

describe('declaredSpec refuses what it cannot read', () => {
  it.each([
    ['found', { dependencies: { 'aws-cdk-lib': '^2.1.0' } }, 'found'],
    ['found in devDependencies', { devDependencies: { 'aws-cdk-lib': '^2.1.0' } }, 'found'],
    ['absent', { name: 'x', dependencies: {} }, 'absent'],
    ['no buckets at all', { name: 'x' }, 'absent'],
    // Each of these used to `continue` silently, dropping the fixture out of
    // the minimum -- a loosening, which the header classifies as a refusal.
    ['manifest is an array', [], 'malformed'],
    ['manifest is a string', 'nope', 'malformed'],
    ['dependencies is a string', { dependencies: 'nope' }, 'malformed'],
    ['dependencies is an array', { dependencies: [] }, 'malformed'],
    ['spec is a number', { dependencies: { 'aws-cdk-lib': 2 } }, 'malformed'],
    ['spec is null', { dependencies: { 'aws-cdk-lib': null } }, 'malformed'],
  ])('classifies %s', (_label, manifest, kind) => {
    expect(declaredSpec(manifest).kind).toBe(kind);
  });

  it('surfaces a malformed manifest as a REFUSAL, not a smaller minimum', () => {
    const dir = scratch('cdkd-floor-malformed-');
    mkdirSync(join(dir, 'good'), { recursive: true });
    writeFileSync(
      join(dir, 'good', 'package.json'),
      JSON.stringify({ dependencies: { 'aws-cdk-lib': '^2.300.0' } }),
    );
    mkdirSync(join(dir, 'bad'), { recursive: true });
    writeFileSync(join(dir, 'bad', 'package.json'), JSON.stringify({ dependencies: 'nope' }));
    const report = checkIntegCdkLibFloor({ integRoot: dir, templatePath: REAL_TEMPLATE });
    // The point: `bad` does not silently vanish leaving `good` as the minimum.
    expect(report.refusals.map((r) => r.reason)).toContain('"dependencies" is not a JSON object');
    expect(report.violations.join('\n')).toContain('not a JSON object');
  });
});

describe('the repoRoot seam', () => {
  it('renders labels relative to a CALLER-supplied repoRoot', () => {
    const dir = scratch('cdkd-floor-reporoot-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), '{ "name": "a", ');
    // With repoRoot = dir, the manifest is INSIDE it, so the label is relative.
    const report = checkIntegCdkLibFloor({
      integRoot: dir,
      templatePath: REAL_TEMPLATE,
      repoRoot: dir,
    });
    expect(report.refusals.map((r) => r.where)).toContain(join('a', 'package.json'));
  });

  it('accepts --repo-root= and refuses an empty one', () => {
    const ok = runCli([`--repo-root=${REPO_ROOT}`]);
    expect(ok.status).toBe(0);
    const empty = runCli(['--repo-root=']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('--repo-root= requires a non-empty value');
  }, TIMEOUT);
});

describe('emptiness is a LIBRARY violation, not only a CLI floor', () => {
  it('reports a violation for an existing but empty corpus root', () => {
    const empty = scratch('cdkd-floor-empty-');
    const report = checkIntegCdkLibFloor({ integRoot: empty, templatePath: REAL_TEMPLATE });
    expect(report.fixtures).toBe(0);
    // The regression this pins: it used to return refusals:[] AND violations:[]
    // here, i.e. a fully clean report over a corpus it never read.
    expect(report.violations.join('\n')).toContain('the corpus was not read');
    // ...and it must name the root ACTUALLY checked. A hardcoded
    // `tests/integration` label sent the reader to a directory never read.
    expect(report.violations.join('\n')).toContain(empty);
    expect(report.violations.join('\n')).not.toContain(INTEG_ROOT_REL);
  });

  // The summary INFERS NO CAUSE. Two review rounds went into a conditional
  // trying to say why no floor was found; every version was wrong for some
  // input because it branched on `refusals.length` against `fixtures`, which
  // are different populations (`refusals` also holds the TEMPLATE refusal).
  // These cases pin the replacement: one fact, plus a pointer to the refusals,
  // which are themselves violations.
  it.each([
    ['unparseable manifest', '{ "name": "a", ', 1],
    ['undecidable spec', '{ "dependencies": { "aws-cdk-lib": "*" } }', 1],
    ['no declaration at all', '{ "name": "a", "dependencies": {} }', 0],
  ])('reports the fact without inferring a cause: %s', (_label, body, expectedRefusals) => {
    const dir = scratch('cdkd-floor-nofloor-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), body);
    const report = checkIntegCdkLibFloor({ integRoot: dir, templatePath: REAL_TEMPLATE });
    expect(report.fixtures).toBe(1);
    expect(report.refusals.length).toBe(expectedRefusals);
    const text = report.violations.join('\n');
    expect(text).toContain('none yielded a decidable aws-cdk-lib floor');
    // The retired wordings, each of which was wrong for one of these three.
    expect(text).not.toContain('none of them readable');
    expect(text).not.toContain('none declaring a decidable');
  });

  // The template is a refusal SOURCE that is not a fixture — the input that
  // made every count-comparing version of this message wrong.
  it('stays correct when the TEMPLATE also refuses', () => {
    const dir = scratch('cdkd-floor-bothrefuse-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), '{ "name": "a", ');
    const report = checkIntegCdkLibFloor({
      integRoot: dir,
      templatePath: join(dir, 'no-such-template.md'),
    });
    expect(report.refusals.length).toBe(2); // one manifest + one template
    expect(report.violations.join('\n')).toContain('none yielded a decidable aws-cdk-lib floor');
  });

  // finding 3 of round 4: the path in the BELOW-THE-FLOOR message was
  // unpinned — reverting it to the hardcoded label left the whole suite green.
  // This is the only arm that reaches that site (it needs a non-null minFloor).
  it('names the real corpus AND template paths in the below-the-floor message', () => {
    const integRoot = copyRealManifests();
    const template = copyRealTemplate((t) =>
      t.replace(/"aws-cdk-lib": "\^2\.\d+\.\d+"/, '"aws-cdk-lib": "^2.169.0"'),
    );
    const report = checkIntegCdkLibFloor({ integRoot, templatePath: template });
    const text = report.violations.join('\n');
    expect(text).toContain('below the lowest floor');
    expect(text).toContain(integRoot);
    expect(text).toContain(template);
    expect(text).not.toContain(INTEG_ROOT_REL);
    expect(text).not.toContain(TEMPLATE_REL);
  });

  // finding 2 of round 4: TEMPLATE_REL was hardcoded on the refusal sites too,
  // so a seam template that could not be read was reported at the repo path.
  it('names the real template path when the TEMPLATE itself refuses', () => {
    const integRoot = copyRealManifests();
    const missing = join(scratch('cdkd-floor-notpl-'), 'missing.md');
    const report = checkIntegCdkLibFloor({ integRoot, templatePath: missing });
    const text = [...report.violations, ...report.refusals.map((r) => r.where)].join('\n');
    expect(text).toContain(missing);
    expect(text).not.toContain(TEMPLATE_REL);
  });

  // The default (no-seam) invocation must still print REPO-RELATIVE paths --
  // the label helper derives them, so this pins the house convention rather
  // than an absolute path leaking into CI output.
  it('prints repo-relative paths for the default invocation', () => {
    const res = runCli([`--template=${copyRealTemplate((t) => t.replace(/"aws-cdk-lib": "\^2\.\d+\.\d+"/, '"aws-cdk-lib": "^2.169.0"'))}`]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${INTEG_ROOT_REL}/`);
    expect(res.stderr).not.toContain(REPO_ROOT);
  }, TIMEOUT);

  // finding 1 of round 5: the unreadable-root EARLY RETURN bypassed the label
  // helper, so it printed an absolute path where every sibling site printed a
  // repo-relative one -- falsifying the "every path this file formats"
  // invariant at the one site the conversion missed. No other arm reaches this
  // branch.
  //
  // COUPLING, so a future cleanup does not read this arm as a labelling
  // regression: it passes partly because the early return hand-writes its own
  // `violations` and never runs the refusals-to-violations loop every other
  // site goes through. Routing it through that loop -- the natural tidy-up --
  // puts the refusal's `reason` on stderr, and a `reason` carries Node's
  // errno text with a RAW absolute path by design (see `label()`'s exemption).
  // If this arm reds after such a refactor, narrow the assertion to the
  // violation line; do not start stripping the errno.
  it('labels the unreadable-root message like every other path', () => {
    const res = runCli([`--integ-root=${join(REPO_ROOT, INTEG_ROOT_REL, 'DOES-NOT-EXIST')}`]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${INTEG_ROOT_REL}/DOES-NOT-EXIST`);
    expect(res.stderr).not.toContain(REPO_ROOT);
  }, TIMEOUT);

  // Every path the checker prints must name the root it ACTUALLY read.
  it('never names the hardcoded corpus path when a seam root was given', () => {
    const dir = scratch('cdkd-floor-pathlabel-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), '{ "name": "a", ');
    const report = checkIntegCdkLibFloor({ integRoot: dir, templatePath: REAL_TEMPLATE });
    const text = [...report.violations, ...report.refusals.map((r) => r.where)].join('\n');
    expect(text).toContain(dir);
    expect(text).not.toContain(INTEG_ROOT_REL);
  });
});

describe('the real repository satisfies the fence', () => {
  const report = checkIntegCdkLibFloor({
    integRoot: REAL_INTEG_ROOT,
    templatePath: REAL_TEMPLATE,
  });

  it('reports no refusals and no violations', () => {
    expect(report.refusals).toEqual([]);
    expect(report.violations).toEqual([]);
  });

  // FLOORS pinned to LITERALS. Asserting `report.fixtures > FLOORS.fixtures`
  // instead would be circular — it stays green with every floor zeroed — so
  // the magnitudes below are INDEPENDENT literals, not derived from FLOORS.
  it('pins the declared collapse floors', () => {
    expect(FLOORS.fixtures).toBe(250);
    expect(FLOORS.declaringFixtures).toBe(250);
  });

  it('reads a corpus far larger than the floors (measured 292/292 on 2026-09-09)', () => {
    expect(report.fixtures).toBeGreaterThanOrEqual(280);
    expect(report.declaringFixtures).toBeGreaterThanOrEqual(280);
    // Every fixture carrying a manifest declares aws-cdk-lib; a gap would mean
    // the reader silently stopped seeing one of the two dependency buckets.
    expect(report.declaringFixtures).toBe(report.fixtures);
  });

  it('resolves both sides of the comparison', () => {
    expect(report.minFloor).not.toBeNull();
    expect(report.templateFloor).not.toBeNull();
    expect(compareFloors(report.templateFloor!, report.minFloor!)).toBeGreaterThanOrEqual(0);
  });
});

describe('real-code failure probes (the checker must prove it FAILS)', () => {
  it(
    'control: the unmutated real tree exits 0',
    () => {
      const integRoot = copyRealManifests();
      const template = copyRealTemplate();
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(0);
      expect(res.stderr).toContain('OK');
    },
    TIMEOUT,
  );

  it(
    'fails when the real template is reverted to the pre-#2838 floor',
    () => {
      const integRoot = copyRealManifests();
      const template = copyRealTemplate((t) => t.replace(/"aws-cdk-lib": "\^2\.\d+\.\d+"/, '"aws-cdk-lib": "^2.169.0"'));
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('below the lowest floor');
      expect(res.stderr).toContain('^2.169.0');
    },
    TIMEOUT,
  );

  it(
    'REFUSES rather than passes when the template key cannot be found',
    () => {
      const integRoot = copyRealManifests();
      const template = copyRealTemplate((t) => t.replace('"aws-cdk-lib"', '"aws-cdk-lib-renamed"'));
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('found no `"aws-cdk-lib": "<spec>"` declaration');
    },
    TIMEOUT,
  );

  it(
    'REFUSES a template that grew a SECOND manifest, and says it found two',
    () => {
      const integRoot = copyRealManifests();
      // The realistic future edit: the skill gains a second example block.
      const template = copyRealTemplate((t) => `${t}\n\`\`\`json\n{ "dependencies": { "aws-cdk-lib": "^2.169.0" } }\n\`\`\`\n`);
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(1);
      // Naming the COUNT is the point — the old single string sent the reader
      // looking for a missing key instead of a duplicated one.
      expect(res.stderr).toContain('found 2 `"aws-cdk-lib": "<spec>"` declarations');
    },
    TIMEOUT,
  );

  it(
    'REFUSES rather than skips a fixture manifest that does not parse',
    () => {
      const integRoot = copyRealManifests();
      writeFileSync(join(integRoot, 'basic', 'package.json'), '{ "name": "broken", ');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('manifest does not parse');
    },
    TIMEOUT,
  );

  it(
    'REFUSES rather than skips a spec with no decidable floor',
    () => {
      const integRoot = copyRealManifests();
      setFixtureSpec(integRoot, 'basic', '*');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('no decidable floor');
    },
    TIMEOUT,
  );

  // The dependabot-safety property, and the reason this is not an equality
  // fence. Both directions of corpus spread must pass.
  it(
    'PASSES when one fixture is bumped ahead of the rest (the dependabot case)',
    () => {
      const integRoot = copyRealManifests();
      setFixtureSpec(integRoot, 'basic', '^2.999.0');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'PASSES when one fixture lags the template (the deliberate looseness)',
    () => {
      const integRoot = copyRealManifests();
      setFixtureSpec(integRoot, 'basic', '^2.169.0');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'fails loudly when the corpus root is unreadable',
    () => {
      const res = runCli([
        `--integ-root=${join(tmpdir(), 'cdkd-floor-does-not-exist')}`,
        `--template=${copyRealTemplate()}`,
      ]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('integ root unreadable');
    },
    TIMEOUT,
  );

  // The floors are only consulted by `main()`, so nothing above would notice
  // them going inert. A corpus of two fixtures is internally consistent and
  // violates no rule — only the floor can reject it.
  it(
    'the collapse floors fire on a corpus that shrank',
    () => {
      const full = copyRealManifests();
      const small = scratch('cdkd-floor-small-');
      for (const fixture of ['basic', 'lambda']) {
        mkdirSync(join(small, fixture), { recursive: true });
        writeFileSync(
          join(small, fixture, 'package.json'),
          readFileSync(join(full, fixture, 'package.json'), 'utf8'),
        );
      }
      const res = runCli([`--integ-root=${small}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(1);
      // BOTH floors, not just the first: pinning only `fixtures` left the
      // `declaringFixtures` block deletable with every test in this file green.
      expect(res.stderr).toContain('fixtures read (floor');
      expect(res.stderr).toContain('declared aws-cdk-lib (floor');
    },
    TIMEOUT,
  );

  it(
    'the SPAWNED binary still consults the self-probe',
    () => {
      const res = runCli([], { CDKD_SELF_PROBE_FORCE_FAIL: '1' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('SELF-PROBE FAILED');
    },
    TIMEOUT,
  );

  // A per-case needle, not one alternation for all four: with a shared
  // `/unknown argument|requires a non-empty value/`, deleting the
  // `--integ-root=` branch routes it to `unknown argument` and the case still
  // passes — an arm passing on another arm's message.
  it.each([
    ['unknown flag', '--chekc', 'unknown argument: --chekc'],
    ['empty integ-root', '--integ-root=', '--integ-root= requires a non-empty value'],
    ['empty template', '--template=', '--template= requires a non-empty value'],
    ['positional', 'tests/integration', 'unknown argument: tests/integration'],
  ])(
    'refuses the malformed argument: %s',
    (_label, arg, needle) => {
      const res = runCli([arg]);
      // `not.toBe(0)` alone is satisfied by a spawn that never ran; `runCli`
      // now throws on that, and the exact code plus a needle pins the arm.
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(needle);
    },
    TIMEOUT,
  );

  it(
    'under --json, stdout carries only the report',
    () => {
      const res = runCli(['--json', `--integ-root=${copyRealManifests()}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
      expect(res.stdout).not.toContain('OK —');
    },
    TIMEOUT,
  );
});
