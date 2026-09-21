import { describe, it, expect } from 'vite-plus/test';
import {
  matchStacks,
  stackMatchesPattern,
  describeStack,
  renderNoStackMatch,
} from '../../../src/cli/stack-matcher.js';

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

    const message = renderNoStackMatch(['Absent'], [{ stackName: forging }], {
      failedStages: [],
    });

    expect(message).toBe(
      `No stacks matching Absent found in assembly. Available: ${JSON.stringify(forging)}`
    );
  });
});

describe('renderNoStackMatch', () => {
  it('lists the available stacks in the parens form the patterns accept', () => {
    expect(renderNoStackMatch(['Absent'], stacks, { failedStages: [] })).toBe(
      'No stacks matching Absent found in assembly. Available: TopStack, ' +
        'MyStage-Api (MyStage/Api), MyStage-Db (MyStage/Db), ' +
        'OtherStage-Api (OtherStage/Api)'
    );
  });

  it('says only that the assembly is empty when no pattern was given', () => {
    expect(renderNoStackMatch([], [], { failedStages: [] })).toBe(
      'No stacks found in assembly'
    );
  });

  // Issue go-to-k/cdkd#3482: the whole reason the synthesis result is a
  // REQUIRED argument rather than an optional extra.
  it('appends the failed Stage a pattern targets', () => {
    const message = renderNoStackMatch(['MyStage/Api'], [stacks[0]!], {
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT' }],
    });

    expect(message).toContain('No stacks matching MyStage/Api found in assembly');
    expect(message).toContain('Stage MyStage failed to load');
  });

  it('keeps the PATTERN when the assembly is empty, and drops only the stack list', () => {
    // `Available: ` with nothing after it says less than the plain clause --
    // but the pattern must survive, because with a non-ASCII Stage path it is
    // the only thing in the message that identifies what the user asked for.
    const message = renderNoStackMatch(['MyStage/Api'], [], {
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT' }],
    });

    expect(message).toContain('No stacks matching MyStage/Api found in assembly.');
    expect(message).toContain('The assembly has no stacks');
    expect(message).not.toContain('Available:');
    // No hedge: the pattern names that stage.
    expect(message).not.toContain('Possibly unrelated');
  });

  it('keeps the pattern on an empty assembly with NO failed Stage too', () => {
    // The clause must not depend on whether a Stage failed -- only the
    // appended sentence does.
    expect(renderNoStackMatch(['MyStage/Api'], [], { failedStages: [] })).toBe(
      'No stacks matching MyStage/Api found in assembly. The assembly has no stacks'
    );
  });

  it('does not hedge when NO pattern was given, since every failed Stage is the answer', () => {
    const message = renderNoStackMatch([], [], {
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT' }],
    });

    expect(message).toBe(
      'No stacks found in assembly. Stage MyStage failed to load, so stacks under it are ' +
        'missing from this list rather than missing from the app: ENOENT'
    );
  });
});
