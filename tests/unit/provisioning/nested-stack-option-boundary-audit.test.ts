/**
 * Makes the parent→child option audit MECHANICAL (issue
 * [#2567](https://github.com/go-to-k/cdkd/issues/2567)).
 *
 * `NestedStackProvider.runChildDeploy` spreads the parent's whole
 * `DeployEngineOptions` bag into the CHILD engine. Everything the parent
 * validated against ITS OWN template, state and live AWS arrives there
 * unvalidated for the child — which is how a bare `--recreate-via-*` id set
 * came to match a child resource that merely shared a logical id, skipping the
 * child's stateful guard.
 *
 * The remedy was a comment at the spread site enumerating which members name a
 * stack (or a resource in one) and why each is safe. That enumeration went
 * through three hand-written revisions in one review — "two members", then
 * four — and nothing watched it, so a FIFTH member would silently re-open the
 * question. `.claude/skills/work-issues/references/implement.md`: a list that
 * must stay in sync with the repo is a test, not a sentence.
 *
 * This is deliberately a MEMBERSHIP fence, not a semantic one. It cannot decide
 * whether a new option names a stack — that is the judgment the audit exists to
 * make. What it can do is refuse to let a new member arrive unnoticed: adding
 * one reds this case, and clearing it requires walking the audit and recording
 * the verdict here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const DEPLOY_ENGINE = readFileSync(join(REPO_ROOT, 'src/deployment/deploy-engine.ts'), 'utf8');
const NESTED_STACK_PROVIDER = readFileSync(
  join(REPO_ROOT, 'src/provisioning/providers/nested-stack-provider.ts'),
  'utf8'
);

/**
 * Every `DeployEngineOptions` member, as of the audit recorded at the spread
 * site. A member NOT in this list is unreviewed against the parent→child
 * boundary — that is the whole signal.
 */
const AUDITED_MEMBERS = [
  // --- names a stack, or a resource in one (the audit's subject) -------------
  'recreateTargets', // self-scoped: matched only while deploying its `stackName`
  'onCurrentStateLoaded', // self-scoped: the prefix gate returns early on a mismatch
  'parentStackInfo', // overwritten by the spread site, must describe THIS child
  'eventRecorder', // carries the top-level run's stack name, by design
  // --- names no resource ------------------------------------------------------
  'concurrency',
  'dryRun',
  'lockTimeout',
  'parameters',
  'noRollback',
  'roleArn',
  'resourceWarnAfterMs',
  'resourceTimeoutMs',
  'resourceWarnAfterByType',
  'resourceTimeoutByType',
  'captureObservedState',
  'assetRedirect',
  'inheritedSecrets',
  'replace',
  'forceStatefulRecreation',
  'strictGetAtt',
  'cfnFallback',
  'skipFinalSnapshot',
  'finalSnapshotClients',
];

/** The interface body, sliced once and shared by the parse and the fail-closed scan. */
function interfaceBody(): string {
  const start = DEPLOY_ENGINE.indexOf('export interface DeployEngineOptions {');
  if (start === -1) throw new Error('DeployEngineOptions interface not found');
  const end = DEPLOY_ENGINE.indexOf('\n}', start);
  if (end === -1) throw new Error('DeployEngineOptions interface close not found');
  return DEPLOY_ENGINE.slice(start, end);
}

/**
 * A top-level member declaration, at exactly two spaces of indent.
 *
 * `readonly` is optional; `_` and `$` are legal in a member name. Both
 * omissions made an earlier revision fail OPEN — a `readonly newOption?: T` and
 * a `target_stack?: T` were simply invisible, and the count floor cannot notice
 * a member it never parsed.
 */
const MEMBER_DECL = /^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\??:/;

