/**
 * The bare-`String()` out-throw in SWALLOWING error handlers under
 * `src/provisioning/**` (issue
 * [#3309](https://github.com/go-to-k/cdkd/issues/3309) follow-up).
 *
 * `String(value)` THROWS for a null-prototype object and for anything with a
 * hostile or `null` `toString`. What that costs depends on what the handler was
 * going to do:
 *
 *  - a SWALLOWING handler (control can reach its end) becomes a HARD FAILURE of
 *    whatever was degrading gracefully -- a partial-create cleanup that stops
 *    running and leaves a LIVE orphan, a retry loop that exits mid-loop, a
 *    drift read that takes down its whole `Promise.all`. That is the defect
 *    class, and this fence keeps it at ZERO.
 *  - a handler that rethrows substitutes a less useful error. Real, lower
 *    severity, tracked as [#3341](https://github.com/go-to-k/cdkd/issues/3341),
 *    not enforced here.
 *
 * **This is the THIRD classifier written for this fence, and review defeated
 * the first two. Read why before replacing it with something simpler.**
 *
 * The first windowed FIVE LINES FORWARD from the match and matched only
 * `logger.<level>` and only the ternary spelling. It reported SEVEN sites.
 * Review measured three independent defects: the window was blind BACKWARDS
 * (this repo's dominant shape at `printWidth` 100 puts `this.logger.debug(` on
 * the PRECEDING line), `throw` matched anywhere in the window including the
 * OUTER block's rethrow and the word inside a COMMENT, and local `warn(...)` /
 * `debug(...)` aliases went unseen. Because the rule was `logs && !throws`,
 * every miss landed in the UN-enforced bucket -- silently. It did not cover one
 * of the sites its own PR fixed.
 *
 * The second was regex over brace-matched catch blocks. It found 158, which was
 * 22x better and still wrong: it could not see `.catch((err) => { ... })` at
 * all, it treated "no logger" as not-swallowing so a handler degrading by
 * `return` was invisible, and its positive control RE-IMPLEMENTED the pipeline
 * instead of calling it -- so the control passed while the real classifier was
 * broken.
 *
 * This one uses the TypeScript compiler API, as every other critic in this repo
 * does, for the reason `scripts/check-docs-error-strings.ts` records in its own
 * header: stop patching a hand-rolled parser and use the real one. It sees
 * `catch` clauses and `.catch(cb)` handlers alike, scopes the read to the
 * handler's own parameter, and decides SWALLOWING by whether control can reach
 * the end of the handler rather than by whether the word `throw` appears near
 * it.
 *
 * **And it was wrong too, in a fourth direction, caught by review.** Its
 * reachability test scanned only the handler's TOP-LEVEL statements, so a
 * handler ending in a rethrow read as "throwing" even when an earlier
 * `continue` nested in an `if` left it first -- mislabelling 14 occurrences,
 * every one a genuine degradation, whose retry and already-gone behaviour is
 * exactly what this fence protects. (An earlier revision said "15 occurrences,
 * 14 genuine". Replaying the round-3 predicate on the merge base collects 191
 * against this one's 205, and the set difference is 14, one-directional.) `occurrenceCanDegrade` below carries the corrected
 * definition and the two ways of getting it wrong.
 *
 * So the lesson is not "use a better parser" a fourth time. Every one of these
 * four classifiers passed a positive control built from the defects ALREADY
 * KNOWN when it was written, which is why each one shipped. The control below
 * is therefore derived from the PREDICATE'S OWN DECISION POINTS instead: one
 * fixture per way out of a handler (`throw`, rejecting `return`, plain
 * `return`, `break`, `continue`, falling off the end), in the top-level
 * position, the nested position AND the suffix position, plus a negative for
 * every widening. Two fixtures -- `commentedThrow` and `silentReturn` -- are
 * NOT individually load-bearing against this classifier, since structurally it
 * cannot tell them from `bareForm`; they are kept as guards against
 * re-adopting a comment-blind or logger-keyed classifier, and are labelled as
 * such rather than counted as distinct capabilities.
 *
 * Two shapes are deliberately out of scope, both measured at ZERO occurrences
 * under `src/provisioning/**` rather than argued: an expression-bodied
 * `.catch((e) => log(String(e)))` (no `ts.Block` to walk) and `.then(ok, onErr)`
 * (two arguments). Neither is a live hole; both are unenforced going forward.
 * (An earlier revision listed a bare `` `${err}` `` interpolation here as
 * "occurring once, at the EXEMPT site". Measured: it occurs ZERO times under
 * `src/provisioning/**` and zero across `src/`, and the EXEMPT site uses the
 * ternary. The claim came from a review note that was taken on trust instead
 * of re-measured -- which is the same mistake, one layer out, as the
 * classifiers above.)
 *
 * The merge-base measurement was 205 can-degrade occurrences across 61 files
 * against 364 that cannot across 73, of 569 total. Note the unit: the verdict
 * is per OCCURRENCE, not per handler, because one handler can compute a
 * message on a degrading path and another on a throwing one. That is a dated
 * figure, not an invariant -- what this file ENFORCES is that the can-degrade
 * bucket holds nothing but `EXEMPT`, which stays true however the tree grows.
 *
 * **One caveat on the OTHER bucket, so nobody reads more into it than the
 * predicate supports.** "Cannot degrade" means control leaves this handler by
 * throwing, so the out-throw substitutes a worse error rather than killing a
 * degradation *here*. It does NOT mean nothing is lost: an always-throwing
 * handler can still run cleanup before its throw, and an out-throw skips it.
 * `lambda-function-provider.ts`'s post-create cleanup is exactly that, which is
 * why it was converted despite sitting in the non-degrading bucket. Measured
 * across the remaining 363: none has an `await` after the occurrence, so there
 * is no live instance today -- but go-to-k/cdkd#3341 should not assume the
 * bucket's name is its whole cost.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-v6';

const ROOT = join(process.cwd(), 'src/provisioning');

interface Site {
  readonly file: string;
  readonly line: number;
  /** The handler's parameter name, so an exemption is keyed on something real. */
  readonly binding: string;
  /** The enclosing function, so two handlers in one file are distinguishable. */
  readonly scope: string;
}

