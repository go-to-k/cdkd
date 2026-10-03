import { describe, it, expect } from 'vite-plus/test';
import {
  matchStacks,
  stackMatchesPattern,
  describeStack,
  renderNoStackMatch,
  renderNotInAppWarning,
  renderUnmatchedPatternsWarning,
  unmatchedPatterns,
} from '../../../src/cli/stack-matcher.js';
import { PATHOLOGICAL_PATTERN, withoutRegExp } from '../_without-regexp.js';

const stacks = [
  { stackName: 'TopStack', displayName: 'TopStack' },
  { stackName: 'MyStage-Api', displayName: 'MyStage/Api' },
  { stackName: 'MyStage-Db', displayName: 'MyStage/Db' },
  { stackName: 'OtherStage-Api', displayName: 'OtherStage/Api' },
];

describe('stackMatchesPattern', () => {
  it('matches by physical stackName when pattern has no slash', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage-Api')).toBe(true);
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/Api')).toBe(true);
  });

  it('routes slash-bearing patterns to displayName only', () => {
    // pattern has '/', so MyStage-Api stack only matches via displayName
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/Api')).toBe(true);
    // Same pattern won't match a stack whose displayName lacks the slash form
    expect(stackMatchesPattern(stacks[0]!, 'MyStage/Api')).toBe(false);
  });

  it('treats hyphen patterns as physical names, not display paths', () => {
    // 'MyStage-Api' must NOT match a displayName 'MyStage/Api' on its own —
    // the routing rule keeps these strictly separate.
    const stageOnly = { stackName: 'phys-name', displayName: 'MyStage/Api' };
    expect(stackMatchesPattern(stageOnly, 'MyStage-Api')).toBe(false);
  });

  it('supports wildcards on physical names', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage-*')).toBe(true);
    expect(stackMatchesPattern(stacks[2]!, 'MyStage-*')).toBe(true);
    expect(stackMatchesPattern(stacks[3]!, 'MyStage-*')).toBe(false);
  });

  it('supports wildcards on display paths (Stage-scoped selection)', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/*')).toBe(true);
    expect(stackMatchesPattern(stacks[2]!, 'MyStage/*')).toBe(true);
    expect(stackMatchesPattern(stacks[3]!, 'MyStage/*')).toBe(false);
    expect(stackMatchesPattern(stacks[0]!, 'MyStage/*')).toBe(false);
  });

  it('reads every character but `*` literally, on both routes (#3508)', () => {
    // The old expansion compiled the pattern as a RegExp whenever it held a
    // `*`, so `.` matched any character and `(` threw a SyntaxError.
    expect(stackMatchesPattern({ stackName: 'MyXStage-1' }, 'My.Stage-*')).toBe(false);
    expect(stackMatchesPattern({ stackName: 'My.Stage-1' }, 'My.Stage-*')).toBe(true);
    const display = { stackName: 'phys', displayName: 'MyXStage/Api' };
    expect(stackMatchesPattern(display, 'My.Stage/*')).toBe(false);
    expect(
      stackMatchesPattern({ stackName: 'phys', displayName: 'My(Stage/Api' }, 'My(Stage/*')
    ).toBe(true);
  });

  it('answers a catastrophic-backtracking pattern without executing any RegExp (#3508)', () => {
    const subject = 'a'.repeat(3000);
    const miss = withoutRegExp(() =>
      stackMatchesPattern({ stackName: subject }, PATHOLOGICAL_PATTERN)
    );
    expect(miss).toEqual({ value: false, regexCalls: 0 });
    const hit = withoutRegExp(() =>
      matchStacks([{ stackName: `${subject}b` }], [PATHOLOGICAL_PATTERN])
    );
    expect(hit).toEqual({ value: [{ stackName: `${subject}b` }], regexCalls: 0 });
  });

  it('falls back to stackName when displayName is missing', () => {
    const s = { stackName: 'OnlyPhysical' };
    expect(stackMatchesPattern(s, 'OnlyPhysical')).toBe(true);
    // Slash-bearing pattern still routes to displayName, which falls back
    // to stackName. A literal slash in stackName is impossible in CFN, so
    // any '/' pattern simply won't match.
    expect(stackMatchesPattern(s, 'OnlyPhysical/X')).toBe(false);
  });
});

describe('describeStack', () => {
  it('returns stackName alone when displayName matches', () => {
    expect(describeStack({ stackName: 'MyStack', displayName: 'MyStack' })).toBe('MyStack');
  });

  it('returns stackName alone when displayName is missing', () => {
    expect(describeStack({ stackName: 'MyStack' })).toBe('MyStack');
  });

  it('appends displayName when it differs from stackName', () => {
    expect(describeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' })).toBe(
      'MyStage-Api (MyStage/Api)'
    );
  });
});

describe('matchStacks', () => {
  it('returns empty when no patterns are given', () => {
    expect(matchStacks(stacks, [])).toEqual([]);
  });

  it('selects all stacks under a Stage using a display-path wildcard', () => {
    const result = matchStacks(stacks, ['MyStage/*']);
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api', 'MyStage-Db']);
  });

  it('selects exact physical name even when a Stage stack shares the prefix', () => {
    const result = matchStacks(stacks, ['MyStage-Api']);
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api']);
  });

  it('deduplicates when multiple patterns match the same stack', () => {
    const result = matchStacks(stacks, ['MyStage-Api', 'MyStage/Api']);
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api']);
  });

  it('mixes patterns and accumulates the union', () => {
    const result = matchStacks(stacks, ['TopStack', 'MyStage/*']);
    expect(result.map((s) => s.stackName).sort()).toEqual([
      'MyStage-Api',
      'MyStage-Db',
      'TopStack',
    ]);
  });

  it('preserves the input order of stacks', () => {
    const result = matchStacks(stacks, ['*Api*']);
    // Wildcard patterns without slash route to stackName.
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api', 'OtherStage-Api']);
  });
});

describe('describeStack renders assembly-chosen names as identifiers', () => {
  // Both names come from the Cloud Assembly and land in prose cdkd authors --
  // `Available: ...`, `Multiple stacks found: ...`, and `Publishing assets for
  // stack: ...`, which prints on a NORMAL run. Before go-to-k/cdkd#3482 this
  // helper applied no sanitizer at all.
  it('is the identity on every legitimate name, in both forms', () => {
    expect(describeStack({ stackName: 'TopStack' })).toBe('TopStack');
    expect(describeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' })).toBe(
      'MyStage-Api (MyStage/Api)'
    );
    // A CloudFormation name is `[A-Za-z0-9-]`; a display path adds `/`.
    expect(describeStack({ stackName: 'a-B-9' })).toBe('a-B-9');
  });

  it('quotes a name carrying terminal control characters, so it cannot erase or forge a line', () => {
    // ESC [ 2 K erases cdkd's own line, CR returns to its start and LF opens a
    // second one -- a whole fabricated line at default verbosity.
    const hostile = 'TopStack\u001b[2K\rDeploy completed. 0 errors.\nStage Prod OK';

    const rendered = describeStack({ stackName: hostile });

    // Two defences, not one: the control bytes are replaced with spaces AND
    // the result is quoted, because being altered is itself the signal.
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\n');
    expect(rendered).toBe('"TopStack [2K Deploy completed. 0 errors. Stage Prod OK"');
  });

  it('quotes a legitimate displayName carrying a space, which CDK permits', () => {
    // CDK sets `displayName` to the construct path and `constructs` rewrites
    // only `/` in an id, so `new Stack(app, 'My Stack')` is legal. The quotes
    // are not part of any pattern -- pinned so this is not later "fixed" back
    // to `displaySafe`, which would pass the quotes a crafted value needs.
    expect(describeStack({ stackName: 'MyStack', displayName: 'My Stack' })).toBe(
      'MyStack ("My Stack")'
    );
  });

  it('quotes a name that would otherwise read as a second cdkd clause', () => {
    const forging = 'TopStack. All 3 stacks deployed successfully. Stage Prod loaded fine';

    expect(describeStack({ stackName: forging })).toBe(JSON.stringify(forging));
  });

  it('carries the quoting into the Available clause', () => {
    const forging = 'TopStack. All 3 stacks deployed successfully';

    const message = renderNoStackMatch(['Absent'], [{ stackName: forging }]);

    expect(message).toBe(
      `No stacks matching Absent found in assembly. Available: ${JSON.stringify(forging)}`
    );
  });
});

describe('renderNoStackMatch', () => {
  it('lists the available stacks in the parens form the patterns accept', () => {
    expect(renderNoStackMatch(['Absent'], stacks)).toBe(
      'No stacks matching Absent found in assembly. Available: TopStack, ' +
        'MyStage-Api (MyStage/Api), MyStage-Db (MyStage/Db), ' +
        'OtherStage-Api (OtherStage/Api)'
    );
  });

  it('says only that the assembly is empty when no pattern was given', () => {
    expect(renderNoStackMatch([], [])).toBe(
      'No stacks found in assembly'
    );
  });

  it('keeps the PATTERN when the assembly is empty, and drops only the stack list', () => {
    // `Available: ` with nothing after it says less than the plain clause.
    expect(renderNoStackMatch(['MyStage/Api'], [])).toBe(
      'No stacks matching MyStage/Api found in assembly. The assembly has no stacks'
    );
  });

});

// Issue go-to-k/cdkd#3507: only `cdkd destroy` reports these, as the AWS CDK
// CLI's destroy does.
describe('unmatchedPatterns / renderUnmatchedPatternsWarning', () => {
  it('lists the patterns that matched no stack, in argument order', () => {
    expect(unmatchedPatterns(stacks, ['TopStack', 'Nope', 'MyStage/*', 'Gone*'])).toEqual([
      'Nope',
      'Gone*',
    ]);
    expect(unmatchedPatterns(stacks, ['TopStack'])).toEqual([]);
    // Deduplicated, so a repeated typo is named once.
    expect(unmatchedPatterns(stacks, ['Typo', 'Typo'])).toEqual(['Typo']);
  });

  it('words a name that is in state but not a stack of this app on its own', () => {
    expect(renderNotInAppWarning(['P~C'])).toBe(
      'P~C is in state but is not a stack of this app and was skipped. ' +
        'A nested stack is destroyed with its parent; ' +
        "another app's stack, with that app or by name through cdkd state destroy."
    );
    expect(renderNotInAppWarning(['A', 'B'])).toMatch(
      /^A, B are in state but are not stacks of this app and were skipped\. /
    );
  });

  it('warns with the patterns and where they were looked for', () => {
    expect(renderUnmatchedPatternsWarning(['Nope'], 'in state')).toBe(
      'Nope matched no stack in state and was skipped.'
    );
    expect(renderUnmatchedPatternsWarning(['A', 'B'], 'in state')).toBe(
      'A, B matched no stack in state and were skipped.'
    );
    // A pattern holding the list separator is quoted, so it cannot read as two.
    expect(renderUnmatchedPatternsWarning(['A,B', 'C'], 'in state')).toBe(
      '"A,B", C matched no stack in state and were skipped.'
    );
  });

  it('renders a forging pattern as a quoted value on one line', () => {
    const warning = renderUnmatchedPatternsWarning(['x\n[INFO] All clean'], 'in state');

    expect(warning).not.toContain('\n');
    expect(warning).toMatch(/^"/);
  });
});
