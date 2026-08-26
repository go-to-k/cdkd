/**
 * Issue #2178 — the pre-stringify secret-mask critic.
 *
 * The real-tree sweep below is a gate in its own right, and the
 * `--providers-dir=` seam is how every failure probe is taken, so a probe never
 * writes to `src/`. The critic is ALSO wired as a CI step
 * (`vp run audit:provider-secret-mask:check`), which the last block pins in
 * BOTH directions so neither half of the wiring can silently disappear.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  analyzeFile,
  auditExemptions,
  buildReport,
  main,
  runSelfProbes,
  type SelfProbeOutcome,
  type SiteVerdict,
} from '../../../scripts/check-provider-secret-mask.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-provider-secret-mask.ts');
const PROVIDERS_DIR = join(REPO_ROOT, 'src/provisioning/providers');
const COMPOSITE_ID = join(REPO_ROOT, 'src/provisioning/composite-id.ts');
const SPAWN_TIMEOUT_MS = 120_000;

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * A throwaway COPY of the real providers tree plus its `composite-id.ts`
 * sibling, laid out the way `buildReport` resolves the extra file.
 */
function copyTree(): string {
  const root = join(scratch('cdkd-mask-probe-'), 'provisioning');
  cpSync(PROVIDERS_DIR, join(root, 'providers'), { recursive: true });
  cpSync(COMPOSITE_ID, join(root, 'composite-id.ts'));
  return join(root, 'providers');
}

/** A minimal well-formed tree, so a probe can trip ONE floor rather than all. */
function emptyTree(padFiles: number): string {
  const root = join(scratch('cdkd-mask-empty-'), 'provisioning');
  const providers = join(root, 'providers');
  cpSync(COMPOSITE_ID, join(root, 'composite-id.ts'));
  writeFileSync(join(root, '.keep'), '');
  rmSync(join(root, '.keep'));
  // `providers/` has to exist before anything is written into it.
  cpSync(join(PROVIDERS_DIR, 'sns-topic-provider.ts'), join(providers, 'seed.ts'));
  rmSync(join(providers, 'seed.ts'));
  for (let i = 0; i < padFiles; i += 1) {
    writeFileSync(join(providers, `pad-${i}.ts`), `export const pad${i} = ${i};\n`);
  }
  return providers;
}

function mutate(dir: string, file: string, from: string, to: string): void {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  // A probe anchored on a non-unique string proves nothing about WHICH site
  // moved, so uniqueness is asserted rather than assumed.
  const occurrences = text.split(from).length - 1;
  expect(occurrences, `probe anchor is not unique in ${file}`).toBe(1);
  writeFileSync(path, text.replace(from, to));
}

function mutateAll(dir: string, file: string, from: string, to: string, expected: number): void {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  expect(text.split(from).length - 1, `probe anchor count in ${file}`).toBe(expected);
  writeFileSync(path, text.split(from).join(to));
}

