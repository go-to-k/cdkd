import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `integ-destroy` -- the only surviving markgate gate -- spells its scope in TWO
 * places, and both are executable:
 *
 *   a. `.claude/hooks/integ-destroy-gate.sh`, whose three ACTIVATION patterns
 *      (`strict_delete` / `filtered_delete` / `provider_pattern`) decide whether
 *      a `gh pr merge` is blocked at all;
 *   b. `.markgate.yml`'s `integ-destroy.include`, the list the marker's
 *      `hash: diff` digest is taken over and therefore what decides whether that
 *      marker is STALE.
 *
 * Neither half gates anything on its own, so a file present in one and absent
 * from the other silently disarms the gate -- and the two directions fail
 * differently, which is why both are asserted by name:
 *
 *   - **In `.markgate.yml` only (no hook pattern): INERT.** The marker goes
 *     stale for the file, but the hook's own diff guard passes the PR through
 *     before ever consulting the marker. An invalidated marker nobody reads.
 *     This is what `retry.ts` would have been if issue #2042 had been fixed in
 *     `.markgate.yml` alone.
 *   - **In the hook only (no include entry): FAIL-OPEN, and the worse of the
 *     two.** The hook activates and blocks, `markgate verify` runs -- but the
 *     digest never saw the file, so it returns 0 and the merge proceeds with NO
 *     destroy verification at all. `destroy-runner.ts` and `region-check.ts`
 *     were both in this state on main, found by an audit prompted by the first
 *     direction's fix.
 *
 * A gate that has silently stopped gating is indistinguishable from a working
 * one from the outside, which is why this is compared mechanically rather than
 * left to the "keep in sync" comments both files carry.
 *
 * Two further things are pinned here, each closing a hole the two-list
 * comparison cannot see on its own:
 *
 *   - **`DESTROY_SCOPE_PIN` and `DESTROY_STRICT_PIN`, literal arrays.** The sync
 *     comparison proves the copies AGREE; it cannot prove the agreed-upon list
 *     is right, and a coordinated edit satisfies it perfectly. Deleting an entry
 *     from BOTH halves leaves the whole suite green -- the `names only paths
 *     that exist` test does not fire (the survivors all exist) and the floor
 *     leaves room for a silent multi-entry shrink. The pin is the one copy that
 *     must be edited CONSCIOUSLY.
 *   - **The hook's own header enumeration**, compared against `strict_delete`
 *     alone. Nothing else here reads a hook HEADER, and it went stale exactly
 *     that way on go-to-k/cdkd#2720.
 *
 * WHAT THIS DOES NOT PROVE, and no assertion here should be read as covering it:
 * that the scope is COMPLETE. Both halves agreeing proves only that they say the
 * same thing -- exactly the state that held while `retry.ts`,
 * `retryable-errors.ts` and `rollback-executor.ts` were absent from every copy
 * at once (go-to-k/cdkd#2042) while their callers were listed. Completeness is
 * the judgment call `.markgate.yml`'s `integ-destroy` scope encodes, and it
 * needs a human noticing that a file sits under every deleting AWS call.
 *
 * `AGENTS.md` used to carry a THIRD, prose copy of this scope, compared against
 * both halves. It no longer spells the scope out -- it says only that a marker
 * gate holds the merge, naming neither the gate nor its files -- so there is
 * nothing there to drift. Do not reintroduce one; a
 * hand-copy in the file every session loads is the most expensive of the copies
 * and the least likely to be re-read.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DESTROY_HOOK = join(repoRoot, '.claude', 'hooks', 'integ-destroy-gate.sh');
const MARKGATE_YML = join(repoRoot, '.markgate.yml');

const read = (p: string): string => readFileSync(p, 'utf8');

/**
 * Floor, asserted INSIDE each extractor so no call site can forget it.
 *
 * It floors the 13-entry `integ-destroy` scope at 9, leaving four entries of
 * slack. That slack is not what guards a shrink -- the scope is ALSO pinned
 * against a literal array below, so dropping an entry fails the pin long before
 * the floor notices. The floor earns its place in the two-halves comparison:
 * two extractors that BOTH stop parsing compare [] to [] and agree. The pin
 * fails on that input too -- its base is one of these extractors -- so what the
 * floor adds is WHERE the failure lands: in the extractor, naming the file that
 * went blind, rather than as an empty-vs-pin mismatch that names only the base.
 */
const MIN_DESTROY_SCOPE = 9;

function assertFloor(entries: readonly string[], source: string, floor: number): void {
  expect(
    entries.length,
    `${source}: extracted ${entries.length} entries, below the floor of ${floor}. Either the ` +
      `list genuinely shrank (lower the floor deliberately) or this extractor stopped seeing ` +
      `its input -- "the regex matched nothing" and "everything matches" are the same green ` +
      `without this check.`,
  ).toBeGreaterThanOrEqual(floor);
}

/** Sorted copy, duplicates preserved: the copies are lists, not sets. */
const canonical = (entries: readonly string[]): string[] => [...entries].sort();

const PIN_RATIONALE =
  'This list is PINNED. If you are adding an entry, add it here too. If you are REMOVING one, ' +
  'say in the PR body why that file no longer needs real-AWS verification -- a shrinking gate ' +
  'scope is how a file silently stops being verified, and every copy agreeing does not make it ' +
  'right.';

const DESTROY_SCOPE_PIN = [
  'src/analyzer/dag-builder.ts',
  'src/analyzer/implicit-delete-deps.ts',
  'src/analyzer/lambda-vpc-deps.ts',
  'src/cli/commands/destroy-runner.ts',
  'src/cli/commands/destroy.ts',
  'src/deployment/deploy-engine.ts',
  'src/deployment/retry.ts',
  'src/deployment/retryable-errors.ts',
  'src/deployment/rollback-executor.ts',
  'src/provisioning/cloud-control-provider.ts',
  'src/provisioning/provider-registry.ts',
  'src/provisioning/providers/**',
  'src/provisioning/region-check.ts',
];

/**
 * The STRICT half of `integ-destroy`'s scope, pinned SEPARATELY from
 * `DESTROY_SCOPE_PIN`.
 *
 * Every other assertion in this file is blind to a file MOVING BETWEEN BUCKETS.
 * `destroyHookScope()` merges all three activation patterns before comparing, so
 * both the two-halves check and `DESTROY_SCOPE_PIN` see the same set whichever
 * bucket a file sits in; and the header fence compares the header to
 * `strict_delete`, so editing both together satisfies it. Move
 * `src/provisioning/provider-registry.ts` from `strict_delete` to
 * `filtered_delete`, adjust the header to match, and the whole suite stays green.
 *
 * That is not a hypothetical. It is the precise fail-open go-to-k/cdkd#2720
 * measured before choosing the bucket: `filtered_delete` only fires when a
 * changed line carries `delete|rollback|ENI|detach|...`, and a routing edit
 * writes none of those words -- five realistic edits matched 0 times. A
 * hunk-filtered `provider-registry.ts` is a gate that activates, consults the
 * marker, and passes the change through anyway. WHICH BUCKET is the decision;
 * the merged scope cannot express it, so it gets its own pin.
 */
const DESTROY_STRICT_PIN = [
  'src/analyzer/dag-builder.ts',
  'src/analyzer/implicit-delete-deps.ts',
  'src/analyzer/lambda-vpc-deps.ts',
  'src/deployment/retry.ts',
  'src/deployment/retryable-errors.ts',
  'src/deployment/rollback-executor.ts',
  'src/provisioning/provider-registry.ts',
];

const STRICT_PIN_RATIONALE =
  'The STRICT bucket of integ-destroy-gate.sh changed. Adding an entry is cheap and correct. ' +
  'MOVING one out -- to filtered_delete or provider_pattern -- means changes to that file only ' +
  'trip the gate when their diff text happens to carry delete vocabulary, so say in the PR body ' +
  "why that file's changes always will. REMOVING one drops it from the gate entirely.";

// ---------------------------------------------------------------------------
// integ-destroy: the hook's ACTIVATION patterns vs the marker's include scope
// ---------------------------------------------------------------------------

/**
 * Expand a FINITE ERE into the literal strings it matches.
 *
 * The destroy hook's patterns use two shapes a plain alternation split cannot
 * read: an optional group (`destroy(-runner)?\.ts`) and a wildcard
 * (`providers/.*\.ts`). This refuses anything it does not understand rather
 * than skipping it, so a pattern reworked into a shape it cannot read fails
 * loudly instead of contributing a shorter list.
 */
function expandFiniteEre(src: string, source: string): string[] {
  let i = 0;
  const parseAlt = (): string[] => {
    let out = parseSeq();
    while (src[i] === '|') {
      i += 1;
      out = out.concat(parseSeq());
    }
    return out;
  };
  const parseSeq = (): string[] => {
    let acc = [''];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const parts = parseTerm();
      acc = acc.flatMap((a) => parts.map((p) => a + p));
    }
    return acc;
  };
  const parseTerm = (): string[] => {
    const ch = src[i];
    if (ch === '(') {
      i += 1;
      const inner = parseAlt();
      if (src[i] !== ')') throw new Error(`${source}: unbalanced '(' at offset ${i}`);
      i += 1;
      if (src[i] === '?') {
        i += 1;
        return [...inner, ''];
      }
      return inner;
    }
    if (ch === '\\') {
      i += 2;
      return [src[i - 1]];
    }
    if (ch === '.' && src[i + 1] === '*') {
      i += 2;
      return ['**'];
    }
    if (ch === '^' || ch === '$') {
      i += 1;
      return [''];
    }
    if (!/[A-Za-z0-9_/-]/.test(ch)) {
      throw new Error(`${source}: unsupported regex construct ${JSON.stringify(ch)} at ${i}`);
    }
    i += 1;
    return [ch];
  };
  const out = parseAlt();
  if (i !== src.length) throw new Error(`${source}: trailing input at ${i}: ${src.slice(i)}`);
  return out;
}