/** Every `.ts` under `src/provisioning/**`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A `return Promise.reject(...)` -- leaving by rejecting, not by degrading. */
function isRejectingReturn(stmt: ts.Statement): boolean {
  return (
    ts.isReturnStatement(stmt) &&
    stmt.expression !== undefined &&
    ts.isCallExpression(stmt.expression) &&
    stmt.expression.expression.getText().endsWith('Promise.reject')
  );
}

/**
 * Whether EVERY path out of this statement leaves by throwing (or rejecting).
 *
 * Recursive on purpose: a `throw` nested in the only reachable arm still throws
 * unconditionally, and an `if` throws unconditionally ONLY when both arms do.
 * A statement kind not listed here is one control can pass through, which is
 * the safe default -- an unknown kind makes a handler look SWALLOWING, i.e.
 * lands in the ENFORCED bucket and fails loudly, rather than disappearing.
 */
function alwaysThrows(stmt: ts.Statement): boolean {
  if (ts.isThrowStatement(stmt) || isRejectingReturn(stmt)) return true;
  if (ts.isBlock(stmt)) return stmt.statements.some(alwaysThrows);
  if (ts.isIfStatement(stmt)) {
    return (
      stmt.elseStatement !== undefined &&
      alwaysThrows(stmt.thenStatement) &&
      alwaysThrows(stmt.elseStatement)
    );
  }
  if (ts.isTryStatement(stmt)) {
    // `finally` alone cannot make a try throw; the try AND its catch must.
    if (stmt.finallyBlock !== undefined && stmt.finallyBlock.statements.some(alwaysThrows)) {
      return true;
    }
    return (
      stmt.catchClause !== undefined &&
      stmt.tryBlock.statements.some(alwaysThrows) &&
      stmt.catchClause.block.statements.some(alwaysThrows)
    );
  }
  if (ts.isSwitchStatement(stmt)) {
    const clauses = stmt.caseBlock.clauses;
    // An EMPTY clause is not "throwing by vacuous truth" -- it falls through to
    // the next one, and an empty LAST clause falls past the switch entirely.
    // Treating it as throwing was the one place this function failed UNSAFE,
    // against its own doc above (measured by review: `switch (k) { default:
    // throw e; case 1: }` claimed always-throws while control walks out).
    const last = clauses[clauses.length - 1];
    return (
      clauses.some((c) => ts.isDefaultClause(c)) &&
      last !== undefined &&
      last.statements.some(alwaysThrows) &&
      clauses.every((c) => c.statements.length === 0 || c.statements.some(alwaysThrows))
    );
  }
  if (ts.isLabeledStatement(stmt)) return alwaysThrows(stmt.statement);
  return false;
}