function run(
  args: readonly string[],
  script = SCRIPT
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync('node', ['--experimental-strip-types', script, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    status: proc.status,
    stdout: String(proc.stdout ?? ''),
    stderr: String(proc.stderr ?? ''),
  };
}

function runCheck(dir: string): { status: number | null; stderr: string; stdout: string } {
  return run([`--providers-dir=${dir}`]);
}

/** Verdicts `analyzeFile` gives a synthetic source. */
function verdicts(source: string): SiteVerdict[] {
  return analyzeFile('probe/case.ts', source).sites.map((site) => site.verdict);
}

const MASK_IMPORT = `import { maskDeep, maskerOrIdentity } from '../masked-retry-logger.js';`;

// ---------------------------------------------------------------------------

describe('provider secret-mask critic — classifier', () => {
  it('passes its own self-probes, and reports how many it actually ran', () => {
    const outcome = runSelfProbes();
    expect(outcome.failures).toEqual([]);
    // The count must come from the LOOP, not from `SELF_PROBES.length` — a
    // constant would report a healthy number for a runner that evaluated
    // nothing, which is the degradation MIN_SELF_PROBES exists to catch.
    expect(outcome.ran).toBeGreaterThanOrEqual(40);
  });

  it('accepts the direct wrap', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        function f(v: unknown, maskSecrets: SecretMasker) {
          throw new Error(\`got \${JSON.stringify(maskDeep(v, maskSecrets))}\`);
        }`)
    ).toEqual(['masked']);
  });

  it('accepts a mask applied UPSTREAM through a const binding', () => {
    // The `cloudfront-distribution-provider.ts` shape. A naive
    // "wrapped inside the stringify" rule reds this, which is what makes the
    // dataflow walk the point of this critic rather than a refinement of it.
    expect(
      verdicts(`function f(config: Record<string, unknown>, maskSecrets: SecretMasker) {
          const comment = typeof config['C'] === 'string' ? maskSecrets(config['C']) : '';
          return \`comment \${JSON.stringify(comment)}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('accepts a mask applied inside an upstream .map() callback', () => {
    // The `asg-provider.ts` shape: each element masked, then the ARRAY
    // stringified.
    expect(
      verdicts(`function f(expected: string[], maskSecrets: SecretMasker) {
          const sorted = [...expected].sort().map((a) => maskSecrets(a));
          return \`expected=\${JSON.stringify(sorted)}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('refuses the pre-map array even when the mapped copy is masked', () => {
    // The mirror of the case above, and the reason `.map` is not in the
    // mask-PRESERVING method set: masking a copy says nothing about the
    // original.
    expect(
      verdicts(`function f(expected: string[], maskSecrets: SecretMasker) {
          const masked = expected.map((a) => maskSecrets(a));
          use(masked);
          return \`expected=\${JSON.stringify(expected)}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('refuses a .map() whose callback does not mask', () => {
    expect(
      verdicts(`function f(xs: string[]) {
          const shaped = xs.map((a) => a.trim());
          return \`xs=\${JSON.stringify(shaped)}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('resolves an ALIASED maskDeep import', () => {
    expect(
      verdicts(`import { maskDeep as deepMask } from '../masked-retry-logger.js';
        function f(v: unknown, maskSecrets: SecretMasker) {
          return \`got \${JSON.stringify(deepMask(v, maskSecrets))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('refuses a same-named local helper that is NOT the shared walk', () => {
    // Provenance, not spelling: a file-local `maskDeep` with no import from
    // `masked-retry-logger.js` is not the capability the contract threads.
    expect(
      verdicts(`function maskDeep(v: unknown) { return v; }
        function f(v: unknown) {
          return \`got \${JSON.stringify(maskDeep(v))}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('derives a masker from a SecretMasker / MaskerFn type annotation', () => {
    expect(
      verdicts(`function f(v: string, mask: MaskerFn) {
          return \`got \${JSON.stringify(mask(v))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('derives a masker from maskerOrIdentity and from a context read', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        function a(v: string, context?: CreateContext) {
          const m = maskerOrIdentity(context?.maskSecrets);
          return \`a \${JSON.stringify(m(v))}\`;
        }
        function b(v: string, context?: CreateContext) {
          const m = context?.maskSecrets ?? ((t: string) => t);
          return \`b \${JSON.stringify(m(v))}\`;
        }`)
    ).toEqual(['masked', 'masked']);
  });

  it('grows the masker set through a local WRAPPER, to a fixpoint', () => {
    // Two hops: `outer` wraps `inner`, `inner` wraps the shared walk.
    expect(
      verdicts(`${MASK_IMPORT}
        function inner(v: unknown, maskSecrets: SecretMasker) { return maskDeep(v, maskSecrets); }
        function f(v: unknown, maskSecrets: SecretMasker) {
          const outer = (x: unknown): unknown => inner(x, maskSecrets);
          return \`got \${JSON.stringify(outer(v))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('refuses a wrapper that masks a DIFFERENT parameter than the one it takes', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        function bogus(v: unknown, other: unknown, maskSecrets: SecretMasker) {
          return maskDeep(other, maskSecrets);
        }
        function f(v: unknown, o: unknown, maskSecrets: SecretMasker) {
          return \`got \${JSON.stringify(bogus(v, o, maskSecrets))}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('grows the masker set through a helper PARAMETER every caller threads', () => {
    // The `sns-topic-provider.ts:1303` shape.
    expect(
      verdicts(`${MASK_IMPORT}
        function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
          throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
        }
        function caller(v: unknown, maskSecrets: SecretMasker) {
          refuse(v, (x: unknown) => maskDeep(x, maskSecrets));
        }`)
    ).toEqual(['masked']);
  });

  it('refuses the same helper as soon as ONE caller omits the masker', () => {
    // Strictness is what stops the first caller's diligence from covering a
    // later one — the default is identity, so an omitted argument is a real
    // disclosure.
    expect(
      verdicts(`${MASK_IMPORT}
        function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
          throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
        }
        function a(v: unknown, maskSecrets: SecretMasker) {
          refuse(v, (x: unknown) => maskDeep(x, maskSecrets));
        }
        function b(v: unknown) { refuse(v); }`)
    ).toEqual(['raw']);
  });

  it('refuses a helper parameter on an EXPORTED function, whose callers it cannot see', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        export function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
          throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
        }
        function caller(v: unknown, maskSecrets: SecretMasker) {
          refuse(v, (x: unknown) => maskDeep(x, maskSecrets));
        }`)
    ).toEqual(['raw']);
  });

  it('scopes a threaded parameter to its OWN function', () => {
    // A same-named parameter in a sibling function must not borrow the
    // masker-ness established for this one.
    expect(
      verdicts(`${MASK_IMPORT}
        function refuse(input: unknown, maskValue: (v: unknown) => unknown) {
          throw new Error(\`a \${JSON.stringify(maskValue(input))}\`);
        }
        function other(input: unknown, maskValue: (v: unknown) => unknown) {
          throw new Error(\`b \${JSON.stringify(input)}\`);
        }
        function caller(v: unknown, maskSecrets: SecretMasker) {
          refuse(v, (x: unknown) => maskDeep(x, maskSecrets));
          other(v, (x: unknown) => maskDeep(x, maskSecrets));
        }`)
    ).toEqual(['masked', 'raw']);
  });

  it('refuses a bare parameter, a bag read and a JSON.parse result', () => {
    expect(
      verdicts(`function a(v: unknown) { return \`\${JSON.stringify(v)}\`; }
        function b(properties: Record<string, unknown>) {
          return \`\${JSON.stringify(properties['Value'])}\`;
        }
        function c(text: string) {
          const parsed: unknown = JSON.parse(text);
          return \`\${JSON.stringify(parsed)}\`;
        }`)
    ).toEqual(['raw', 'raw', 'raw']);
  });

  it('refuses an expression that merely MENTIONS a masker', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        function f(v: unknown, other: unknown, maskSecrets: SecretMasker) {
          const masked = maskDeep(other, maskSecrets);
          use(masked);
          return \`got \${JSON.stringify(v)}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('requires EVERY arm of a composition, not just one', () => {
    expect(
      verdicts(`function f(a: string, b: string, live: Record<string, unknown>, m: MaskerFn) {
          const cond = a === '' ? m(a) : b;
          return \`x=\${JSON.stringify(cond)} y=\${JSON.stringify({ p: m(a), q: live['B'] })} ` +
        `z=\${JSON.stringify([m(a), b])}\`;
        }`)
    ).toEqual(['raw', 'raw', 'raw']);
  });

  it('accepts a composition when every arm is accepted', () => {
    expect(
      verdicts(`function f(a: string, m: MaskerFn) {
          const cond = a === '' ? m(a) : '';
          return \`x=\${JSON.stringify(cond)} y=\${JSON.stringify({ p: m(a), q: 'lit' })} ` +
        `z=\${JSON.stringify([m(a), 1])}\`;
        }`)
    ).toEqual(['masked', 'masked', 'masked']);
  });

  it('does not credit a SIBLING block’s masked binding', () => {
    expect(
      verdicts(`function f(v: unknown, m: MaskerFn) {
          { const shown = m('x'); use(shown); }
          return \`got \${JSON.stringify(shown)}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('classifies two sites on ONE line independently', () => {
    // Per-SITE, not per-file and not per-line: a file-wide OR is satisfied by
    // any accepted substring elsewhere, which is exactly how four handlers can
    // lose their only mask while the fence stays green.
    expect(
      verdicts(`function f(a: string[], b: string[], m: MaskerFn) {
          const masked = a.map((x) => m(x));
          return \`x=\${JSON.stringify(masked)} y=\${JSON.stringify(b)}\`;
        }`)
    ).toEqual(['masked', 'raw']);
  });

  it('finds a MULTI-LINE site, which a line regex misses', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        function f(v: unknown, m: MaskerFn) {
          return \`got \${JSON.stringify(
            maskDeep(v, m)
          )} and \${JSON.stringify(
            v
          )}\`;
        }`)
    ).toEqual(['masked', 'raw']);
  });

  it('does not treat a NON-interpolated JSON.stringify as a site', () => {
    // 289 such calls exist under the scanned tree (comparison keys and wire
    // serialization). Scoping the population to MESSAGE interpolation is what
    // keeps this a secret-disclosure fence rather than a stringify census.
    expect(verdicts(`function f(v: unknown) { return JSON.stringify(v); }`)).toEqual([]);
  });

  it('refuses an IDENTITY masker, in every spelling', () => {
    // Issue #2007: a masker that fences nothing is WORSE than no masker,
    // because its presence stops the next author looking. Before review the
    // classifier accepted all three of these, so a genuinely raw site could be
    // silenced with `maskerOrIdentity(undefined)` while COUNTING toward
    // MIN_MASKED_SITES.
    expect(
      verdicts(`${MASK_IMPORT}
        const A: MaskerFn = maskerOrIdentity(undefined);
        const B: MaskerFn = maskerOrIdentity();
        function f(v: unknown) {
          const c: MaskerFn = (t) => t;
          return \`a=\${JSON.stringify(A(v))} b=\${JSON.stringify(B(v))} ` +
        `c=\${JSON.stringify(c(v))}\`;
        }`)
    ).toEqual(['raw', 'raw', 'raw']);
  });

  it('keeps the CONTRACT default a mask, since its left arm IS the capability', () => {
    // The mirror of the refusal above, and why the fold requires EVERY arm to
    // be identity: `context?.maskSecrets ?? ((t) => t)` is the contract's own
    // absent-means-unmasked spelling and appears in ~10 provider files. A
    // refusal keyed on "an identity appears anywhere" would red all of them.
    expect(
      verdicts(`function f(v: string, context?: CreateContext) {
          const mask: MaskerFn = context?.maskSecrets ?? ((t: string) => t);
          return \`got \${JSON.stringify(mask(v))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('does NOT refuse a PARAMETER whose DEFAULT is the identity', () => {
    // A parameter's identity default says nothing about what callers pass —
    // that question belongs to the every-call-site rule. The tree carries
    // eight `maskSecrets: SecretMasker = (text) => text` parameters, so
    // extending the binding refusal to parameters would red real code.
    expect(
      verdicts(`${MASK_IMPORT}
        function refuse(input: unknown, maskSecrets: SecretMasker = (text) => text) {
          throw new Error(\`got \${JSON.stringify(maskSecrets(input))}\`);
        }`)
    ).toEqual(['masked']);
  });

  it('refuses an IDENTITY handed to the shared walk, in four spellings', () => {
    // The position the first cut of the identity rule MISSED, and the one the
    // codebase actually writes: `maskDeep(value, mask)`. Refusing the identity
    // NAME as a derivation root is inert here because the CALLEE is a root on
    // its own. Measured before the fix, on the real tree via `--providers-dir=`:
    // 41 sites / 37 masked became 42 / 38 at exit 0, with the derived
    // masker-name count UNCHANGED at 108 -- which is how the receipt located
    // the hole in the ARGUMENT rather than in the derivation.
    //
    // Two of these four are spellings the fix was NOT designed around (the
    // inline arrow, which declares no binding to refuse, and the two-hop
    // alias). A fence calibrated only against the mutation its author pictured
    // is blind to the one the next contributor writes.
    expect(
      verdicts(`${MASK_IMPORT}
        const IDENT: MaskerFn = maskerOrIdentity(undefined);
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, IDENT))}\`;
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        const IDENT = maskerOrIdentity(undefined);
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, IDENT))}\`;
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, (t) => t))}\`;
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        const HOP_A: MaskerFn = maskerOrIdentity(undefined);
        const HOP_B = HOP_A;
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, HOP_B))}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('refuses ANY expression in masker position that is not the capability', () => {
    // POLARITY, not spellings. The first two rounds of this rule were a
    // DENY-list of identity spellings, and each round was locally correct while
    // moving the hole one spelling over: a hand-rolled `function` declaration
    // passed all of them, and so did a cast and an object property. The set of
    // ways to write a no-op is unbounded, so the argument position accepts only
    // the derived capability and refuses the rest by default.
    expect(
      verdicts(`${MASK_IMPORT}
        function noMask(value: unknown): unknown { return value; }
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, noMask))}\`;
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, ((t) => t) as MaskerFn))}\`;
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        const bag = { m: (t: unknown) => t };
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, bag.m))}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('keeps a helper that FORWARDS a received masker green', () => {
    // The control the refusals need: an allow-list that reds this would red the
    // real tree, which is how a fence gets argued down instead of fixed.
    expect(
      verdicts(`${MASK_IMPORT}
        function forward(value: unknown, mask: MaskerFn) {
          return \`got \${JSON.stringify(maskDeep(value, mask))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('KNOWN BOUND: believes a no-op DECLARED to be the capability', () => {
    // Pinned rather than left to be discovered. This critic is syntactic, so
    // the declaration is the only evidence it has. Both shapes are MEASURED
    // green; the value of the allow-list is that the DEFAULT flipped, so
    // silencing a site now takes a deliberate mis-declaration rather than any
    // of the unbounded ways to spell a no-op. If either of these ever goes
    // `raw`, the bound closed and the header's KNOWN BOUND (4) must change.
    expect(
      verdicts(`${MASK_IMPORT}
        function noMask(value: unknown): unknown { return value; }
        const FAKE: MaskerFn = noMask;
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, FAKE))}\`;
        }`)
    ).toEqual(['masked']);
    expect(
      verdicts(`${MASK_IMPORT}
        const bag = { maskSecrets: (t: unknown) => t };
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, bag.maskSecrets))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('still accepts the shared walk handed a REAL capability', () => {
    // The control the four above need: without it the rule could refuse EVERY
    // `maskDeep(...)` call and all four would still pass, which would red the
    // whole tree instead of fencing it.
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>, context?: CreateContext) {
          return \`got \${JSON.stringify(maskDeep(p, maskerOrIdentity(context?.maskSecrets)))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('resolves the module SPECIFIER rather than suffix-matching it', () => {
    // `endsWith('masked-retry-logger.js')` accepts `./my-masked-retry-logger.js`
    // — a different module, whose `maskDeep` would inherit the shared walk's
    // provenance on a substring match.
    expect(
      verdicts(`import { maskDeep } from './my-masked-retry-logger.js';
        function f(v: unknown, m: SecretMasker) {
          return \`got \${JSON.stringify(maskDeep(v, m))}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('accepts a mask-PRESERVING method chain and refuses it over a raw receiver', () => {
    // The pair fences one accept arm in both directions: emptying
    // MASK_PRESERVING_METHODS kills the first, degrading it to `return true`
    // kills the second. The arm shipped with NEITHER.
    expect(
      verdicts(`function f(xs: string[], m: MaskerFn) {
          const masked = xs.map((x) => m(x));
          return \`got \${JSON.stringify(masked.filter(Boolean).sort().slice(0, 3))}\`;
        }`)
    ).toEqual(['masked']);
    expect(
      verdicts(`function f(xs: string[]) {
          return \`got \${JSON.stringify(xs.filter(Boolean).sort())}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('accepts a `+` / `&&` composition only when EVERY operand is masked', () => {
    expect(
      verdicts(`function f(a: string, b: string, m: MaskerFn) {
          return \`x=\${JSON.stringify(m(a) + m(b))} y=\${JSON.stringify(m(a) && m(b))}\`;
        }`)
    ).toEqual(['masked', 'masked']);
    expect(
      verdicts(`function f(a: string, b: string, m: MaskerFn) {
          return \`x=\${JSON.stringify(m(a) + b)} y=\${JSON.stringify(b && m(a))}\`;
        }`)
    ).toEqual(['raw', 'raw']);
  });

  it('accepts a TEMPLATE only when every span is masked', () => {
    expect(
      verdicts(`function f(a: string, m: MaskerFn) {
          return \`got \${JSON.stringify(\`[\${m(a)}]\`)}\`;
        }`)
    ).toEqual(['masked']);
    expect(
      verdicts(`function f(a: string, b: string, m: MaskerFn) {
          return \`got \${JSON.stringify(\`[\${m(a)}:\${b}]\`)}\`;
        }`)
    ).toEqual(['raw']);
  });

  it('COUNTS a string-CONCAT stringify without classifying it as a site', () => {
    // KNOWN BOUND (1), made measurable. The counter is what keeps the fence
    // from going inert with the same byte-identical green the bound describes.
    const analyzed = analyzeFile(
      'probe/concat.ts',
      `function f(v: unknown) { throw new Error('got ' + JSON.stringify(v)); }`
    );
    expect(analyzed.sites).toEqual([]);
    expect(analyzed.concatSites).toBe(1);
  });

  it('hard-fails a file that does not parse rather than reporting zero sites', () => {
    expect(() => analyzeFile('probe/broken.ts', 'function f( {')).toThrow(/failed to parse/);
  });
});

// ---------------------------------------------------------------------------

describe('provider secret-mask critic — the real tree', () => {
  const report = buildReport(PROVIDERS_DIR);

  it('leaves no raw site', () => {
    const raw = report.siteList
      .filter((site) => site.verdict === 'raw')
      .map((site) => `${site.file}:${site.line} ${site.expression}`);
    expect(raw).toEqual([]);
  });

  it('measures the population the issue recorded', () => {
    // Issue #2178 measured 40 interpolated sites with a line-based scan. The
    // paren-matching walk agreed on that total; where it differed was the
    // SPLIT, because the regex mis-read `sns-topic-provider.ts:1303` (masked on
    // the following line) and merged the two sites `asg-provider.ts:1404`
    // carries. The 41st arrived with review, below.
    // 41 rather than 40 since review: the custom-resource payload refusal was
    // SPLIT into a masked create / update arm and an unmasked DELETE arm, so
    // the path with no masker is its own site and its own EXEMPT entry instead
    // of hiding behind an identity masker inside the masked total.
    expect(report.sites).toBeGreaterThanOrEqual(41);
    expect(report.masked).toBeGreaterThanOrEqual(37);
    expect(report.filesWithSites).toBeGreaterThanOrEqual(18);
    expect(report.filesScanned).toBeGreaterThanOrEqual(80);
    expect(report.masked + report.exempt).toBe(report.sites);
  });

  it('keeps the two known FALSE POSITIVES of the naive rule masked', () => {
    // These are the sites a "wrap it inside the stringify" rule reds. If either
    // ever reports raw, the dataflow walk has regressed to the naive rule and
    // the fence is about to be argued down.
    const upstream = report.siteList.filter(
      (site) =>
        (site.file.endsWith('asg-provider.ts') && site.expression.endsWith('Sorted')) ||
        (site.file.endsWith('cloudfront-distribution-provider.ts') &&
          site.expression === 'comment')
    );
    expect(upstream.length).toBe(3);
    expect(upstream.every((site) => site.verdict === 'masked')).toBe(true);
  });

  it('keeps KNOWN BOUND (1) true: zero string-CONCAT stringify sites', () => {
    // The bound is FENCED rather than merely stated, so it cannot stop being
    // true silently. `MAX_CONCAT_SITES` fails the run above zero; this pins
    // the measurement the bound rests on.
    expect(report.concatSites).toBe(0);
  });

  it('counts every exemption as exempt rather than as clean', () => {
    // The distinction is load-bearing: an exemption that stops being counted is
    // an exemption nobody re-reads.
    expect(report.exempt).toBe(4);
  });

  it('pins the exempt set by NAME so it cannot quietly grow', () => {
    const exempt = report.siteList
      .filter((site) => site.verdict === 'exempt')
      .map((site) => `${site.file.replace('src/provisioning/providers/', '')} ${site.expression}`)
      .sort();
    expect(exempt).toEqual([
      // Delete path: `DeleteContext` carries no masker by the contract.
      'custom-resource-provider.ts parsed',
      // Import path: `resolvePhysicalId` reads an UNRESOLVED template.
      's3-bucket-policy-provider.ts bucket',
      'sns-topic-policy-provider.ts topics',
      'sqs-queue-policy-provider.ts queues[0]',
    ]);
  });

  it('reports nothing from the exemption audit', () => {
    // The report's OWN verdicts, unflattened: an exempted site becoming
    // `masked` is one of the two ways an entry stops being meaningful, and
    // flattening `exempt` back to `raw` here is exactly what made that half of
    // the audit unreachable in the first cut.
    expect(auditExemptions(report.siteList)).toEqual([]);
  });

  it('passes end to end against `src/`', () => {
    const proc = run([]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('provider secret-mask check OK');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

describe('provider secret-mask critic — failure probes on REAL code', () => {
  it('FAILS per SITE when four masked sites in one file lose their wrap', () => {
    // The per-file-OR failure this critic exists not to have: after the probe
    // the file STILL contains two `maskLeaf(` wraps, so a whole-file predicate
    // would stay green while four handlers lost their only mask.
    const dir = copyTree();
    mutateAll(dir, 'sns-topic-provider.ts', 'JSON.stringify(maskLeaf(logging))', 'JSON.stringify(logging)', 2);
    mutateAll(dir, 'sns-topic-provider.ts', 'JSON.stringify(maskLeaf(entry))', 'JSON.stringify(entry)', 2);
    expect(readFileSync(join(dir, 'sns-topic-provider.ts'), 'utf8')).toContain('maskLeaf(config[');

    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    for (const expr of ['JSON.stringify(logging)', 'JSON.stringify(entry)']) {
      expect(stderr).toContain(expr);
    }
    // The file's OTHER masked sites stay clean.
    expect(stderr).not.toContain("JSON.stringify(maskLeaf(config['Protocol']))");
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when the local WRAPPER stops delegating to the shared walk', () => {
    // The site text is UNCHANGED — `maskLeafValue(...)` still reads as a mask.
    // Only the dataflow behind it broke, which is what makes this a check of
    // the effect rather than of the spelling.
    const dir = copyTree();
    mutate(
      dir,
      'dynamodb-table-provider.ts',
      '  return maskDeep(value, maskSecrets);\n}',
      '  return value;\n}'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('dynamodb-table-provider.ts');
    expect(stderr).toContain('maskLeafValue(coerced.spec, maskSecrets)');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when the single caller stops threading a helper parameter', () => {
    const dir = copyTree();
    mutate(
      dir,
      'sns-topic-provider.ts',
      "normalizeDeliveryStatusProtocolOrThrow(config['Protocol'], logicalId, maskLeaf)",
      "normalizeDeliveryStatusProtocolOrThrow(config['Protocol'], logicalId)"
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('JSON.stringify(maskValue(input))');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS on the exact pre-#2178 shape of a site this change fixed', () => {
    const dir = copyTree();
    mutate(
      dir,
      'kinesis-provider.ts',
      '`strings, got ${JSON.stringify(maskDeep(value, mask))}`',
      '`strings, got ${JSON.stringify(value)}`'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('kinesis-provider.ts');
    expect(stderr).toContain('JSON.stringify(value)');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS an exemption whose site EXPRESSION was rewritten', () => {
    // Named for what it actually exercises. It used to be named for the
    // became-MASKED direction and did not test it: rewriting the expression
    // makes the entry stop MATCHING, which is the site-is-gone arm. The real
    // became-masked case is the test below, and it was green against a critic
    // that never read a verdict at all.
    //
    // Anchored on the DELETE-PATH row. It used to use `s3-bucket-provider.ts`
    // `value`, one of the nine OTHER-LANE rows that this change RETIRED by
    // fixing the sites at the source once issue #2177's lanes merged — a probe
    // pointing at a dropped row proves nothing, so both probes moved to rows
    // that remain.
    const dir = copyTree();
    mutate(
      dir,
      'custom-resource-provider.ts',
      'JSON.stringify(parsed)',
      'JSON.stringify(maskDeep(parsed, mask))'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('exempt site');
    expect(stderr).toContain('custom-resource-provider.ts');
    expect(stderr).toContain('no longer exists');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS an exemption whose site became MASKED with its expression UNCHANGED', () => {
    // THE retirement path, and the one the first cut could not see: a mask
    // moving UPSTREAM leaves the stringified expression spelled exactly as it
    // is today, so file + expression still match and only the VERDICT moved.
    // Measured on this branch before the fix, against the then-exempt
    // `s3-bucket-provider.ts` site: exit 0, "11 exempt site(s)", entry
    // silently rotting. This change then retired all nine of those rows by
    // FIXING them, which is exactly what this arm is supposed to force — so
    // the probe now rides the DELETE-PATH row that remains.
    const dir = copyTree();
    mutate(
      dir,
      'custom-resource-provider.ts',
      'const parsed: unknown = JSON.parse(payloadString);',
      'const parsed: unknown = maskDeep(JSON.parse(payloadString), maskerOrIdentity(mask));'
    );
    // RECEIPT: the site text the entry keys on is untouched by the mutation.
    expect(readFileSync(join(dir, 'custom-resource-provider.ts'), 'utf8')).toContain(
      'JSON.stringify(parsed)'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('exempt site');
    expect(stderr).toContain('custom-resource-provider.ts');
    expect(stderr).toContain('is now MASKED');
    expect(stderr).toContain('drop the entry');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS a NEW raw site whose only "mask" is an IDENTITY masker', () => {
    // The shape a future author reaches for to silence this critic, and the
    // one it used to ACCEPT: before the fix this exact injection took the tree
    // from 40 sites / 28 masked to 41 / 29 at exit 0, with the site counting
    // toward MIN_MASKED_SITES on top.
    const dir = copyTree();
    const path = join(dir, 'kinesis-provider.ts');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      `${text}\nconst PROBE_IDENTITY: MaskerFn = maskerOrIdentity(undefined);\n` +
        `function probe(secret: unknown): never {\n` +
        `  throw new Error(\`probe \${JSON.stringify(PROBE_IDENTITY(secret))}\`);\n}\n`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('kinesis-provider.ts');
    expect(stderr).toContain('JSON.stringify(PROBE_IDENTITY(secret))');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS a new site whose mask is the shared walk handed an IDENTITY', () => {
    // The REAL-CODE twin of the classifier cases, in the shape a contributor
    // would actually introduce it: a named module-scope constant, exactly like
    // the `DELETE_PATH_UNMASKED` already in this tree, handed to `maskDeep`.
    // This spelling shipped ACCEPTED in the first cut of the identity rule --
    // 41 sites / 37 masked became 42 / 38 at exit 0 -- because the rule only
    // refused the name as a derivation ROOT and the callee `maskDeep` is a root
    // on its own.
    const dir = copyTree();
    const path = join(dir, 'kinesis-provider.ts');
    const text = readFileSync(path, 'utf8');
    const anchor = 'export class KinesisStreamProvider implements ResourceProvider {';
    expect(text.split(anchor).length - 1, 'probe anchor is not unique').toBe(1);
    writeFileSync(
      path,
      text.replace(
        anchor,
        `const __PROBE_IDENTITY: MaskerFn = maskerOrIdentity(undefined);\n` +
          `function __probeIdentityMasked(properties: Record<string, unknown>): string {\n` +
          `  return \`probe \${JSON.stringify(maskDeep(properties, __PROBE_IDENTITY))}\`;\n}\n\n` +
          anchor
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('kinesis-provider.ts');
    expect(stderr).toContain('JSON.stringify(maskDeep(properties, __PROBE_IDENTITY))');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS a string-CONCAT stringify rather than leaving KNOWN BOUND (1) unfenced', () => {
    // A stated bound stops being true silently. This one is measured on every
    // run: the `+` spelling reaches the same sinks and is NOT classified, so
    // anything above zero fails instead of quietly leaving the site unfenced.
    const dir = copyTree();
    const path = join(dir, 'kinesis-provider.ts');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      `${text}\nexport function probeConcat(value: unknown): never {\n` +
        `  throw new Error('probe ' + JSON.stringify(value));\n}\n`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('concatenation(s)');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS a bare message-sink stringify rather than leaving KNOWN BOUND (5) unfenced', () => {
    // Issue #2269 finding 3. The `analyzeFile`-level assertions in
    // `provider-secret-mask-recognition-2269.test.ts` pin the COUNTER; this one
    // pins that `main` still CONSULTS it. Deleting the consult left the whole
    // suite green, which is a recorded value with no consumer -- inert by
    // construction, and the same gap the self-probe channel itself had.
    const dir = copyTree();
    const path = join(dir, 'kinesis-provider.ts');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      `${text}\nexport function probeBareSink(value: unknown, logger: { warn(m: string): void }) {\n` +
        `  logger.warn(JSON.stringify(value));\n}\n`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('STRAIGHT to a message sink');
    // The failure must LOCATE the site and name the FORM. A bare count over an
    // 83-file corpus points at nothing, and after the factory arm landed it
    // could point at a spelling the author never wrote.
    expect(stderr).toContain('kinesis-provider.ts');
    expect(stderr).toContain('(logger call)');
  }, SPAWN_TIMEOUT_MS);

  it('does NOT fail a bare sink whose value already reached a masker', () => {
    // The counter-direction of the same widening: correct code must stay green,
    // or the remedy the next author reaches for is to work AROUND the fence.
    const dir = copyTree();
    const path = join(dir, 'kinesis-provider.ts');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      `${text}\nexport function probeMaskedSink(\n` +
        `  value: unknown,\n  maskSecrets: SecretMasker,\n  logger: { warn(m: string): void }\n` +
        `) {\n  logger.warn(JSON.stringify(maskDeep(value, maskSecrets)));\n}\n`
    );
    const { status, stderr } = runCheck(dir);
    expect(stderr).not.toContain('STRAIGHT to a message sink');
    expect(status).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('FAILS a FACTORY throw, the 33-site spelling the first cut of bound (5) missed', () => {
    // `throw this.wrapError(JSON.stringify(properties))` reached a message sink
    // while the counter reported zero and the run exited 0, because
    // `isErrorConstructor` required `new`. Probed against the REAL tree rather
    // than a synthetic source, since the point is that the corpus spells it
    // this way 33 times.
    const dir = copyTree();
    const path = join(dir, 'kinesis-provider.ts');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      `${text}\nexport class ProbeFactory {\n` +
        `  private wrapError(message: string): Error { return new Error(message); }\n` +
        `  run(value: unknown): never { throw this.wrapError(JSON.stringify(value)); }\n}\n`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('STRAIGHT to a message sink');
    expect(stderr).toContain('(error factory)');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS an unconverged masker set, and NAMES the file', () => {
    // Issue #2269's third nit. Two claims in one probe: `main` consults
    // `fixpointTruncations` at all, and the message carries `truncatedFiles`
    // rather than a bare count -- a truncated file's sites can still read
    // `masked`, so nothing else in the run points at it.
    const dir = copyTree();
    const path = join(dir, 'kinesis-provider.ts');
    const text = readFileSync(path, 'utf8');
    const links = Array.from(
      { length: 10 },
      (_unused, i) => `  const __w${11 - i} = (v: unknown): unknown => __w${10 - i}(v);`
    ).join('\n');
    writeFileSync(
      path,
      `${text}\nexport function probeTruncation(p: Record<string, unknown>, m: SecretMasker) {\n` +
        `${links}\n` +
        `  const __w1 = (v: unknown): unknown => maskDeep(v, m);\n` +
        `  return \`got \${JSON.stringify(__w11(p))}\`;\n}\n`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    // Asserted on the TRUNCATION line specifically, not on the whole stderr:
    // a truncated file also emits per-SITE failures that name the same file, so
    // a whole-stderr `toContain` passes even when the truncation line carries a
    // bare count. Measured during review -- replacing the file list with a
    // literal left this test green.
    const truncationLine = stderr
      .split('\n')
      .find((line) => line.includes('masker-set') && line.includes('growth cap'));
    expect(truncationLine, 'no truncation failure line in stderr').toBeDefined();
    expect(truncationLine).toContain('kinesis-provider.ts');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a SECOND site appears with an exempt expression', () => {
    // `count` is exact, not a floor: a same-spelled sibling is a NEW defect the
    // entry must not silently absorb.
    const dir = copyTree();
    const path = join(dir, 'sqs-queue-policy-provider.ts');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      `${text}\nexport function extra(queues: unknown[]): string {\n  return \`also \${JSON.stringify(queues[0])}\`;\n}\n`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('matches 2 unmasked site(s)');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a scanned file does not parse, rather than counting zero sites', () => {
    const dir = copyTree();
    writeFileSync(join(dir, 'broken-provider.ts'), 'function f( {\n');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('failed to parse');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when the composite-id.ts sibling is missing rather than skipping it', () => {
    const dir = copyTree();
    rmSync(join(dir, '..', 'composite-id.ts'));
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('composite-id.ts is missing');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

describe('provider secret-mask critic — floors', () => {
  it('FAILS the file floor on a tree that collapsed to nothing', () => {
    const { status, stderr } = runCheck(emptyTree(0));
    expect(status).toBe(1);
    expect(stderr).toContain('source files scanned');
    expect(stderr).toContain('scan regression?');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the SITE floor once the file floor is cleared', () => {
    // Tripping one floor at a time is the point: a 1-file tree trips them all
    // at once, which means none of them was ever exercised alone.
    const { status, stderr } = runCheck(emptyTree(70));
    expect(status).toBe(1);
    expect(stderr).not.toContain('source files scanned');
    expect(stderr).toContain('interpolated `JSON.stringify` sites found');
  }, SPAWN_TIMEOUT_MS);

  it('names the three remaining floors by LABEL when a tree trips them', () => {
    // MIN_MASKED_SITES / MIN_FILES_WITH_SITES / MIN_MASKER_NAMES previously
    // fired only inside the all-zero `emptyTree(0)` case, whose assertions
    // name none of them — so their labels and thresholds were never observed
    // and either could have been mistyped without anything noticing. A
    // collapsed tree trips all three at once, which is fine here BECAUSE the
    // assertion is on the label text rather than on isolation.
    const { status, stderr } = runCheck(emptyTree(0));
    expect(status).toBe(1);
    expect(stderr).toContain('pre-stringify masked sites');
    expect(stderr).toContain('files carrying a site');
    expect(stderr).toContain('derived masker names');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

/**
 * The collapse-toward-green defense, fenced in BOTH directions.
 *
 * This suite exists because of a real hole found in review: the entrypoint did
 * `failures.push(...runSelfProbes())` and NOTHING spawned the binary to check
 * it. Deleting that one line left the CLI at exit 0 with a byte-identical
 * success line while every test here stayed green, because the suite called the
 * EXPORT directly. Every other failure channel already had a `runCheck()` spawn
 * probe; self-probes were the only one without.
 *
 * A second, independent guard does exist and is deliberately not removed by
 * these tests: `auditExemptions` reads each site's VERDICT, so an
 * `isMasked -> true` degradation makes all four exempt sites report "is now
 * MASKED" and fails the run even with the self-probe call deleted. Measured.
 * That guard covers ONE collapse shape, though — it says nothing about a
 * refusal arm degrading — which is why the channel needs its own fence.
 */
describe('provider secret-mask critic — the self-probe channel is itself fenced', () => {
  it('runs the probes in the REAL binary and reports the count in --json', () => {
    // ACCEPT direction. Deleting `runProbes()` from main, or short-circuiting
    // the runner, drops this to 0 and reds here — via a SPAWN, so it cannot be
    // satisfied by the export alone.
    const proc = run(['--json']);
    expect(proc.status).toBe(0);
    // Parsed WHOLE, like the sibling assertion below. Slicing back to the last
    // `}` is the workaround for prose on the data channel, and a test carrying
    // it cannot notice the summary returning to stdout.
    const parsed = JSON.parse(proc.stdout);
    expect(parsed.selfProbesRun).toBeGreaterThanOrEqual(40);
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a probe fails, so the channel reaches the exit code', () => {
    // REFUSE direction, and the reason `main` takes an injected runner at all:
    // the shipped probes all pass by construction, so nothing else can prove a
    // probe FAILURE is wired to the exit code rather than merely computed.
    const failing = (): SelfProbeOutcome => ({
      failures: ['self-probe "synthetic": expected [masked], got [raw]'],
      ran: 46,
    });
    expect(main([`--providers-dir=${PROVIDERS_DIR}`], failing)).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when the runner reports almost no probes evaluated', () => {
    // The degradation a pass/fail-only channel cannot see: a runner that
    // returns no failures because it ran nothing looks identical to a healthy
    // one. MIN_SELF_PROBES is what separates them.
    const inert = (): SelfProbeOutcome => ({ failures: [], ran: 0 });
    expect(main([`--providers-dir=${PROVIDERS_DIR}`], inert)).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('PASSES with a healthy injected runner, so the two above are not vacuous', () => {
    // The control. Without it, both refusals would still pass if `main` had
    // simply become "always return 1" for these arguments.
    const healthy = (): SelfProbeOutcome => ({ failures: [], ran: 46 });
    expect(main([`--providers-dir=${PROVIDERS_DIR}`], healthy)).toBe(0);
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

describe('provider secret-mask critic — entrypoint mechanics', () => {
  it('still runs when invoked through a SYMLINK', () => {
    // Node resolves the main module to its realpath while `argv[1]` keeps the
    // link, so an `import.meta.url === \`file://${argv[1]}\`` guard silently
    // exits 0 having done nothing — the exact vacuous green the floors forbid.
    const link = join(scratch('cdkd-mask-link-'), 'link.ts');
    symlinkSync(SCRIPT, link);
    const proc = run([], link);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('provider secret-mask check OK');
  }, SPAWN_TIMEOUT_MS);

  it('emits json whose counts are derived from the site list, not restated', () => {
    const proc = run(['--json']);
    expect(proc.status).toBe(0);
    // Parsed WHOLE rather than sliced back to the last `}`. The slice was the
    // workaround for the human summary being appended to the data channel, and
    // a test that works around a defect pins it instead of catching it: the
    // summary now goes to stderr under `--json`, matching the sibling critic
    // `check-local-reachability.ts`.
    const parsed = JSON.parse(proc.stdout);
    expect(proc.stdout).not.toContain('provider secret-mask check OK');
    expect(proc.stderr).toContain('provider secret-mask check OK');

    // `siteList.length === sites` was the previous assertion and it is a
    // TAUTOLOGY — `buildReport` sets both from one array, so it proves the
    // JSON parsed and nothing else. Re-derive each bucket from the list
    // instead, which is a claim the report can actually violate.
    const byVerdict = (verdict: string) =>
      parsed.siteList.filter((site: { verdict: string }) => site.verdict === verdict).length;
    expect(byVerdict('masked')).toBe(parsed.masked);
    expect(byVerdict('raw')).toBe(parsed.raw);
    expect(byVerdict('exempt')).toBe(parsed.exempt);
    expect(parsed.masked + parsed.raw + parsed.exempt).toBe(parsed.sites);
    expect(new Set(parsed.siteList.map((site: { file: string }) => site.file)).size).toBe(
      parsed.filesWithSites
    );
  }, SPAWN_TIMEOUT_MS);

  it('rejects an unrecognized flag rather than falling through to a silent pass', () => {
    const proc = run(['--chekc']);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('Unrecognized argument');
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

/**
 * The wiring fence, in the shape of `matrix-regen-coverage.test.ts`: parse the
 * registered task names out of `vite.config.ts` and the invoked ones out of
 * `ci.yml`, then assert BOTH directions. Registered-but-uninvoked leaves the
 * task's own command string (including its `--experimental-strip-types` flag)
 * unexercised everywhere; invoked-but-unregistered fails the CI job for a
 * misleading reason.
 */
describe('provider secret-mask critic — CI wiring', () => {
  const VITE_CONFIG = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
  const CI_YML = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

  /**
   * Registered critics: an `'audit:<name>:check': { … }` task block.
   *
   * Matched on the BLOCK rather than on the bare name so the `cache` flag can
   * be read off the same parse, and so a name appearing only in a comment or in
   * another task's chained command never counts as a registration.
   */
  function registeredChecks(): Map<string, string> {
    const out = new Map<string, string>();
    for (const match of VITE_CONFIG.matchAll(
      /'(audit:[a-z0-9:-]*:check)':\s*\{([\s\S]*?)\n {6}\}/g
    )) {
      out.set(match[1]!, match[2]!);
    }
    return out;
  }

  /** Critics CI actually runs, as bare `- run: vp run <task>` steps. */
  function invokedChecks(): Set<string> {
    return new Set(
      [...CI_YML.matchAll(/^ +- run: vp run (audit:[a-z0-9:-]*:check)$/gm)].map((m) => m[1]!)
    );
  }

  /**
   * Registered critics CI deliberately does NOT run, with the reason.
   *
   * Re-audited below in both directions, so an entry that stops being needed
   * fails rather than going inert and hiding the next real one.
   */
  const NOT_IN_CI: ReadonlyMap<string, string> = new Map([
    [
      'audit:aws-cli-removals:check',
      'needs a local AWS CLI source checkout (`--aws-root`), which no CI runner has',
    ],
  ]);

  // Parser floor: "found nothing" and "everything matches" look identical
  // otherwise, which is the vacuous pass `.claude/rules/testing.md` forbids.
  it('parses a plausible number of critics out of both files', () => {
    expect(registeredChecks().size).toBeGreaterThanOrEqual(10);
    expect(invokedChecks().size).toBeGreaterThanOrEqual(9);
    // Spot-check both ends: the oldest critic and this one.
    expect(registeredChecks().has('audit:coverage:check')).toBe(true);
    expect(registeredChecks().has('audit:provider-secret-mask:check')).toBe(true);
    expect(invokedChecks().has('audit:provider-secret-mask:check')).toBe(true);
  });

  it('registers this critic with the cache DISABLED', () => {
    const block = registeredChecks().get('audit:provider-secret-mask:check');
    expect(block).toBeDefined();
    expect(block).toContain('scripts/check-provider-secret-mask.ts');
    // A cached replay would report a stale green without having looked.
    expect(block).toContain('cache: false');
  });

  it('runs every registered critic in CI, bar the reasoned exclusions', () => {
    const missing = [...registeredChecks().keys()]
      .filter((task) => !invokedChecks().has(task) && !NOT_IN_CI.has(task))
      .sort();
    expect(
      missing,
      `registered in vite.config.ts but never run by ci.yml:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('registers every critic CI runs', () => {
    const unregistered = [...invokedChecks()].filter((task) => !registeredChecks().has(task)).sort();
    expect(
      unregistered,
      `ci.yml runs these, but vite.config.ts registers no such task:\n  ${unregistered.join('\n  ')}`
    ).toEqual([]);
  });

  it('keeps every CI exclusion live', () => {
    for (const [task, reason] of NOT_IN_CI) {
      expect(registeredChecks().has(task), `${task} is no longer registered — drop the exclusion`).toBe(
        true
      );
      expect(
        invokedChecks().has(task),
        `${task} IS run by CI now (reason on file: "${reason}") — drop the exclusion`
      ).toBe(false);
    }
  });

  it('every registered critic disables the cache', () => {
    // A critic whose green replays from cache reports its verdict without
    // having looked, which is the one failure mode a gate must not have.
    const cached = [...registeredChecks()]
      .filter(([, block]) => !block.includes('cache: false'))
      .map(([task]) => task)
      .sort();
    expect(cached, `these critics can replay a stale green:\n  ${cached.join('\n  ')}`).toEqual([]);
  });
});