/**
 * The single deliberate normalization, applied to BOTH sides so neither is
 * privileged: a `**` swallows whatever follows it. The hook spells the provider
 * directory `src/provisioning/providers/.*\.ts` and `.markgate.yml` spells it
 * `src/provisioning/providers/**`; those denote the same scope, and an
 * extractor that dropped the entry rather than normalising it would leave the
 * broadest, highest-blast-radius entry on the list unfenced.
 */
const normalizeGlob = (p: string): string => p.replace(/\*\*.*$/, '**');

/** The three activation patterns in `integ-destroy-gate.sh`, expanded + merged. */
function destroyHookScope(): string[] {
  const src = read(DESTROY_HOOK);
  const out: string[] = [];
  for (const name of ['strict_delete', 'filtered_delete', 'provider_pattern']) {
    const m = new RegExp(`^\\s*${name}='([^']+)'$`, 'm').exec(src);
    expect(m, `integ-destroy-gate.sh: no ${name}='...' assignment found`).not.toBeNull();
    const entries = expandFiniteEre(m![1], `integ-destroy-gate.sh ${name}`).map(normalizeGlob);
    assertFloor(entries, `integ-destroy-gate.sh ${name}`, 3);
    out.push(...entries);
  }
  assertFloor(out, 'integ-destroy-gate.sh activation patterns', MIN_DESTROY_SCOPE);
  return out;
}