/**
 * Whether a statement contains an exit that leaves WITHOUT throwing --
 * `return` (not a rejecting one), `break`, or `continue`.
 *
 * Nested FUNCTION bodies are excluded -- a `return` inside a callback leaves the
 * callback, not the handler -- and "function body" means every shape of one:
 * accessors and constructors are function bodies, and an earlier revision's
 * list omitted them.
 *
 * Two residuals stay, both measured at ZERO occurrences under
 * `src/provisioning/**` and both in the SAFE direction (they over-report, so a
 * site lands in the enforced bucket and fails loudly rather than disappearing):
 * a `break` to a LABELLED non-loop block is counted as an outward jump when it
 * is not one; a LABELLED `continue` / `break` naming a loop the handler itself
 * declares is counted the same way; a suffix `for (;;) { throw e; }` reads as
 * passable when it cannot be left; and a nested `catch` that SHADOWS the
 * handler's own binding name makes one occurrence count twice. (Measured: zero
 * labelled jumps and zero labelled statements under `src/provisioning/**` on
 * both trees.)
 */
function containsNonThrowingExit(stmt: ts.Statement): boolean {
  let found = false;
  const walk = (node: ts.Node, inNestedLoop: boolean, inNestedSwitch: boolean): void => {
    if (found) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    // A `break` / `continue` inside a loop or switch DECLARED IN THE HANDLER
    // targets that construct, not the handler, so it is not an exit from here.
    // An unscoped walk counted them: measured at exactly one of the 206.
    // A LABELLED one can still jump outward, so it is never discounted.
    const nestedLoop =
      inNestedLoop ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node);
    // A `switch` catches `break` but NOT `continue`: a `continue` inside one
    // targets the enclosing LOOP, so it still leaves this handler. Tracking the
    // two together read such a `continue` as switch-local -- latent (measured 0
    // today), and in the unsafe direction.
    const nestedSwitch = inNestedSwitch || ts.isSwitchStatement(node);
    const caught = ts.isBreakStatement(node) ? nestedLoop || nestedSwitch : nestedLoop;
    const jumpsOut =
      (ts.isBreakStatement(node) || ts.isContinueStatement(node)) &&
      (!caught || node.label !== undefined);
    if (jumpsOut || (ts.isReturnStatement(node) && !isRejectingReturn(node))) {
      found = true;
      return;
    }
    ts.forEachChild(node, (child) => walk(child, nestedLoop, nestedSwitch));
  };
  walk(stmt, false, false);
  return found;
}

/**
 * Whether THIS OCCURRENCE of `String(caught)` sits on a path that can leave the
 * handler without throwing -- which is the graceful degradation an out-throw
 * would destroy.
 *
 * **The question is about the OCCURRENCE, not about the handler**, and getting
 * that wrong is what made round 3's predicate wrong in BOTH directions:
 *
 *   - It scanned only the handler's TOP-LEVEL statements for a `throw`, so a
 *     handler ending in a rethrow read as "throwing" even when an earlier
 *     `continue` nested in an `if` left it first. That mislabelled ~15 sites,
 *     `ec2-provider.ts`'s `deleteVpc` among them, whose `DependencyViolation`
 *     -> `continue` retry is exactly what this fence protects. It also
 *     contradicted this file's own `silentReturn` fixture: the same `return`
 *     nested one level deeper flipped the verdict.
 *   - Widening it to "can the HANDLER be left without throwing" over-corrects
 *     to 314 occurrences on the merge base, because the common shape is an early
 *     `if (isNotFound(e)) return;` followed by
 *     `throw new ProvisioningError(\`...${String(e)}\`)`. There the `String`
 *     runs only on the throwing path -- the degradation already happened --
 *     so an out-throw costs a worse message, not a lost degradation. That is
 *     the OTHER bucket by definition.
 *
 * So: find the handler's own top-level statement containing the occurrence, and
 * ask what happens FROM THERE.
 */
