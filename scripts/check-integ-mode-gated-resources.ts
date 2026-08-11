/**
 * Classifier for the integ-fixture mode-gating trap (issue #1543).
 *
 * Multi-step fixtures drive their phases with
 * `CDKD_TEST_UPDATE=<comma,separated,modes>` and the stack reads
 * `updateMode.includes('x')`. Gating a NEW resource on a NEW token is the
 * natural spelling, and it is WRONG whenever a later deploy in the same
 * `verify.sh` runs with a mode list that omits the token: the resource leaves
 * the template and cdkd correctly DELETEs it.
 *
 * Found by hand during #1512, before the run reached it.
 * `OnDemandReplicaTable` gated its `eu-west-1` replica on a `cross-region`-ish
 * token; the fixture then deploys several more times with mode lists that omit
 * it, so an earlier step would have removed the replica FROM A STILL-LIVE
 * TABLE — the operation that arms DynamoDB's 24h source-region delete lock
 * (#1442 wedged a table in `UPDATING` for 90+ minutes exactly that way). The
 * fixture comments, the commit message and the issue comment had all already
 * claimed the design "only ever ADDs". Nothing would have caught the
 * contradiction.
 *
 * Unlike the order-insensitivity rule (which needs a human to decide whether a
 * list is order-significant), both halves here are statically extractable:
 *
 *   - the ORDERED list of `CDKD_TEST_UPDATE=` mode lists per deploy invocation
 *     in `verify.sh` (reusing the `check-integ-cli-flags` invocation parser,
 *     which already handles the inline-env-prefix form and the `${CLI}`
 *     variable spellings 135 of the fixtures use);
 *   - the CONDITION each gated declaration in the fixture stack sits behind
 *     (TS Compiler API, as the other classifiers do).
 *
 * The verdict is then per DECLARATION rather than per token, which the issue's
 * framing does not make obvious but the real tree forces: `useProvisioned =
 * useAutoScaling || updateMode.includes('billing-provisioned')` gates one
 * declaration on TWO tokens, so "is token T absent later?" reports a drop at a
 * step where `autoscaling` still holds the declaration in the template. Each
 * gate therefore carries an evaluable condition tree, and a step's mode list is
 * evaluated against it.
 *
 * Two deliberate widenings of the issue's stated rule:
 *
 *   - The issue asks about a deploy AFTER THE LAST one carrying the token. A
 *     gap BETWEEN two carrying deploys is the same bug and strictly worse (the
 *     resource is deleted and then re-created), so the rule is "present at some
 *     step i, absent at some step j > i".
 *   - A deploy inside a shell `if` is treated as always running. If the branch
 *     is taken the drop happens, and a lint that assumed otherwise would go
 *     quiet on exactly the opt-in blocks (`CDKD_INTEG_MULTI_REGION=1`) where
 *     the expensive, stateful resources live.
 *
 * SEVERITY is encoded in the message, not in the verdict, per the issue:
 * dropping a plain queue mid-run is free; dropping a DynamoDB replica / RDS
 * instance / stateful store is the whole problem. The lint flags every dropped
 * DECLARATION and lets the rationale comment carry the decision.
 *
 * Deliberate scope: only declarations that CREATE something (a construct
 * instantiation, or an entry in a resource list such as `replicas: [...]`) are
 * CI-blocking. A scalar property gate (`deletionProtection: true` behind
 * `deletion-protection`) is reported as `property` and does NOT block —
 * flipping a property back off is an ordinary in-place update test, and the
 * dynamodb-globaltable fixture does it on purpose at its structural-teardown
 * step. Blocking those would have made the lint's first real-tree run a wall
 * of rationale comments on correct fixtures, which is how a checker gets
 * disabled.
 *
 * ESCAPE HATCH: a fixture that WANTS to exercise the removal marks the
 * declaration with `// allow-mode-gated-drop: <reason>` (the step-12d replica
 * removal on the dynamodb-globaltable main table is exactly that). The reason
 * is mandatory — a bare marker is rejected — so the decision is recorded
 * rather than merely silenced.
 *
 * KNOWN BOUNDS, measured rather than predicted (a 3-axis review found each):
 *
 *   1. A gate whose condition is mode-derived but not reducible to a token set
 *      (`onDemandReplicaMode !== 'none'`) reports `inconclusive-gate`, not a
 *      verdict. That is deliberate — the alternative was dropping it silently,
 *      which is what the first version did to the one declaration this lint was
 *      written for. Widening the reducer (comparisons, `Set.has`, non-`split`
 *      mode bindings) would convert those notes into real verdicts.
 *   2. `resource-list` is a SHAPE test (an array of object literals), so a
 *      gated `tags: [{ key, value }]` classifies as one and would BLOCK if a
 *      later step dropped its token. No fixture does that today; the escape
 *      hatch is the remedy if one ever does.
 *   3. An `allow-mode-gated-drop:` marker attached to a STATEMENT silences
 *      every gate inside that statement, not just the nearest one.
 *   4. A deploy inside a shell FUNCTION is counted at the definition site; its
 *      call sites are invisible.
 *
 * This module is separate from the test so the classifier can be table-tested
 * against synthetic shapes rather than only against today's tree.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-v6';
import {
  joinContinuedLines,
  splitShellCommands,
  stripTrailingComment,
  findCliVariables,
} from './check-integ-cli-flags.js';

/** The env var whose comma-separated value drives a fixture's phases. */
export const MODE_ENV = 'CDKD_TEST_UPDATE';