/**
 * Lines inside the body that are legitimately not member declarations.
 *
 * Comment lines are matched at ANY indent: a JSDoc block opens at two spaces
 * (`  /**`) and continues at three (`   * ...`), and the members here are
 * documented heavily, so a two-space-only rule rejects hundreds of comment
 * continuation lines. The structural closers stay pinned to two spaces, since
 * a deeper one belongs to a nested literal the walk is already tracking.
 */
const NON_MEMBER_LINE = /^(?:\s*(?:\/\*\*|\*\/|\*|\/\/)| {2}(?:\}[,;]?|\)))/;

/** Top-level member names of the `DeployEngineOptions` interface. */
function declaredMembers(): string[] {
  // Top-level members only: exactly two leading spaces. A nested object's
  // members are indented further, so `parentStackInfo`'s own fields do not leak
  // in and inflate the list.
  return [...interfaceBody().matchAll(new RegExp(MEMBER_DECL.source, 'gm'))].map(
    (m) => m[1]!
  );
}

/**
 * A line with string literals and trailing comments removed.
 *
 * Both can carry braces that are not structure: `dryRun?: '{' | boolean;` and a
 * trailing `// }` each shifted the balance by one, and a CRAFTED PAIR of them
 * (one `{` before a span, one `}` after) returned the walk to depth 0 while
 * everything between went unclassified — measured green with a member planted
 * inside. Stripping them first removes the whole class rather than the two
 * spellings that were found.
 */
function structuralPart(line: string): string {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\/.*$/, '');
}

/** `{`/`(` opened minus closed on a line, after the non-structural parts are stripped. */
function braceBalance(line: string): number {
  let delta = 0;
  for (const ch of structuralPart(line)) {
    if (ch === '{' || ch === '(') delta++;
    else if (ch === '}' || ch === ')') delta--;
  }
  return delta;
}

/** The walk's result: unrecognised lines, plus whether it ended balanced. */
interface Walk {
  unparsed: string[];
  endDepth: number;
}

/**
 * Walk the interface body, classifying every line.
 *
 * This is the FAIL-CLOSED half, and it is the point. Spellings escaped a
 * patched-per-spelling regex twice (`readonly`, `snake_case`, method shorthand;
 * then a member at the WRONG INDENT), which is the signal to stop patching and
 * refuse what is not modelled instead.
 *
 * DEPTH BY BALANCE, not by a close-line pattern: an earlier spelling
 * decremented only on `/^ {2}\}[,;]?$/`, so a `Readonly<{ … }>` wrap made the
 * walk skip 150 lines and three top-level members with no signal at all.
 *
 * CONTINUATION, not one line per member: a member whose type wraps
 * (`foo?: Record<\n string,\n boolean\n>;` — a shape this repo already uses)
 * carries no brace on its first line, so a balance-only walk saw its
 * continuation lines as unclassified and false-red. A declaration runs until a
 * line ends the statement at depth 0.
 */
function walkBody(): Walk {
  const unparsed: string[] = [];
  let depth = 0;
  let inStatement = false;
  for (const line of interfaceBody().split('\n').slice(1)) {
    if (line.trim() === '') continue;
    if (/^\s*(?:\/\*\*|\*\/|\*|\/\/)/.test(line)) continue;
    const structural = structuralPart(line).trimEnd();
    if (depth > 0 || inStatement) {
      depth += braceBalance(line);
      if (depth === 0 && structural.endsWith(';')) inStatement = false;
      continue;
    }
    if (NON_MEMBER_LINE.test(line) || MEMBER_DECL.test(line)) {
      depth += braceBalance(line);
      // A declaration that neither closed on this line nor opened a literal is
      // still running (a wrapped generic or union).
      if (depth === 0 && !structural.endsWith(';')) inStatement = true;
      continue;
    }
    unparsed.push(line);
  }
  return { unparsed, endDepth: depth };
}