/**
 * `.markgate.yml`'s `integ-destroy.include` list.
 *
 * The block terminator is "the next two-space-indented key, OR the end of the
 * file" -- `integ-destroy` is the LAST (and only) gate in the file now that
 * `check`, `docs`, `verify-pr`, `pr-review`, `integ-broad`, `integ-local` and
 * `integ-schema-migration` are gone, so a terminator requiring a following key
 * matches nothing and the extractor returns `[]`. That is not a hypothetical:
 * the previous revision's `^ {2}[a-z][a-z-]*:$` terminator did exactly that the
 * moment `integ-local` was deleted from under it, and the only thing that
 * turned the silent empty list into a failure was `MIN_DESTROY_SCOPE`.
 * `(?![\s\S])` is the end-of-input assertion (JavaScript has no `\Z`).
 */
function destroyIncludeScope(): string[] {
  const m = /^ {2}integ-destroy:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:$|(?![\s\S]))/m.exec(
    read(MARKGATE_YML),
  );
  expect(m, '.markgate.yml: could not locate the integ-destroy gate block').not.toBeNull();
  const out = [...m![1].matchAll(/^\s+- "([^"]+)"$/gm)].map((e) => normalizeGlob(e[1]));
  assertFloor(out, '.markgate.yml integ-destroy.include', MIN_DESTROY_SCOPE);
  return out;
}

/**
 * A THIRD copy of one half of that gate: the BASENAMES the hook's own header
 * comment lists under `"strict-delete" files (...)`.
 *
 * It is not a copy of the whole scope -- the header splits the gate into three
 * buckets and this enumerates only the STRICT one -- so it is compared against
 * `strict_delete` alone rather than against the merged activation set. That is
 * the point: WHICH BUCKET a file sits in is a decision with a measured
 * consequence (a hunk-filtered `provider-registry.ts` is a fail-open for the
 * routing edits it was added for, go-to-k/cdkd#2720), and a header that names
 * the wrong bucket teaches the next reader the wrong one.
 *
 * Why it needs a fence at all, when the other copies of this gate's scope
 * already have one: neither extractor above reads a hook HEADER, so this
 * enumeration went stale in exactly the shape the docblock at the top of this
 * file admits ("a FURTHER copy added without being wired in here is likewise
 * invisible"). Measured on go-to-k/cdkd#2720: `provider-registry.ts` was added
 * to `strict_delete`, every assertion in this file passed, and the header three
 * dozen lines above still listed six files. It was caught by a human reading
 * the diff -- which is the thing this file exists to stop relying on.
 *
 * BASENAMES, not paths, because that is what the header writes. Comparing on
 * basenames is safe here only because `strict_delete` names no two files
 * sharing one, which is ASSERTED below rather than assumed.
 */