/**
 * `// allow-mode-gated-drop: <reason>` — the deliberate-removal opt-out.
 *
 * The reason group is deliberately allowed to match EMPTY. Requiring a
 * non-space character here made a bare `// allow-mode-gated-drop:` fail to
 * match the marker at all, so instead of being rejected as unreasoned it read
 * as "no marker present" — the annotation silently did nothing.
 */
const ALLOW_MARKER = /^\s*(?:\/\/|\/\*|\*)?\s*allow-mode-gated-drop\s*:(.*?)(?:\*\/)?\s*$/m;

// ---------------------------------------------------------------------------
// verify.sh side: the ORDERED mode list per deploy
// ---------------------------------------------------------------------------

export interface DeployStep {
  /** 1-based line of the invocation. */
  line: number;
  /**
   * The mode tokens in effect for this deploy, or `null` when the value could
   * not be resolved statically (a shell variable / command substitution).
   * `null` is NOT silently skipped — see {@link lintFixture}.
   */
  modes: string[] | null;
  raw: string;
}

/**
 * Drop heredoc BODIES before parsing. A body is data: a
 * `CDKD_TEST_UPDATE=... deploy` line inside `<<EOF` sets nothing and deploys
 * nothing, but read as live script it would set the ambient mode list for the
 * whole rest of the file. Mirrors `check-integ-cdk-cli-pins.ts`'s private
 * `stripHeredocs` (kept local rather than widening that module's export
 * surface for one caller).
 */
function stripHeredocBodies(script: string): string {
  const out: string[] = [];
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]!);
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(lines[i]!);
    if (!m) continue;
    const endRe = new RegExp(`^\\s*${m[1]!}\\s*$`);
    i += 1;
    while (i < lines.length && !endRe.test(lines[i]!)) i += 1;
    if (i < lines.length) out.push(lines[i]!); // keep the terminator
  }
  return out.join('\n');
}