function occurrenceCanDegrade(block: ts.Block, occurrence: ts.Node): boolean {
  const index = block.statements.findIndex(
    (s) => occurrence.getStart() >= s.getStart() && occurrence.getEnd() <= s.getEnd()
  );
  if (index === -1) return true;
  const host = block.statements[index]!;
  // An exit inside the host statement is a degradation path out of it, and it
  // is reached with the `String` already evaluated.
  if (containsNonThrowingExit(host)) return true;
  // Otherwise the host either throws outright, or control continues past it.
  if (alwaysThrows(host)) return false;
  // The suffix is walked IN ORDER, and the order is the whole point: the
  // dominant shape in this tree computes `msg` first, then retries on one
  // substring and rethrows otherwise, so a trailing `throw` sits AFTER the
  // `continue` that carries the degradation. Asking `suffix.some(alwaysThrows)`
  // finds that throw and calls the site "throwing" -- which is how the shallow
  // predicate lost `ec2-provider.ts`'s `deleteVpc`.
  for (const stmt of block.statements.slice(index + 1)) {
    if (containsNonThrowingExit(stmt)) return true;
    if (alwaysThrows(stmt)) return false;
  }
  return true;
}

/** The nearest named function / method / binding, for a readable scope. */
function enclosingScope(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name !== undefined) {
      return n.name.getText();
    }
    if (ts.isPropertyDeclaration(n) && n.name !== undefined) return n.name.getText();
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
  }
  return '<module>';
}

/**
 * Collect `String(<handlerParam>)` reads inside SWALLOWING handlers of one
 * source.
 *
 * Exported shape so the positive control below drives THIS function rather than
 * a copy of it -- the previous revision's control re-implemented the pipeline
 * and therefore could not see its own classifier break.
 */