function destroyStrictBasenamesFromHookHeader(): string[] {
  const m = /^# - "strict-delete" files \(((?:[a-z0-9-]+\.ts(?:,\s*(?:\n#\s+)?)?)+)\):/m.exec(
    read(DESTROY_HOOK),
  );
  expect(
    m,
    'integ-destroy-gate.sh: could not find the header\'s `# - "strict-delete" files (a.ts, ' +
      'b.ts, ...):` enumeration. The anchor was reworded, or an entry is no longer a bare ' +
      '`<name>.ts`. This REFUSES rather than returning [], which would compare equal to an ' +
      'empty expectation and pass having compared nothing.',
  ).not.toBeNull();
  const out = m![1]
    .replace(/\n#\s+/g, ' ')
    .split(/,\s+/)
    .map((e) => e.trim())
    .filter((e) => e !== '');
  assertFloor(out, 'integ-destroy-gate.sh header strict-delete enumeration', 5);
  return out;
}

/** The PATHS `strict_delete` itself matches -- the executable side. */
function destroyStrictPaths(): string[] {
  const m = /^\s*strict_delete='([^']+)'$/m.exec(read(DESTROY_HOOK));
  expect(m, "integ-destroy-gate.sh: no strict_delete='...' assignment found").not.toBeNull();
  const paths = expandFiniteEre(m![1], 'integ-destroy-gate.sh strict_delete').map(normalizeGlob);
  assertFloor(paths, 'integ-destroy-gate.sh strict_delete', 5);
  return paths;
}

/** The same set as basenames, which is the shape the header comment writes. */
function destroyStrictBasenamesFromPattern(): string[] {
  return destroyStrictPaths().map((p) => p.slice(p.lastIndexOf('/') + 1));
}

// ---------------------------------------------------------------------------

describe('integ-destroy hook activation and marker scope name the same files', () => {
  it('neither half names a file the other omits', () => {
    const hookScope = canonical(destroyHookScope());
    const includeScope = canonical(destroyIncludeScope());
    const failOpen = hookScope.filter((p) => !includeScope.includes(p));
    const inert = includeScope.filter((p) => !hookScope.includes(p));

    expect(
      failOpen,
      `FAIL-OPEN: these files ACTIVATE integ-destroy-gate.sh but are absent from ` +
        `.markgate.yml's integ-destroy.include. The hook blocks and consults markgate, but the ` +
        `marker's hash:diff digest never sees the file, so verify returns 0 and the merge goes ` +
        `through with no destroy verification at all. Add them to the include list.`,
    ).toEqual([]);

    expect(
      inert,
      `INERT: these files are in integ-destroy.include but match none of the hook's activation ` +
        `patterns. The marker goes stale for them while the hook passes the PR through before ` +
        `ever reading it -- an invalidated marker nobody consults. Add them to strict_delete, ` +
        `filtered_delete or provider_pattern in integ-destroy-gate.sh.`,
    ).toEqual([]);
  });

  it('holds exactly the pinned scope', () => {
    expect(canonical(destroyHookScope()), PIN_RATIONALE).toEqual(canonical(DESTROY_SCOPE_PIN));
  });

  it('names only paths that exist', () => {
    const missing = destroyHookScope()
      .map((p) => p.replace(/\/\*\*$/, ''))
      .filter((p) => !existsSync(join(repoRoot, p)));
    expect(missing, 'these integ-destroy scope entries name paths that no longer exist').toEqual(
      [],
    );
  });

  it('holds exactly the pinned STRICT bucket (which bucket, not just which files)', () => {
    expect(canonical(destroyStrictPaths()), STRICT_PIN_RATIONALE).toEqual(
      canonical(DESTROY_STRICT_PIN),
    );
  });

  it("the hook's own header enumerates exactly the files strict_delete matches", () => {
    const fromPattern = destroyStrictBasenamesFromPattern();
    // The basename comparison is only sound while no two strict paths share
    // one. Asserted, not assumed: a future `src/a/x.ts` + `src/b/x.ts` pair
    // would make a missing header entry invisible.
    expect(
      new Set(fromPattern).size,
      'two strict_delete paths now share a basename, so comparing the header on basenames ' +
        'can no longer see a dropped entry -- compare on full paths instead',
    ).toBe(fromPattern.length);

    const fromHeader = destroyStrictBasenamesFromHookHeader();
    expect(
      canonical(fromHeader),
      "integ-destroy-gate.sh's header comment disagrees with its own `strict_delete` pattern " +
        'about which files are STRICT. The pattern is what runs; the header is what the next ' +
        'reader believes. Which BUCKET a file sits in is a load-bearing decision -- a file ' +
        'documented as strict but actually hunk-filtered is a fail-open for every change whose ' +
        'diff text carries none of the delete vocabulary -- so the two must agree.',
    ).toEqual(canonical(fromPattern));
  });
});