/** Strip one layer of matching quotes from a shell RHS. */
function unquote(rhs: string): string {
  const m = /^(["'])([\s\S]*)\1$/.exec(rhs);
  return m ? m[2]! : rhs;
}

/**
 * Expand `${VAR}` / `$VAR` against the literal variables in scope at this line.
 *
 * The MONOTONIC SUFFIX idiom is why this exists rather than being a nicety:
 * `.claude/rules/testing.md` prescribes carrying a token forward with
 * `CDKD_TEST_UPDATE=ttl,tags${OD_MODE_SUFFIX}`, where the suffix is seeded
 * empty and set once the resource exists. That is the CORRECT fix for the bug
 * this lint checks, so a parser that gave up on `$` would report
 * `unresolvable-mode-list` on precisely the fixtures that did the right thing —
 * turning the lint into a blocker against its own recommended pattern.
 *
 * Assignments are applied in SOURCE ORDER (last one before the invocation
 * wins), which models a linear script exactly and a conditional assignment
 * conservatively — the same "assume the branch is taken" stance
 * {@link parseDeploySteps} takes for a deploy inside an `if`.
 *
 * @returns the expanded string, or `null` when a reference cannot be resolved.
 */
function expandVars(value: string, vars: Map<string, string>): string | null {
  // A command substitution is never resolvable here.
  if (/`|\$\(/.test(value)) return null;

  let unresolved = false;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const name = (a ?? b) as string;
    const known = vars.get(name);
    if (known === undefined) {
      unresolved = true;
      return '';
    }
    return known;
  });

  // Any surviving `$` means a form this expander does not model — `${VAR:-def}`,
  // `${VAR#pat}`, `$1`. Returning the literal text would leave it glued to a
  // token (`alpha${SUF:-}`), so the token reads ABSENT and a correct fixture
  // gets a false `dropped-mid-run`. `${VAR:-}` is one keystroke from the
  // monotonic-suffix idiom this expander exists for, so it is not hypothetical.
  if (unresolved || expanded.includes('$')) return null;
  return expanded;
}

function parseModeValue(rhs: string, vars: Map<string, string>): string[] | null {
  const expanded = expandVars(unquote(rhs), vars);
  if (expanded === null) return null;
  return expanded
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pull the ordered `cdkd deploy` invocations out of a verify.sh, each with the
 * mode list in effect for it.
 *
 * The value comes from the invocation's own inline env prefix
 * (`CDKD_TEST_UPDATE=a,b ${CLI} deploy ...`) when it has one, else from the
 * AMBIENT value a previous `export CDKD_TEST_UPDATE=` / bare assignment left
 * set (and `unset CDKD_TEST_UPDATE` clears it back to empty). Missing the
 * ambient form would read a whole fixture's deploys as unmoded and report
 * nothing, so it is tracked rather than assumed absent.
 */
export function parseDeploySteps(content: string): DeployStep[] {
  const cliVars = findCliVariables(content);
  const cliRef = [...cliVars]
    .map((v) => `\\$\\{${v}\\}|\\$${v}\\b`)
    .concat(['cli\\.js'])
    .join('|');
  const steps: DeployStep[] = [];
  let ambient: string[] | null = [];
  /** Literal shell variables in scope, updated in source order. */
  const vars = new Map<string, string>();

  const assignment = new RegExp(
    String.raw`^\s*(?:export\s+)?${MODE_ENV}=(".*?"|'.*?'|\S*)\s*(?:#.*)?$`,
  );
  // Any other simple `NAME=<literal>` assignment, so the monotonic-suffix
  // idiom resolves. A non-literal RHS REMOVES the name from the table rather
  // than being ignored, so a later expansion reports unresolvable instead of
  // silently reusing a stale value.
  // The RHS alternation carries an explicit `$( … )` / backtick arm so a
  // command substitution (`SUF=$(echo ,beta)`, which contains SPACES) still
  // MATCHES and therefore invalidates the name. A space-free-only RHS never
  // matched it, so the variable silently kept its previous value and the step
  // read a stale mode list instead of reporting unresolvable. The end-of-line
  // anchor is what keeps this from swallowing an inline env PREFIX
  // (`CDKD_TEST_UPDATE=a ${CLI} deploy …` is a command, not an assignment).
  const otherAssignment =
    /^\s*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\$\([^)]*\)|`[^`]*`|\S*)\s*(?:#.*)?$/;
  // Scan EVERY assignment in the invocation's env prefix, not just one anchored
  // at the start of the segment. Two shapes that already exist in the tree read
  // as UNMODED under an anchored match — `CDKD_TEST_REMOVAL=true
  // CDKD_TEST_UPDATE=alpha ${CLI} deploy` and `env -u OTHER
  // CDKD_TEST_UPDATE=alpha ${CLI} deploy` — and an unmoded read is a CI-BLOCKING
  // false positive on a correct fixture, not a miss. (The leading `\s*` is
  // equally load-bearing: every deploy inside a shell `if` block is INDENTED,
  // and demanding column 0 muted the one real finding this lint exists for
  // while still reporting the harmless property gates.)
  const inlinePrefix = new RegExp(String.raw`(?:^|[\s;&|(])${MODE_ENV}=(".*?"|'.*?'|\S*)`, 'g');
  const deployCall = new RegExp(String.raw`(?:${cliRef})[^;&|]*?\bdeploy\b`);

  for (const { text, line } of joinContinuedLines(stripHeredocBodies(content))) {
    const stripped = stripTrailingComment(text);

    if (new RegExp(String.raw`^\s*unset\s+${MODE_ENV}\b`).test(stripped)) {
      ambient = [];
      continue;
    }
    const bare = assignment.exec(stripped);
    if (bare) {
      ambient = parseModeValue(bare[1]!, vars);
      continue;
    }
    const other = otherAssignment.exec(stripped);
    if (other) {
      const expanded = expandVars(unquote(other[2]!), vars);
      if (expanded === null) vars.delete(other[1]!);
      else vars.set(other[1]!, expanded);
      continue;
    }

    for (const segment of splitShellCommands(stripped)) {
      if (!deployCall.test(segment)) continue;
      // Last assignment wins, matching the shell.
      inlinePrefix.lastIndex = 0;
      let inline: RegExpExecArray | null = null;
      for (let m = inlinePrefix.exec(segment); m !== null; m = inlinePrefix.exec(segment)) {
        inline = m;
      }
      steps.push({
        line,
        modes: inline ? parseModeValue(inline[1]!, vars) : ambient,
        raw: segment.trim(),
      });
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Stack side: the CONDITION behind each gated declaration
// ---------------------------------------------------------------------------

export type Cond =
  | { t: 'token'; token: string }
  | { t: 'and'; l: Cond; r: Cond }
  | { t: 'or'; l: Cond; r: Cond }
  | { t: 'not'; e: Cond }
  /**
   * A leaf that IS a mode-list read but whose token could not be resolved —
   * `updateMode.includes(SOME_CONST)`. Kept distinct from `unknown` because it
   * still makes the gate mode-derived: collapsing the two dropped such a gate
   * from the analysis entirely, which is the silent skip this lint exists to
   * avoid.
   */
  | { t: 'unknown-token' }
  /** A leaf that is not a mode-list read at all (e.g. another env var). */
  | { t: 'unknown' };

/** What the gated subtree brings into the template. */
export type GateKind = 'construct' | 'resource-list' | 'property';

export interface ModeGate {
  /** 1-based line of the gate. */
  line: number;
  cond: Cond;
  kind: GateKind;
  /** The gated source text, truncated for the message. */
  text: string;
  /** `allow-mode-gated-drop:` reason attached to the gate, if any. */
  allowReason: string | null;
}

/**
 * Evaluate a gate condition against one step's mode list.
 *
 * @returns `null` when the condition contains a leaf this classifier cannot
 *   resolve — the caller must treat that as INCONCLUSIVE, never as `false`.
 */
export function evaluateCond(cond: Cond, modes: string[]): boolean | null {
  switch (cond.t) {
    case 'token':
      return modes.includes(cond.token);
    case 'not': {
      const e = evaluateCond(cond.e, modes);
      return e === null ? null : !e;
    }
    case 'and': {
      const l = evaluateCond(cond.l, modes);
      const r = evaluateCond(cond.r, modes);
      // A definite `false` on either side settles it even when the other leaf
      // is unknown, which keeps an unrelated env var from muting the gate.
      if (l === false || r === false) return false;
      return l === null || r === null ? null : l && r;
    }
    case 'or': {
      const l = evaluateCond(cond.l, modes);
      const r = evaluateCond(cond.r, modes);
      if (l === true || r === true) return true;
      return l === null || r === null ? null : l || r;
    }
    case 'unknown-token':
    case 'unknown':
      return null;
  }
}

/** Every token named anywhere in a condition. */
export function tokensOf(cond: Cond): string[] {
  switch (cond.t) {
    case 'token':
      return [cond.token];
    case 'not':
      return tokensOf(cond.e);
    case 'and':
    case 'or':
      return [...new Set([...tokensOf(cond.l), ...tokensOf(cond.r)])];
    case 'unknown-token':
    case 'unknown':
      return [];
  }
}

/**
 * Does this condition read the mode list at all?
 *
 * NOT the same question as "does it name a token": a gate whose token is a
 * const reference is still mode-derived and must stay in the analysis (as an
 * `inconclusive-gate`) rather than vanish from it.
 */
function isModeDerived(cond: Cond): boolean {
  switch (cond.t) {
    case 'token':
    case 'unknown-token':
      return true;
    case 'not':
      return isModeDerived(cond.e);
    case 'and':
    case 'or':
      return isModeDerived(cond.l) || isModeDerived(cond.r);
    case 'unknown':
      return false;
  }
}

/**
 * Collect the mode gates in one fixture stack file.
 *
 * The `updateMode` binding is found by its INITIALIZER (anything reading
 * `process.env.CDKD_TEST_UPDATE`) rather than by name, so a fixture that calls
 * it something else is still analyzed. Only the LIST-shaped form is a gate
 * source: the three fixtures using the boolean `=== 'true'` spelling have no
 * token list and therefore no token to drop.
 */
export function collectModeGates(sourceText: string, fileName = 'stack.ts'): ModeGate[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const gates: ModeGate[] = [];

  /** Names bound to the mode LIST (`(process.env.X ?? '').split(',')...`). */
  const listBindings = new Set<string>();
  /** Names bound to a condition over the mode list. */
  const condBindings = new Map<string, Cond>();
  /**
   * Names whose VALUE derives from the mode list without being a condition this
   * classifier can reduce — `const mode = updateMode.includes('x') ? 'a' : 'b'`.
   *
   * Without this the real #1512 declaration was invisible: its gate is
   * `wantsOnDemandReplica = onDemandReplicaMode !== 'none'`, a `!==` over such a
   * string, which `toCond` reduced to `null` — so `record` returned early and
   * the `replicas: [...]` gate left the analysis ENTIRELY, with no
   * `inconclusive-gate` either. That is the exact silent skip the
   * `unknown-token` leaf exists to prevent, on the one declaration this lint
   * was written for.
   */
  const modeDerivedNames = new Set<string>();

  const isModeEnvRead = (node: ts.Node): boolean =>
    /process\s*\.\s*env\s*(\.|\[['"])/.test(node.getText()) && node.getText().includes(MODE_ENV);

  // Pass 1: bindings, in source order so a later condition can reference an
  // earlier one (`useProvisioned = useAutoScaling || ...`).
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      const init = node.initializer;
      if (isModeEnvRead(init)) {
        // A list binding only when the value is actually split into tokens;
        // the `=== 'true'` boolean form is not a token list.
        if (/\.split\s*\(/.test(init.getText())) listBindings.add(name);
      } else {
        const cond = toCond(init);
        if (cond && isModeDerived(cond)) condBindings.set(name, cond);
        else if (readsModeList(init)) modeDerivedNames.add(name);
      }
    }
    ts.forEachChild(node, collectBindings);
  };

  /**
   * Does this expression read the mode list, directly or through a name already
   * known to derive from it? Deliberately SYNTACTIC and permissive — it only
   * decides whether an unreducible gate is reported `inconclusive-gate` or
   * dropped, and dropping is the failure mode that matters.
   */
  const readsModeList = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && (listBindings.has(n.text) || modeDerivedNames.has(n.text) || condBindings.has(n.text))) {
        found = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };

  /** `<listBinding>.includes('literal')` */
  const asIncludes = (node: ts.Node): Cond | null => {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'includes') return null;
    if (!ts.isIdentifier(callee.expression) || !listBindings.has(callee.expression.text)) return null;
    const arg = node.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg)) return { t: 'unknown-token' };
    return { t: 'token', token: arg.text };
  };

  function toCond(node: ts.Node): Cond | null {
    if (ts.isParenthesizedExpression(node)) return toCond(node.expression);
    const inc = asIncludes(node);
    if (inc) return inc;
    if (ts.isIdentifier(node)) return condBindings.get(node.text) ?? null;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const e = toCond(node.operand);
      return e ? { t: 'not', e } : null;
    }
    if (ts.isIdentifier(node) && modeDerivedNames.has(node.text)) {
      return { t: 'unknown-token' };
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const l = toCond(node.left);
        const r = toCond(node.right);
        // One mode-derived side is enough; the other becomes an opaque leaf so
        // an `updateMode.includes('x') && someOtherFlag` still registers.
        if (!l && !r) return null;
        return {
          t: op === ts.SyntaxKind.AmpersandAmpersandToken ? 'and' : 'or',
          l: l ?? { t: 'unknown' },
          r: r ?? { t: 'unknown' },
        };
      }
      // Any OTHER binary operator over a mode-derived value — `!==`, `===`,
      // `>` — is not reducible to a token set, but the gate is still
      // mode-derived and must stay VISIBLE as inconclusive.
      if (readsModeList(node)) return { t: 'unknown-token' };
    }
    if (readsModeList(node)) return { t: 'unknown-token' };
    return null;
  }

  collectBindings(sf);

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const snippet = (node: ts.Node): string => {
    const text = node.getText(sf).replace(/\s+/g, ' ').trim();
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
  };

  /**
   * The `allow-mode-gated-drop:` reason attached to a gate — read from the
   * comments immediately preceding the gate's own line, or from a trailing
   * comment on it. Ranges are taken from the whole enclosing statement so the
   * marker can sit above the statement rather than glued to the expression.
   */
  const allowReasonFor = (node: ts.Node): string | null => {
    // Walk OUTWARD from the gate to the enclosing statement, checking leading
    // comments at every level. Checking only the statement's own leading
    // comments missed the common real shape: a gate spread into a big object
    // literal (`const tableProps = { ... ...(cond && { replicas }) ... }`) is
    // many levels below the statement, so an annotation written directly above
    // the spread — the only place a reader would put it — was invisible and
    // the marker silently did nothing.
    const ranges: ts.CommentRange[] = [];
    let cursor: ts.Node | undefined = node;
    while (cursor) {
      ranges.push(...(ts.getLeadingCommentRanges(sourceText, cursor.getFullStart()) ?? []));
      if (ts.isStatement(cursor)) break;
      cursor = cursor.parent;
    }
    ranges.push(...(ts.getTrailingCommentRanges(sourceText, node.getEnd()) ?? []));

    for (const range of ranges) {
      const m = ALLOW_MARKER.exec(sourceText.slice(range.pos, range.end));
      if (m) return m[1]!.replace(/\*\/\s*$/, '').trim();
    }
    return null;
  };

  /**
   * A gate that DECLARES nothing: an empty `{}` / `[]` / block (the `drop-*`
   * idiom's truthy arm), or a bare primitive (`cond ? 'dropped' : 'none'`,
   * `cond ? 40 : 20`). A primitive arm chooses a VALUE that some declaration
   * elsewhere consumes — the declaration itself is not gated, so reporting it
   * as dropped is noise that trains readers to ignore the lint.
   */
  const isNonDeclarationValue = (node: ts.Node): boolean => {
    if (ts.isObjectLiteralExpression(node)) return node.properties.length === 0;
    if (ts.isArrayLiteralExpression(node)) return node.elements.length === 0;
    if (ts.isBlock(node)) return node.statements.length === 0;
    return (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isIdentifier(node)
    );
  };

  const kindOf = (node: ts.Node): GateKind => {
    let hasNew = false;
    let hasResourceList = false;
    const walk = (n: ts.Node): void => {
      if (ts.isNewExpression(n)) hasNew = true;
      // An array of object literals under a property is an entry in a resource
      // LIST — `replicas: [{ region: 'eu-west-1' }]`, the #1512 shape. A
      // `new`-less scalar array (`['a','b']`) is not.
      if (ts.isArrayLiteralExpression(n) && n.elements.some(ts.isObjectLiteralExpression)) {
        hasResourceList = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    if (hasNew) return 'construct';
    if (hasResourceList) return 'resource-list';
    return 'property';
  };

  const record = (condNode: ts.Node, gated: ts.Node, anchor: ts.Node): void => {
    const cond = toCond(condNode);
    if (!cond || !isModeDerived(cond)) return;
    // Only the TRUTHY arm is recorded (see `visit`), so the `drop-*` idiom
    // `...(includes('drop-x') ? {} : { limit })` lands here with an EMPTY arm:
    // the token ADDS nothing, it removes the else-arm. That is a deliberate
    // removal test by construction — recording it would flag every `drop-*`
    // fixture and demand a rationale comment for the thing the token is named
    // after. An empty gated value gates nothing.
    if (isNonDeclarationValue(gated)) return;
    gates.push({
      line: lineOf(anchor),
      cond,
      kind: kindOf(gated),
      text: snippet(gated),
      allowReason: allowReasonFor(anchor),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      record(node.expression, node.thenStatement, node);
    } else if (ts.isConditionalExpression(node)) {
      // Both arms are gated — one by the condition, one by its negation. Only
      // the truthy arm is recorded: a fixture spelling the DEFAULT in the false
      // arm (`cond ? [] : [entry]`) is an add-on-absence, whose "drop" is the
      // presence of the token, and reporting both arms doubled every finding.
      record(node.condition, node.whenTrue, node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      // `...(cond && { prop })` — a gated VALUE, not a boolean sub-expression
      // of a larger condition.
      (ts.isObjectLiteralExpression(node.right) || ts.isArrayLiteralExpression(node.right))
    ) {
      record(node.left, node.right, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return gates;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type ViolationKind =
  /** Present at one step, absent at a later one — the #1543 bug. */
  | 'dropped-mid-run'
  /** A deploy whose mode list could not be resolved statically. */
  | 'unresolvable-mode-list'
  /** A gate whose condition carries a leaf this classifier cannot evaluate. */
  | 'inconclusive-gate'
  /** An `allow-mode-gated-drop:` marker with no reason after the colon. */
  | 'unreasoned-allow';

export interface Violation {
  fixture: string;
  file: string;
  line: number;
  kind: ViolationKind;
  gateKind: GateKind;
  /** CI-blocking. A `property` drop is reported for visibility only. */
  blocking: boolean;
  message: string;
}

/** Types whose mid-run removal is destructive far beyond the wasted step. */
// The trailing `s?` is not cosmetic: the shape that motivated the issue is a
// LIST property (`replicas: [...]`), so a `\bReplica\b` match misses the exact
// case and downgrades its message to the generic one.
const STATEFUL_HINT =
  /\b(Tables?|Replicas?|Buckets?|Clusters?|Instances?|Databases?|Dbs?|Volumes?|FileSystems?|Domains?|Secrets?|Repositor(?:y|ies))\b/i;

function severityHint(gate: ModeGate): string {
  if (gate.kind === 'property') {
    return 'a property, so the later step merely flips it back — visibility only';
  }
  return STATEFUL_HINT.test(gate.text)
    ? 'this looks STATEFUL — a mid-run removal can destroy data or arm a long ' +
        'AWS-side lock (a DynamoDB replica removal arms a 24h source-region delete lock)'
    : 'the resource is deleted and (if the token returns) re-created mid-run';
}

export function lintFixture(
  fixture: string,
  file: string,
  stackSource: string,
  verifySource: string,
  reportUnresolvable = true,
): Violation[] {
  const gates = collectModeGates(stackSource, file);
  if (gates.length === 0) return [];

  const steps = parseDeploySteps(verifySource);
  const violations: Violation[] = [];

  for (const gate of gates) {
    if (gate.allowReason === '') {
      violations.push({
        fixture,
        file,
        line: gate.line,
        kind: 'unreasoned-allow',
        gateKind: gate.kind,
        blocking: true,
        message: `allow-mode-gated-drop needs a reason after the colon (${gate.text})`,
      });
    }
  }

  // An unresolvable mode list makes EVERY gate's timeline unreliable, so it is
  // reported once per fixture rather than swallowed. Reporting nothing here is
  // the vacuous pass the repo's checker rules exist to forbid.
  // Reported against the FIRST stack file only: the mode timeline is a
  // property of verify.sh, so emitting it per stack file produced duplicate
  // rows for a multi-file fixture.
  const unresolvable = reportUnresolvable ? steps.filter((s) => s.modes === null) : [];
  for (const step of unresolvable) {
    violations.push({
      fixture,
      file: 'verify.sh',
      line: step.line,
      kind: 'unresolvable-mode-list',
      gateKind: 'property',
      blocking: true,
      message:
        `${MODE_ENV} is set from a shell variable or command substitution, so the ` +
        `mode timeline cannot be checked: ${step.raw.slice(0, 80)}`,
    });
  }
  if (unresolvable.length > 0) return violations;

  for (const gate of gates) {
    if (gate.allowReason) continue;

    let seenPresent = false;
    for (const step of steps) {
      const present = evaluateCond(gate.cond, step.modes!);
      if (present === null) {
        // NOT a silent skip: a condition the classifier cannot evaluate is the
        // shape in which this lint would go quiet on a real drop, so it is
        // surfaced. Non-blocking, because an undecidable condition is a limit
        // of the classifier rather than evidence of a fixture bug.
        violations.push({
          fixture,
          file,
          line: gate.line,
          kind: 'inconclusive-gate',
          gateKind: gate.kind,
          blocking: false,
          message:
            `condition carries a leaf this classifier cannot evaluate, so the mode ` +
            `timeline was not checked for it. Gate: ${gate.text}`,
        });
        break;
      }
      if (present) {
        seenPresent = true;
        continue;
      }
      if (!seenPresent) continue;

      const tokens = tokensOf(gate.cond).join(', ');
      violations.push({
        fixture,
        file,
        line: gate.line,
        kind: 'dropped-mid-run',
        gateKind: gate.kind,
        blocking: gate.kind !== 'property',
        message:
          `gated on [${tokens}] and DROPPED by the deploy at verify.sh:${step.line} ` +
          `(modes: ${step.modes!.length > 0 ? step.modes!.join(',') : '<empty>'}) — ` +
          `${severityHint(gate)}. If the removal is deliberate, mark the declaration ` +
          `with \`// allow-mode-gated-drop: <reason>\`. Gate: ${gate.text}`,
      });
      break; // one finding per declaration; the first drop is the diagnosis
    }
  }

  return violations;
}

/** Stack sources for one fixture: `lib/*.ts` plus `bin/*.ts`. */
export function fixtureStackFiles(fixtureDir: string): string[] {
  const out: string[] = [];
  for (const sub of ['lib', 'bin']) {
    const dir = join(fixtureDir, sub);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(join(sub, entry));
    }
  }
  return out;
}

export function lintFixtureTree(integRoot: string): Violation[] {
  const violations: Violation[] = [];

  for (const entry of readdirSync(integRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(integRoot, entry.name);
    const verify = join(dir, 'verify.sh');
    if (!existsSync(verify)) continue;
    const verifySource = readFileSync(verify, 'utf8');

    for (const rel of fixtureStackFiles(dir)) {
      violations.push(
        ...lintFixture(
          entry.name,
          rel,
          readFileSync(join(dir, rel), 'utf8'),
          verifySource,
          rel === fixtureStackFiles(dir)[0],
        ),
      );
    }
  }

  return violations;
}

export function formatViolation(v: Violation): string {
  const tag = v.blocking ? 'ERROR' : 'note';
  return `[${tag}] ${v.fixture}/${v.file}:${v.line} [${v.kind}/${v.gateKind}] ${v.message}`;
}