describe('the parent→child option boundary audit stays complete (#2567)', () => {
  it('finds the interface and a plausible number of members — the anti-vacuity floor', () => {
    // Without this, a parse that silently returned [] would make the set
    // comparison below trivially satisfiable in one direction.
    expect(declaredMembers().length).toBeGreaterThanOrEqual(20);
  });

  it('parses every declaration in the interface body — fails CLOSED on an unmodelled one', () => {
    // Without this, a spelling the regex does not model (a method shorthand, a
    // quoted key, a decorator) is simply absent from `declaredMembers()`, so
    // the membership comparison below is satisfied while the interface and the
    // audit disagree. `vanished` cannot see it either: it only catches an
    // AUDITED name going away.
    expect(
      walkBody().unparsed,
      'a DeployEngineOptions line was not recognised as a member declaration. Model it in ' +
        'MEMBER_DECL (and audit the member against the parent→child boundary), or add its ' +
        'shape to NON_MEMBER_LINE if it declares nothing.'
    ).toEqual([]);
  });

  it('the walk ends BALANCED — it did not skip a span', () => {
    // The failure mode a fail-closed scan hides best: the walk enters a nested
    // literal, never sees a close it recognises, and treats everything after it
    // as nested — reporting no unparsed lines because it stopped looking.
    // Measured at 150 skipped lines and three invisible members before the
    // balance walk replaced a close-line pattern.
    expect(
      walkBody().endDepth,
      'the interface walk did not end at depth 0, so an unknown number of member ' +
        'declarations were never classified and the scan is inert over that span. Either a ' +
        'nested literal never closed, or a brace/paren that is not structure slipped past ' +
        '`structuralPart` — check that before assuming the interface is malformed.'
    ).toBe(0);
  });

  it('every DeployEngineOptions member has been walked against the boundary', () => {
    const unaudited = declaredMembers().filter((m) => !AUDITED_MEMBERS.includes(m));
    expect(
      unaudited,
      'a new DeployEngineOptions member is not in the audit. It is spread into every ' +
        'nested child engine by NestedStackProvider.runChildDeploy, so decide whether it ' +
        'names a stack (or a resource in one) and therefore needs scoping — then add it ' +
        'here and, if it does, to the comment at that spread site.'
    ).toEqual([]);
  });

  it('no audited member has been REMOVED without updating the audit', () => {
    // The other direction: a stale entry means the audit describes an option
    // that no longer exists, which is how an enumeration rots into fiction.
    const declared = declaredMembers();
    const vanished = AUDITED_MEMBERS.filter((m) => !declared.includes(m));
    expect(
      vanished,
      'the audit names DeployEngineOptions members that no longer exist — remove them here ' +
        'and from the comment at the nested-stack spread site'
    ).toEqual([]);
  });

  it('the spread site still names the four stack-naming members', () => {
    // The audit's verdict lives in prose; this pins that the prose still names
    // each member it claims to have walked, so deleting one from the comment
    // fails rather than quietly narrowing the claim.
    //
    // Scoped to the COMMENT, not the file. `parentStackInfo` also appears as
    // real code a few lines below the spread, so a whole-file `toContain` could
    // not tell "the comment names it" from "the code mentions it" — deleting it
    // from the comment left this case green.
    const commentStart = NESTED_STACK_PROVIDER.indexOf(
      '// THIS SPREAD IS THE PARENT→CHILD OPTION BOUNDARY.'
    );
    expect(commentStart, 'the parent→child boundary comment was not found').toBeGreaterThan(-1);
    const commentEnd = NESTED_STACK_PROVIDER.indexOf(
      '...(parentCtx.options ?? {}),',
      commentStart
    );
    expect(commentEnd, 'the boundary comment no longer precedes the options spread').toBeGreaterThan(
      commentStart
    );
    const comment = NESTED_STACK_PROVIDER.slice(commentStart, commentEnd);
    for (const member of [
      'recreateTargets',
      'onCurrentStateLoaded',
      'parentStackInfo',
      'eventRecorder',
    ]) {
      expect(
        comment,
        `the parent→child boundary comment no longer names \`${member}\``
      ).toContain(member);
    }
  });
});
