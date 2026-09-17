/**
 * Every already-deleted classifier must refuse an abandoned wait (issue
 * [#3236](https://github.com/go-to-k/cdkd/issues/3236)).
 *
 * The defect this fences is not any one site — it is MISSING A SITE. Round 1
 * of go-to-k/cdkd#3249 guarded `cloud-control-provider.ts`'s own `delete()`
 * catch with a local `instanceof` and was reviewed believing the class was
 * closed (round 1 never merged, so no released cdkd carried this);
 * two independent reviewers then found the other three, in files the provider
 * cannot see. A hand-written behavioural test per site cannot catch the FIFTH
 * consumer someone adds next year, and that is the same shape as the miss.
 *
 * So the subject is the POPULATION: any condition that decides "already gone"
 * by substring-matching an error message must also test
 * `isWaitAbandonedError`. A `CloudControlWaitAbandonedError` says the
 * OPPOSITE — cdkd stopped watching an operation that may still be running —
 * and every one of these sites reacts to a true verdict by DROPPING THE STATE
 * ROW, or (worse, at the replacement arm) by creating a replacement beside a
 * resource whose delete is still in flight. The message interpolates the
 * LOGICAL ID and the last-seen IDENTIFIER, both user- or template-chosen, so a
 * resource named `PageNotFound` satisfies the needles and no wording rule can
 * make the match safe.
 *
 * SHAPE, not behaviour, and deliberately so — paired with
 * `tests/unit/cli/destroy-runner-interrupt-not-found.test.ts`'s abandoned-wait
 * case, which drives the real runner end to end. This one answers "is the
 * guard present at every site"; that one answers "does the guard work".
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// `typescript-v6` is an npm alias of typescript@6 — TS7 ships the stable
// compiler API only under `typescript/unstable/*`. Same import the sibling
// critics (`check-docs-error-strings.ts`, `check-aws-client-defaults.ts`) use.
import ts from 'typescript-v6';

const SRC_ROOT = new URL('../../../src', import.meta.url).pathname;

/**
 * The needles the four classifiers match on. Any condition mentioning two or
 * more of these is deciding "already gone" — one alone is too weak a signal
 * (a message builder may name a single phrase in passing).
 */
const ALREADY_DELETED_NEEDLES = [
  "'does not exist'",
  "'was not found'",
  "'not found'",
  "'No policy found'",
  "'NoSuchEntity'",
  "'NotFound'",
  "'NotFoundException'",
  "'ResourceNotFoundException'",
];

/** The predicate every such condition must carry. */
const REQUIRED_GUARD = 'isWaitAbandonedError';

/**
 * Sites the needles find that an abandoned wait can provably never REACH, each
 * with the reason.
 *
 * The exemption is about the error's PROVENANCE, not its shape: a
 * `CloudControlWaitAbandonedError` is built in one place —
 * `CloudControlProvider.abandonWait` — so a catch whose only possible input is
 * a direct AWS SDK rejection cannot see one. Guarding such a site would add an
 * unreachable conjunct and an import edge for nothing.
 *
 * RE-AUDITED every run (the assertions below): an entry whose site disappears,
 * or which GAINS the guard, fails — so a stale exemption cannot sit here
 * quietly, and neither can one that silently stopped matching.
 */
const SDK_PROVIDER_REASON =
  'an SDK provider classifying the rejection of its OWN direct AWS SDK call. An abandoned ' +
  'wait is constructed in exactly one place, CloudControlProvider.abandonWait, and none of ' +
  'these files imports or constructs CloudControlProvider (measured: the only matches are ' +
  'comments), so no such error can reach these catches. Delegation runs the other way — the ' +
  'CC provider calls INTO ASGProvider for --remove-protection (the one such site), and that ' +
  'call makes its own SDK requests.';