function collectFrom(sf: ts.SourceFile, fileLabel: string): Site[] {
  const sites: Site[] = [];

  const record = (param: string, body: ts.Block, anchor: ts.Node): void => {
    const walk = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'String' &&
        n.arguments.length === 1 &&
        ts.isIdentifier(n.arguments[0]!) &&
        n.arguments[0]!.text === param &&
        occurrenceCanDegrade(body, n)
      ) {
        sites.push({
          file: fileLabel,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          binding: param,
          scope: enclosingScope(anchor),
        });
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      const d = node.variableDeclaration.name;
      if (ts.isIdentifier(d)) record(d.text, node.block, node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch' &&
      node.arguments.length === 1
    ) {
      const cb = node.arguments[0]!;
      if (
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        cb.parameters.length === 1 &&
        ts.isIdentifier(cb.parameters[0]!.name) &&
        ts.isBlock(cb.body)
      ) {
        record(cb.parameters[0]!.name.getText(), cb.body, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function collect(file: string): Site[] {
  const text = readFileSync(file, 'utf-8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    // A file that does not parse contributes ZERO sites, which reads exactly
    // like a clean one. Refuse instead.
    throw new Error(`${file}: ${diagnostics.length} parse diagnostic(s) — scan REFUSED`);
  }
  return collectFrom(sf, file.slice(ROOT.length + 1));
}

/**
 * The ONE swallowing site that KEEPS the bare form, with its reason.
 *
 * The reason is UNREACHABILITY, and only that. Every throw into
 * `cleanupFailedCreateRemnant`'s catch comes from `this.delete(...)`, which
 * wraps into a `ProvisioningError`; the three awaits OUTSIDE that try are gated
 * on `context?.removeProtection === true` and this call passes no context. So
 * the bare arm cannot run, and there is nothing for a guard to guard.
 *
 * **An earlier revision of this comment also claimed the site must keep the
 * bare form because `message` feeds `isNotFoundMessage`, a PROSE matcher a
 * "wire-name reduction" would blind. That is not a reason to exempt it from
 * THIS sweep** -- the substitution this fence drives is
 * `describeAwsFailure(x).detail`, which is `x.message` verbatim and reduces
 * nothing. It is restated here only because that version is the one
 * go-to-k/cdkd#3325 and two earlier revisions of this file published, so a
 * reader meeting it elsewhere needs to know it does not bear on `.detail`.
 *
 * It is NOT dismissed wholesale, and the scoping matters: the comment at
 * `cloud-control-provider.ts:917-929` keeps that risk as real but LATENT, and
 * it is about a DIFFERENT substitution -- `describePollFailure(...).display`,
 * whose `display` IS the summary, so there the reduction is genuine. Do not
 * read this entry as retiring that one.
 *
 * Converting it would therefore be harmless rather than wrong -- and is
 * deliberately NOT done, because go-to-k/cdkd#3325's fence pins the carve-out
 * from the other side and a lane does not silently reverse a sibling PR's
 * recorded decision. A mechanical sweep converted it anyway and that fence
 * caught it, which is why this entry is keyed on the enclosing SCOPE as well,
 * and asserted to match EXACTLY one site.
 */
const EXEMPT: readonly {
  readonly file: string;
  readonly scope: string;
  readonly binding: string;
}[] = [
  {
    file: 'cloud-control-provider.ts',
    scope: 'cleanupFailedCreateRemnant',
    binding: 'cleanupError',
  },
];

const files = sourceFiles(ROOT);
const all = files.flatMap(collect);
const swallowing = all.filter(
  (s) => !EXEMPT.some((e) => e.file === s.file && e.scope === s.scope && e.binding === s.binding)
);

describe('provisioning swallowing-handler out-throw (#3309 follow-up)', () => {
  it('leaves NO swallowing handler reading its caught value with a bare String()', () => {
    // Named, not counted: a failure should say WHICH site regressed.
    expect(
      swallowing.map((s) => `${s.file}:${s.line} (${s.scope})`),
      'a swallowing handler turns a graceful degradation into a hard failure; use `describeAwsFailure(err).detail`'
    ).toEqual([]);
  });

  // The INVERSE regression, which this fence could not see. It watches
  // `String(x)` disappearing; nothing watched `safeStringify(x)` being
  // "simplified" to `describeAwsFailure(x).detail` -- and that substitution is
  // exactly what shortened four persisted `outcome: 'partial'` reasons in this
  // lane's previous revision, with the whole suite green.
  //
  // `.detail` is `x.message`; `safeStringify` is `String(x)`, which also
  // carries `x.name`. On a PERSISTED field the text may not move, so these
  // sites are pinned by name. A behavioural twin lives in
  // `iam-role-provider.test.ts` ("persists the unwrapped failure verbatim");
  // this one covers the three the twin does not reach.
  // Both wordings, and the interpolation is what scopes it to a CAUGHT value:
  // `was not deleted: ${deleteResult.reason}` is the non-throwing SKIP arm and
  // is deliberately NOT in this population.
  const PERSISTED_REASON_PATTERN =
    /(?:could not be|was not) deleted: \$\{(?:safeStringify|describeAwsFailure)\(/;

  const PERSISTED_REASON_SITES: readonly string[] = [
    'providers/acm-certificate-provider.ts',
    'providers/apigateway-provider.ts',
    'providers/iam-managed-policy-provider.ts',
    'providers/iam-role-provider.ts',
  ];

  it('lists every persisted orphanReason site, so a fifth cannot appear unwatched', () => {
    // The list above is hand-kept, and a hand-kept list of security-shaped sites
    // is the shape that goes stale silently: a fifth provider building a
    // persisted reason on `.detail` would be invisible to the test below, which
    // only walks what is listed. So derive the population and compare.
    //
    // Derived from what the fence PROTECTS -- an `orphanReason` built by
    // stringifying a caught value -- rather than from the sentence those sites
    // happen to share. Review measured why: the first spelling keyed on
    // `could not be deleted: ${`, and the sibling wording `was not deleted: ${`
    // is already in the tree three times, so a fifth provider picking it would
    // have sat unwatched. (Those three are NOT in this population -- they
    // interpolate `deleteResult.reason`, the non-throwing SKIP arm -- which is
    // exactly why the phrase is the wrong discriminator in both directions.)
    const found = sourceFiles(ROOT)
      .filter((f) => PERSISTED_REASON_PATTERN.test(readFileSync(f, 'utf-8')))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
    expect(found, 'a persisted orphanReason site is missing from PERSISTED_REASON_SITES').toEqual(
      [...PERSISTED_REASON_SITES].sort()
    );
  });

  it('keeps every persisted orphanReason on safeStringify, not on .detail', () => {
    for (const rel of PERSISTED_REASON_SITES) {
      const text = readFileSync(join(ROOT, rel), 'utf-8');
      // Anchored on the INTERPOLATION, not on `orphanReason =`: ACM's
      // assignment is a ternary spanning several lines, so the binding and the
      // interpolation are not on one line. Measured -- the first spelling of
      // this check matched 0 lines there, and only the floor below caught it.
      const reasonLines = text.split('\n').filter((l) => PERSISTED_REASON_PATTERN.test(l));
      // A floor, so a rewording that makes the match empty cannot pass.
      expect(reasonLines.length, `${rel}: no persisted orphanReason found`).toBeGreaterThan(0);
      for (const line of reasonLines) {
        expect(
          line,
          `${rel}: a persisted orphanReason must read safeStringify(err) -- ` +
            `describeAwsFailure(err).detail drops the error's name and SHORTENS a durable record`
        ).toContain('safeStringify(');
      }
    }
  });

  it('refuses a STALE or AMBIGUOUS exemption', () => {
    for (const entry of EXEMPT) {
      const matched = all.filter(
        (s) => s.file === entry.file && s.scope === entry.scope && s.binding === entry.binding
      );
      // EXACTLY one, not "at least one": keyed on file + binding alone, a
      // second unrelated `catch (cleanupError)` in the same file was silently
      // exempted -- measured by review against the previous revision.
      expect(
        matched.length,
        `EXEMPT ${entry.file}#${entry.scope}(${entry.binding}) matched ${matched.length} sites; it must match exactly one`
      ).toBe(1);
    }
  });

  it('classifies every shape the two previous classifiers missed', () => {
    // The positive control, and it drives `collectFrom` ITSELF. The previous
    // revision re-implemented the pipeline here, so the control stayed green
    // while the real classifier was broken -- review proved it by making the
    // ternary prefix mandatory and reinstating a genuine bare-form site with
    // every test still passing.
    const probe = (source: string): number =>
      collectFrom(
        ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true),
        'probe.ts'
      ).length;

    const DETECTED: Record<string, string> = {
      // classifier 1: the logger sits on the PRECEDING line
      backwardShape:
        'try { a(); } catch (e) {\n  log(\n    `x: ${e instanceof Error ? e.message : String(e)}`\n  );\n}',
      // classifier 1: a local alias, not `logger.x(`
      aliasLogger: 'try { a(); } catch (e) { warn(`x: ${String(e)}`); }',
      // classifiers 1 and 2: the word `throw` in a COMMENT
      commentedThrow: 'try { a(); } catch (e) {\n  // does not throw here\n  log(String(e));\n}',
      // classifier 2: the bare spelling, no `instanceof` prefix
      bareForm: 'try { a(); } catch (e) { log(`x: ${String(e)}`); }',
      // classifier 2: an arrow `.catch` handler
      arrowCatch: 'p.catch((e) => {\n  log(String(e));\n  return [];\n});',
      // classifier 2: degrades by RETURN and logs nothing at all
      silentReturn: 'try { a(); } catch (e) {\n  last = String(e);\n  return undefined;\n}',
      // a CONDITIONAL rethrow still leaves the other path swallowing
      conditionalRethrow: 'try { a(); } catch (e) {\n  if (x) { throw e; }\n  log(String(e));\n}',
      // --- the shapes classifier 3 got wrong, one per exit kind, each NESTED
      // ahead of a trailing rethrow. The shallow predicate saw only the
      // trailing `throw` and called all four "throwing". `nestedContinue` is
      // `ec2-provider.ts`'s `deleteVpc` reduced to its essentials.
      nestedContinue:
        'for (;;) {\n  try { a(); } catch (e) {\n    if (String(e).includes("x")) { continue; }\n    throw e;\n  }\n}',
      nestedBreak:
        'for (;;) {\n  try { a(); } catch (e) {\n    if (String(e).includes("x")) { break; }\n    throw e;\n  }\n}',
      nestedReturn:
        'try { a(); } catch (e) {\n  if (String(e).includes("x")) { return undefined; }\n  throw e;\n}',
      // an `if` throws unconditionally ONLY when BOTH arms do
      ifOnlyThenThrows: 'try { a(); } catch (e) {\n  if (x) { throw e; }\n  else { log(String(e)); }\n}',
      // THE SHAPE THE ROUND-3 DEFECT WAS, and the one no fixture covered: the
      // `String` is computed in ONE statement, the exit is in a LATER one, and
      // a `throw` follows it. Reduced from `ec2-provider.ts`'s `deleteVpc`.
      // Without this, replacing the in-order suffix walk with
      // `suffix.some(alwaysThrows)` passes the whole suite -- measured.
      suffixExitBeforeThrow:
        'for (;;) {\n  try { a(); } catch (e) {\n    const m = String(e);\n    if (m.includes("x")) { continue; }\n    throw e;\n  }\n}',
      // the same, exiting by `return` rather than `continue`
      suffixReturnBeforeThrow:
        'try { a(); } catch (e) {\n  const m = String(e);\n  if (m.includes("x")) { return undefined; }\n  throw e;\n}',
      // a `break` that carries a LABEL leaves the handler even from inside a
      // nested loop, so it is never discounted as loop-local
      labelledBreakOutOfNestedLoop:
        'outer: for (;;) {\n  try { a(); } catch (e) {\n    const m = String(e);\n    for (;;) { if (m) { break outer; } }\n    throw e;\n  }\n}',
      // an empty LAST clause falls past the switch
      switchEmptyLastClause:
        'try { a(); } catch (e) {\n  log(String(e));\n  switch (k) {\n    default: throw e;\n    case 1:\n  }\n}',
      // `finally` alone does not make a `try` throw
      tryFinallyOnly:
        'try { a(); } catch (e) {\n  log(String(e));\n  try { b(); } finally { c(); }\n}',
      // --- one per CONJUNCT of `alwaysThrows`. Round 5 measured all five
      // unfenced, every one failing UNSAFE: delete the conjunct, the suite stays
      // green, and a real site drops OUT of the enforced bucket. Same shape as
      // round 4's blocker, one layer in -- the fixtures then covered the EXITS,
      // and nothing covered the throw test's own arms.
      // `if` with no else: the then-arm throwing does not make the `if` throw.
      // Review reported the `elseStatement !== undefined` conjunct as an
      // unfenced UNSAFE branch. It is a TYPE guard rather than a decision, and
      // the probe that shows it takes TWO parts: delete the conjunct ALONE and
      // this file reds with `TypeError: Cannot read properties of undefined
      // (reading 'kind')` from `alwaysThrows`; add `if (stmt === undefined)
      // return false;` as well and the suite is GREEN -- i.e. once the crash is
      // removed, no verdict moves. An earlier revision of this comment said the
      // one-part probe was green and told the next reader not to look for the
      // mutant. Both halves were false, and it was published in the same commit
      // whose message warns against taking a review note on trust. The fixture
      // stays: it pins that this shape is DETECTED, which a rewrite can break.
      ifThenThrowsNoElse:
        'try { a(); } catch (e) {\n  const m = String(e);\n  if (m.includes("x")) { throw e; }\n  log(m);\n}',
      // ...and the mirror of `ifOnlyThenThrows`: only the ELSE arm throws.
      ifOnlyElseThrows:
        'try { a(); } catch (e) {\n  if (x) { log(String(e)); } else { throw e; }\n}',
      // a `try` whose CATCH throws still completes when the try block does not.
      innerTryCatchThrowsOnly:
        'try { a(); } catch (e) {\n  log(String(e));\n  try { b(); } catch (f) { throw f; }\n}',
      // ...and one whose TRY throws but whose catch swallows it.
      innerTryBlockThrowsOnly:
        'try { a(); } catch (e) {\n  log(String(e));\n  try { throw new Error("y"); } catch (f) { g(); }\n}',
      // a `switch` with a default does not always-throw unless EVERY clause does.
      switchOnlyDefaultThrows:
        'try { a(); } catch (e) {\n  log(String(e));\n  switch (k) {\n    case 1: b(); break;\n    default: throw e;\n  }\n}',
      // a `continue` inside a nested SWITCH targets the enclosing loop, so it
      // leaves the handler -- a switch catches `break`, never `continue`.
      continueInsideNestedSwitch:
        'for (;;) {\n  try { a(); } catch (e) {\n    const m = String(e);\n    switch (k) {\n      case 1: if (m) { continue; }\n    }\n    throw e;\n  }\n}',
      // A FLOATING `Promise.reject(e);` is not a `return`, so control continues
      // past it. Deleting `isRejectingReturn`'s own `isReturnStatement` test
      // reads it as always-throwing -- UNSAFE, and unwatched until now
      // (measured: 9 `return Promise.reject` in tree, 0 unreturned).
      floatingPromiseReject:
        'try { a(); } catch (e) {\n  log(String(e));\n  Promise.reject(e);\n}',
      // a `switch` with no default can fall past every clause
      switchNoDefault:
        'try { a(); } catch (e) {\n  switch (k) {\n    case 1: log(String(e)); throw e;\n  }\n}',
    };
    for (const [label, src] of Object.entries(DETECTED)) {
      expect(probe(src), `${label} must be classified swallowing`).toBeGreaterThan(0);
    }

    const REFUSED: Record<string, string> = {
      // an unconditional rethrow is the OTHER bucket (#3341), not this one
      rethrows: 'try { a(); } catch (e) {\n  log(String(e));\n  throw e;\n}',
      // a DIFFERENT identifier is not the caught value
      otherIdentifier: 'try { a(); } catch (e) { log(String(count)); }',
      // `Promise.reject` is a rethrow in promise clothing
      rejects: 'try { a(); } catch (e) {\n  log(String(e));\n  return Promise.reject(e);\n}',
      // --- the NEGATIVE half of the round-3 fix. Widening "can leave without
      // throwing" is only correct if these still refuse; without them the fix
      // could have been `return true`, and every fixture above would pass.
      nestedThrowBothArms:
        'try { a(); } catch (e) {\n  log(String(e));\n  if (x) { throw e; } else { throw new Error("y"); }\n}',
      throwInsideBlock: 'try { a(); } catch (e) {\n  log(String(e));\n  {\n    throw e;\n  }\n}',
      // a `return` inside a CALLBACK leaves the callback, not the handler
      returnInCallback:
        'try { a(); } catch (e) {\n  log(String(e));\n  items.forEach((i) => {\n    return i;\n  });\n  throw e;\n}',
      // every clause throws AND a default exists, so the switch cannot fall past
      switchAllClausesThrow:
        'try { a(); } catch (e) {\n  log(String(e));\n  switch (k) {\n    case 1: throw e;\n    default: throw new Error("y");\n  }\n}',
      // the HOST statement itself throws -- the dominant real shape, and the
      // only decision point that was tied to the tree's own contents
      hostIsTheThrow:
        'try { a(); } catch (e) {\n  throw new Error(`wrapped: ${String(e)}`);\n}',
      // an UNLABELLED `break` inside a loop the handler itself declares targets
      // THAT loop, not the handler
      breakBelongsToNestedLoop:
        'try { a(); } catch (e) {\n  const m = String(e);\n  for (;;) { if (m) { break; } }\n  throw e;\n}',
      // ...and the same for a `continue`
      continueBelongsToNestedLoop:
        'try { a(); } catch (e) {\n  const m = String(e);\n  for (;;) { if (m) { continue; } }\n  throw e;\n}',
      // A `break` inside a nested SWITCH targets that switch, not the handler.
      // This is the OTHER half of the round-5 `nestedLoop` / `nestedSwitch`
      // split; only the `continue` half was watched, so deleting `nestedSwitch`
      // outright left the suite green.
      breakBelongsToNestedSwitch:
        'try { a(); } catch (e) {\n  const m = String(e);\n  switch (k) {\n    case 1: if (m) { break; }\n  }\n  throw e;\n}',
      // a `return` inside a nested FUNCTION DECLARATION leaves that function
      returnInNestedFunctionDeclaration:
        'try { a(); } catch (e) {\n  log(String(e));\n  function h() { return 1; }\n  throw e;\n}',
      // ...and inside a function EXPRESSION
      returnInFunctionExpression:
        'try { a(); } catch (e) {\n  log(String(e));\n  const h = function () { return 1; };\n  throw e;\n}',
      // a labelled statement wrapping an unconditional throw still throws
      labelledThrow: 'try { a(); } catch (e) {\n  log(String(e));\n  lbl: { throw e; }\n}',
    };
    for (const [label, src] of Object.entries(REFUSED)) {
      expect(probe(src), `${label} must NOT be classified swallowing`).toBe(0);
    }
  });

  it('reads the whole subtree, so a walk that stopped early cannot pass', () => {
    // With the enforced population empty, a scan that read nothing satisfies
    // the first case. Assert the INPUT separately.
    expect(files.length).toBeGreaterThan(90);
    expect(files.filter((f) => f.includes('/providers/')).length).toBeGreaterThan(70);
    // ...and that it reaches BEYOND `providers/`, which the previous revision
    // did not: it read `providers/*.ts` plus exactly one other file while its
    // own header claimed `src/provisioning/**`.
    expect(files.filter((f) => !f.includes('/providers/')).length).toBeGreaterThan(20);
  });
});