const EXEMPT: { file: string; sites: number; reason: string }[] = [
  {
    file: 'provisioning/providers/sns-topic-policy-provider.ts',
    sites: 2,
    reason: `${SDK_PROVIDER_REASON} Here: SetTopicAttributes on the delete path, GetTopicAttributes on the read-back.`,
  },
  // The ten the COMPILER-API rewrite of this scan surfaced and the hand-rolled
  // `if (`-only version could not see. They are the repo's DOMINANT spelling —
  // a `private isNotFoundError() { return a || b }` helper — which is exactly
  // why the scan had to stop matching syntax and start parsing.
  { file: 'provisioning/providers/appsync-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/asg-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/docdb-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/ec2-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/ecs-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/elasticache-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/elbv2-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/neptune-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/rds-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
  { file: 'provisioning/providers/s3-vectors-provider.ts', sites: 1, reason: SDK_PROVIDER_REASON },
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Every expression in the file that could DECIDE "already gone", with its line.
 *
 * Parsed with the real compiler rather than matched, and that is a correction
 * rather than a preference. The first cut paren-matched `if (` alone, and
 * review measured two ways around it that are not contrived: the repo's
 * DOMINANT spelling for this classifier is a helper
 * (`private isNotFoundError() { return a || b }` — ten such sites, plus the
 * exported `isNotFoundMessage` in the provider itself), and hoisting a needle
 * chain into a `const` while KEEPING the guard also hid the site. A fence a
 * plausible refactor walks around is worse than none, because it reads as
 * coverage. `.claude/rules/implement.md`: stop patching a hand-rolled scanner,
 * parse for real.
 *
 * So the unit is any `if` condition, `return` argument, or variable
 * initializer — the three places a needle chain is written — and the guard is
 * looked for IN THAT EXPRESSION.
 *
 * Expression scope, not the enclosing function, and that is a CORRECTION: a
 * round scored it over the whole function on the theory that one guard is a
 * preceding early return. Two reviewers independently measured what it cost —
 * deleting the guard conjunct from three of the four governed sites left the
 * test GREEN, because `deploy-engine.ts`'s two sites share one 2051-line
 * method carrying three mentions of the identifier, and `destroy-runner.ts`'s
 * arrow carries the name in a COMMENT. The fence's whole job is catching a
 * dropped guard, so the widening cost exactly the thing it exists for. It also
 * bought nothing: all four governed sites carry the guard inside the
 * condition, and the early-return site is not in this population at all (its
 * partner classifier is a regex helper with no literal needles).
 */
function candidateExpressions(
  source: string,
  fileName: string
): { text: string; line: number; start: number; end: number }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  // A parse failure must REFUSE, not contribute zero sites — an unparseable
  // file reads exactly like a clean one. `createSourceFile` does not throw, so
  // the diagnostics are the only signal.
  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    throw new Error(`${fileName}: ${diagnostics.length} parse diagnostic(s) — scan REFUSED`);
  }

  const found: { text: string; line: number; start: number; end: number }[] = [];
  function visit(node: ts.Node): void {
    let expr: ts.Node | undefined;
    if (ts.isIfStatement(node)) expr = node.expression;
    else if (ts.isReturnStatement(node) && node.expression) expr = node.expression;
    else if (ts.isVariableDeclaration(node) && node.initializer) expr = node.initializer;

    if (expr) {
      found.push({
        text: expr.getText(sf),
        line: sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1,
        start: expr.getStart(sf),
        end: expr.getEnd(),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/**
 * Keep the INNERMOST needle-bearing expression when candidates nest.
 *
 * Replaces an earlier "drop any candidate containing a function body", which
 * fixed the double-count it was written for and created a worse hole: the
 * repo's dominant classifier spelling is `CONST.some((n) => msg.includes(n))`
 * (`retryable-errors.ts`, `custom-resource-provider.ts`), and excluding
 * anything containing a callback made exactly that shape invisible.
 *
 * Containment is the right discriminator for both. `level.map(async () => { if
 * (...) })` has a needle-bearing `if` INSIDE it, so the outer initializer is
 * dropped and one written site is counted once. `if ([...].some((n) =>
 * msg.includes(n)))` has no needle-bearing candidate inside it — the arrow body
 * is `msg.includes(n)`, needle-free — so the condition is kept.
 */
/**
 * True when the expression CALLS the guard, not merely mentions it.
 *
 * A substring test was the first cut and review defeated it without touching
 * behaviour the type checker objects to: `!isWaitAbandonedError && ...` — the
 * parens dropped — is a dead conjunct that can never fire, leaves the
 * already-gone arm permanently reachable, typechecks clean, and kept the fence
 * green. Parsing the expression and requiring a CallExpression on that
 * identifier is what separates the two.
 *
 * Deliberately does NOT check the ARGUMENT: `isWaitAbandonedError(context)`
 * would pass here. That case is caught by the behavioural suites instead —
 * each governed site has one — and a fence trying to model argument
 * correctness would be re-implementing the type checker.
 */
function callsGuard(expressionText: string): boolean {
  // Wrapped so the fragment parses as an expression statement rather than a
  // possibly-invalid standalone program.
  const sf = ts.createSourceFile(
    'expr.ts',
    `const __probe = (${expressionText});`,
    ts.ScriptTarget.Latest,
    true
  );
  let found = false;
  const walk = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === REQUIRED_GUARD
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

function innermost<T extends { start: number; end: number }>(candidates: T[]): T[] {
  return candidates.filter(
    (c) => !candidates.some((o) => o !== c && o.start >= c.start && o.end <= c.end)
  );
}

interface Site {
  file: string;
  line: number;
  needles: number;
  guarded: boolean;
  /** The expression's own source, for the real-tree self-probe below. */
  text: string;
}

/**
 * @param sourceOverrides absolute path -> source text, for the real-tree
 * self-probe below. The probe MUST re-enter this function rather than
 * re-implementing its scoring: the regression it exists to catch is `guarded`
 * being derived from the wrong INPUT, and a probe that computes its own answer
 * cannot see that. Measured — a first cut asserted over the site's expression
 * text and stayed green while `guarded` read the whole file.
 */
/**
 * One file's sites, keyed by `<absolute path>\0<source text>` (issue
 * go-to-k/cdkd#3347).
 *
 * The self-probe below re-enters `collectSites` once per governed site with a
 * ONE-file override, so the tree is scanned once per probe plus once at
 * describe scope while only that one file's text differs between runs. Parsing
 * is what that costs — `candidateExpressions` builds a `SourceFile` per file
 * and `callsGuard` another per candidate — and all but one file's worth of it
 * is repeated work on byte-identical input. Unmemoized, each probe ran ~5.5 s
 * under the default worker count against Vitest's 5000 ms default, i.e. it
 * failed a correct tree on a loaded machine.
 *
 * THE SOURCE IS IN THE KEY, not just the path, and that is the whole safety
 * property: keyed on the path alone the cache would serve the UNMUTATED scan
 * back to every probe, the blanked guard would score GUARDED, and each
 * SELF-PROBE would pass with exactly the regression it exists to catch. A
 * parse REFUSAL is never cached — `candidateExpressions` throws before the
 * write below — so an unparseable file refuses on every call, not just the
 * first.
 */
const sitesByFileAndSource = new Map<string, Site[]>();

function scanFile(file: string, source: string): Site[] {
  const key = `${file}\u0000${source}`;
  const cached = sitesByFileAndSource.get(key);
  if (cached) return cached;
  const needleBearing = candidateExpressions(source, file).filter(
    (e) => ALREADY_DELETED_NEEDLES.filter((n) => e.text.includes(n)).length >= 2
  );
  const sites = innermost(needleBearing).map(({ text, line }) => ({
    file: file.slice(SRC_ROOT.length + 1),
    line,
    needles: ALREADY_DELETED_NEEDLES.filter((n) => text.includes(n)).length,
    guarded: callsGuard(text),
    text,
  }));
  sitesByFileAndSource.set(key, sites);
  return sites;
}

function collectSites(sourceOverrides?: ReadonlyMap<string, string>): Site[] {
  const sites: Site[] = [];
  for (const file of tsFiles(SRC_ROOT)) {
    const source = sourceOverrides?.get(file) ?? readFileSync(file, 'utf8');
    if (source.trim().length === 0) continue;
    sites.push(...scanFile(file, source));
  }
  return sites;
}

const isExempt = (file: string): boolean => EXEMPT.some((e) => e.file === file);

describe('every already-deleted classifier refuses an abandoned wait (#3236)', () => {
  const sites = collectSites();
  const governed = sites.filter((s) => !isExempt(s.file));

  it('finds the known population — a scan that sees nothing would pass every assertion below', () => {
    // An EXACT set rather than a count: a count is satisfied by N sites in one
    // file if the walk silently stopped recursing, which is the failure mode
    // that would make this whole file green while guarding nothing.
    const byFile = [...new Set(governed.map((s) => s.file))].sort();
    expect(byFile).toEqual([
      'cli/commands/destroy-runner.ts',
      'deployment/deploy-engine.ts',
      'provisioning/cloud-control-provider.ts',
    ]);
    // FOUR governed sites: `deploy-engine.ts` x2, plus one each in
    // `destroy-runner.ts` and `cloud-control-provider.ts`. A FIFTH guard exists
    // — `cleanupFailedCreateRemnant`'s early return — and is deliberately NOT
    // in this population: its partner classifier is the REGEX helper
    // `isNotFoundMessage`, which carries no literal needles, so no needle-driven
    // scan can find it. It has its own behavioural case instead. Say FOUR
    // GOVERNED, never "every classifier".
    expect(
      governed,
      'the governed population changed. If you ADDED an already-deleted classifier it must ' +
        'test isWaitAbandonedError (see the per-site assertions); if you HOISTED a needle chain ' +
        'into a helper or a const, the site is still governed and still needs the guard — do ' +
        'NOT resolve this by editing the expected list, which drops the site from the ' +
        'population permanently.'
    ).toHaveLength(4);
    expect(governed.filter((s) => s.file === 'deployment/deploy-engine.ts')).toHaveLength(2);
    expect(governed.filter((s) => s.file === 'cli/commands/destroy-runner.ts')).toHaveLength(1);
  });

  it.each(EXEMPT.map((e) => [e.file, e] as const))(
    'exemption for %s is still live and still needed',
    (file, entry) => {
      const matched = sites.filter((s) => s.file === file);
      // Still FOUND, at the EXACT count. A `> 0` test was the first cut and it
      // left the multi-site entries half-audited: deleting one of
      // sns-topic-policy-provider's two conditions kept it green while its
      // reason still spoke for both.
      expect(
        matched.length,
        `${file} is exempted for ${entry.sites} site(s) but the scan finds ${matched.length}. ` +
          `If a site was removed, lower the count; if one was added, confirm the reason still ` +
          `covers it before raising it.`
      ).toBe(entry.sites);
      // Still NEEDED: if a site gained the guard, the exemption is dead weight
      // and should go, so the reason cannot outlive the fact it asserts.
      expect(
        matched.every((s) => !s.guarded),
        `${file} now tests ${REQUIRED_GUARD} — the exemption is obsolete; delete the entry.`
      ).toBe(true);
    }
  );

  it.each(governed.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s tests isWaitAbandonedError before deciding "already gone"',
    (_label, site) => {
      expect(
        site.guarded,
        `${site.file}:${site.line} decides "already deleted" from ${site.needles} message ` +
          `substrings without testing ${REQUIRED_GUARD}. An abandoned wait says the operation ` +
          `may STILL BE RUNNING, and its message interpolates a user-chosen logical id — so a ` +
          `resource named \`PageNotFound\` makes this arm drop a live resource's state row. ` +
          `Add \`!${REQUIRED_GUARD}(<error>) &&\` to the condition ` +
          `(src/provisioning/wait-abandoned.ts).`
      ).toBe(true);
    }
  );

  it.each(governed.map((s, i) => [`${s.file}:${s.line}`, s, i] as const))(
    'SELF-PROBE: %s scores UNGUARDED once ITS OWN guard is deleted',
    (label, site) => {
      // The instrument change round 4's review asked for, and its own
      // measurement is the argument: THREE consecutive rounds found a blocker
      // inside the previous round's fix, every one the same class — the fence
      // claiming more than it checked. Each time the per-site assertion was
      // green while a deleted guard would ALSO have left it green, and each
      // time a human running a mutation by hand is what noticed.
      //
      // So the fence probes itself, on the REAL file, THROUGH `collectSites`.
      // Re-entering the real scan is load-bearing: the regression is `guarded`
      // being derived from the wrong INPUT, and a probe that scores the
      // expression itself cannot see that (measured — a first cut did exactly
      // that and stayed green with `guarded` reading the whole file).
      //
      // ONE guard per probe, not one file per probe. Per-file was the previous
      // revision and review measured what it hid: `deploy-engine.ts`'s two
      // sites share one method, so blanking BOTH could red for a reason
      // unrelated to either — under scope-scored `guarded` it red only because
      // of a COMMENT mentioning the identifier, and deleting one real guard
      // left both sites scoring guarded. Sites are matched by INDEX in file
      // order, which is stable under blanking (the line moves, the order does
      // not).
      const absolute = join(SRC_ROOT, site.file);
      const original = readFileSync(absolute, 'utf8');
      const sameFile = governed.filter((s) => s.file === site.file);
      const indexInFile = sameFile.indexOf(site);

      // Blank only THIS site's guard line, located WITHIN the site's own
      // expression text and mapped back to an absolute line. Searching a window
      // around the site's start line was the first cut and it missed two of the
      // four: `site.line` is where the EXPRESSION begins, and the guard is a
      // conjunct several lines INTO it, not above it.
      const lines = original.split('\n');
      const offsetInExpr = site.text
        .split('\n')
        .findIndex((l) => l.includes(REQUIRED_GUARD) && l.trim().startsWith('!'));
      expect(
        offsetInExpr,
        `${label}: no \`!${REQUIRED_GUARD}(...)\` line inside this site's own expression. The ` +
          `probe cannot isolate this guard, so it cannot prove the per-site assertion can fail ` +
          `here — restructure the guard or widen the probe, do NOT delete this probe.`
      ).toBeGreaterThanOrEqual(0);
      const target = site.line - 1 + offsetInExpr;
      expect(
        lines[target]?.includes(REQUIRED_GUARD),
        `${label}: the expression-relative offset did not map back to the guard line — the ` +
          `probe would blank the wrong line and prove nothing.`
      ).toBe(true);
      lines[target] = '';

      const rescored = collectSites(new Map([[absolute, lines.join('\n')]])).filter(
        (s) => s.file === site.file
      );

      expect(
        rescored,
        `${label}: blanking one guard changed this file's site count. The population must be ` +
          `derived from the NEEDLES, never from the guard, or a dropped guard removes the site ` +
          `instead of failing it.`
      ).toHaveLength(sameFile.length);
      expect(
        rescored[indexInFile]!.guarded,
        `${label}: deleting THIS site's own guard left it scoring GUARDED, so the per-site ` +
          `assertion above cannot fail here. \`guarded\` is reading the identifier from ` +
          `somewhere this site does not control — a comment, a SIBLING site in the same ` +
          `function, or an import line.`
      ).toBe(false);
      // ...and its siblings are UNCHANGED, which is what per-file probing could
      // not show. Compared against each sibling's own pre-blank verdict rather
      // than hard-coded `true`: with a sibling's guard genuinely missing, a
      // `.toBe(true)` here fails with "the probe is not isolating one site",
      // which accuses the instrument and points the reader away from the real
      // regression. The per-site assertion is what reports that, and it should
      // be the only thing that does.
      for (let i = 0; i < rescored.length; i++) {
        if (i === indexInFile) continue;
        expect(
          rescored[i]!.guarded,
          `${label}: blanking this site's guard changed a SIBLING's verdict — the probe is not ` +
            `isolating one site.`
        ).toBe(sameFile[i]!.guarded);
      }

      // Known bounds, stated rather than implied. (1) At a file with exactly
      // ONE guard call, expression-scope and file-scope are indistinguishable,
      // so this probe cannot detect a wrong-INPUT regression there — the other
      // two files can, and a regression is global. (2) The fence defers
      // argument correctness and liveness to the paired behavioural suites;
      // that pairing holds for all four sites today (measured, one suite each)
      // but nothing asserts it, so a FIFTH site added with no behavioural test
      // would be fenced for presence only.
    },
    // An explicit bound, kept even though the memo above removed the cost that
    // made this case slow (issue go-to-k/cdkd#3347). The two are not
    // alternatives: the memo is why the probe is fast, this is why a machine
    // slow enough to miss Vitest's 5000 ms default reports a HANG rather than
    // failing a correct tree. Generous on purpose — its job is not to police
    // latency.
    30_000
  );

  it.each([
    [
      'if-condition',
      `function f(msg: string) {\n  if (msg.includes('not found') || msg.includes('NoSuchEntity')) return true;\n  return false;\n}`,
    ],
    [
      'helper-return',
      `function looksGone(msg: string) {\n  return msg.includes('not found') || msg.includes('NoSuchEntity');\n}`,
    ],
    [
      // The repo's DOMINANT classifier spelling, and the one the previous
      // function-body exclusion made invisible.
      'array-some',
      `function f(msg: string) {\n  if (['not found', 'NoSuchEntity'].some((n) => msg.includes(n))) return true;\n  return false;\n}`,
    ],
    [
      // A needle chain hoisted into a const beside the classifier — the shape
      // review measured walking around the first cut.
      'hoisted-const',
      `function f(msg: string) {\n  const gone = msg.includes('not found') || msg.includes('NoSuchEntity');\n  if (gone) return true;\n  return false;\n}`,
    ],
  ])(
    'sees an UNGUARDED site written as %s — otherwise the per-site assertions are unfalsifiable',
    (_label, source) => {
      // The population is derived from the NEEDLES, not from the guard, so a
      // site dropping its guard STAYS in the population and flips to
      // `guarded: false`. Proven through the real parser on every shape review
      // measured defeating an earlier revision of this scan.
      const hits = innermost(
        candidateExpressions(source, 'probe.ts').filter(
          (e) => ALREADY_DELETED_NEEDLES.filter((n) => e.text.includes(n)).length >= 2
        )
      );
      expect(hits, 'the scan found no already-deleted expression').toHaveLength(1);
      expect(hits[0]!.text.includes(REQUIRED_GUARD), 'an unguarded site scored as guarded').toBe(
        false
      );
    }
  );

  it('counts one WRITTEN site once when candidates nest', () => {
    // `destroy-runner.ts`'s real classifier lives inside `level.map(async ...)`,
    // so the callback initializer and the `if` inside it both carry the
    // needles. Before the innermost rule this reported two sites at two lines,
    // which no (file, line) dedupe can see.
    const nested = `const run = () => {\n  if (msg.includes('not found') || msg.includes('NoSuchEntity')) return true;\n};`;
    const hits = innermost(
      candidateExpressions(nested, 'probe.ts').filter(
        (e) => ALREADY_DELETED_NEEDLES.filter((n) => e.text.includes(n)).length >= 2
      )
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text.startsWith('msg.includes')).toBe(true);
  });

  it('REFUSES a file it could not parse instead of reporting it clean', () => {
    // Round 8 measured this arm deletable-green: `createSourceFile` does not
    // throw, so an unparseable file yields ZERO candidate expressions, which is
    // byte-identical to a file with no classifier in it. Silently dropping the
    // real `deploy-engine.ts` that way would take two governed sites out of the
    // population and leave every assertion above passing.
    expect(() => candidateExpressions('const x = (;;', 'broken.ts')).toThrow(/scan REFUSED/);
    // Control: the same helper on VALID source does not throw, so the case is
    // about the diagnostics rather than about the helper being broken.
    expect(() => candidateExpressions('const x = 1;', 'fine.ts')).not.toThrow();
  });

  it('requires a guard CALL, not a mention of its name', () => {
    // Round 8 measured `callsGuard` downgradable to `text.includes(...)` with
    // the suite green — and a substring test is exactly what the expression
    // scope above exists to avoid: `destroy-runner.ts`'s real site names the
    // identifier in a COMMENT, so a mention-based rule scores an unguarded
    // classifier as guarded. These four shapes separate the two rules.
    expect(callsGuard(`${REQUIRED_GUARD}(e) && m.includes('not found')`)).toBe(true);
    expect(callsGuard(`!${REQUIRED_GUARD}(e) && m.includes('not found')`)).toBe(true);
    // A bare reference (passed as a callback, or shadowed by a local) is NOT a
    // call at this site.
    expect(callsGuard(`errors.some(${REQUIRED_GUARD})`)).toBe(false);
    // A property access ending in the same name is a DIFFERENT function.
    expect(callsGuard(`helpers.${REQUIRED_GUARD}(e)`)).toBe(false);
  });
});
