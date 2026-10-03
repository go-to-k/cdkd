import { describe, it, expect } from 'vite-plus/test';
import {
  matchStacks,
  partitionTopLevel,
  renderAllLeftOutStageStacks,
  renderAllNoTopLevelStacks,
  stackMatchesPattern,
  describeStack,
  renderNoStackMatch,
  renderStacksNoLongerSelected,
  stacksNoLongerSelected,
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
  it('matches a stack by its exact physical name and by its display path', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage-Api')).toBe(true);
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/Api')).toBe(true);
  });

  it('matches a slash-bearing pattern against the display path only', () => {
    // No physical name contains the slash, so only the display path can match.
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/Api')).toBe(true);
    // Same pattern won't match a stack whose displayName lacks the slash form
    expect(stackMatchesPattern(stacks[0]!, 'MyStage/Api')).toBe(false);
  });

  it('does not equate a hyphenated name with a slash-separated display path', () => {
    // 'MyStage-Api' is neither this stack's physical name nor its display path.
    const stageOnly = { stackName: 'phys-name', displayName: 'MyStage/Api' };
    expect(stackMatchesPattern(stageOnly, 'MyStage-Api')).toBe(false);
  });

  // go-to-k/cdkd#4474: the physical name is a cdkd extension and is matched
  // EXACTLY. A glob over it would let `'*'` select every Stage's stacks too.
  it('matches a physical name only exactly, never as a glob', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage-Api')).toBe(true);
    expect(stackMatchesPattern(stacks[1]!, 'MyStage-*')).toBe(false);
    expect(stackMatchesPattern(stacks[1]!, '*')).toBe(false);
  });

  it('matches a top-level stack by its construct id when its stackName differs (CDK parity)', () => {
    const renamed = { stackName: 'prod-api', displayName: 'Api' };
    expect(stackMatchesPattern(renamed, 'Api')).toBe(true);
    expect(stackMatchesPattern(renamed, 'A*')).toBe(true);
    // ...and still by the physical name, exactly.
    expect(stackMatchesPattern(renamed, 'prod-api')).toBe(true);
  });

  it("matches `'*'` against top-level stacks only: `*` does not cross `/`", () => {
    expect(stackMatchesPattern(stacks[0]!, '*')).toBe(true);
    expect(stackMatchesPattern(stacks[1]!, '*')).toBe(false);
    expect(stackMatchesPattern(stacks[1]!, 'MyStage*')).toBe(false);
    expect(stackMatchesPattern(stacks[1]!, '*Api')).toBe(false);
  });

  it("matches `'**'` against every stack at any depth", () => {
    for (const stack of stacks) expect(stackMatchesPattern(stack, '**')).toBe(true);
    const deep = { stackName: 'Outer-Inner-Api', displayName: 'Outer/Inner/Api' };
    expect(stackMatchesPattern(deep, '**')).toBe(true);
    expect(stackMatchesPattern(deep, 'Outer/**')).toBe(true);
    expect(stackMatchesPattern(deep, '**/Api')).toBe(true);
    // One `*` segment is one level.
    expect(stackMatchesPattern(deep, 'Outer/*')).toBe(false);
    expect(stackMatchesPattern(deep, 'Outer/*/Api')).toBe(true);
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

  // go-to-k/cdkd#4474: the CDK path decides first; the physical name is
  // consulted only when no stack's path matches, so it cannot widen a
  // selection the AWS CDK CLI would make.
  it('prefers a stack whose path matches over another whose physical name does', () => {
    const collide = [
      { stackName: 'api-v2', displayName: 'Api' },
      { stackName: 'Api', displayName: 'Legacy' },
    ];
    expect(matchStacks(collide, ['Api']).map((s) => s.stackName)).toEqual(['api-v2']);
    expect(matchStacks(collide, ['api-v2']).map((s) => s.stackName)).toEqual(['api-v2']);
    expect(matchStacks([collide[1]!], ['Api']).map((s) => s.stackName)).toEqual(['Api']);
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
    const result = matchStacks(stacks, ['*/Api']);
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api', 'OtherStage-Api']);
  });

  it("selects every stack with `'**'` and only the top-level ones with `'*'`", () => {
    expect(matchStacks(stacks, ['**']).map((s) => s.stackName)).toEqual(
      stacks.map((s) => s.stackName)
    );
    expect(matchStacks(stacks, ['*']).map((s) => s.stackName)).toEqual(['TopStack']);
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

  it('counts a pattern as matched only when the stack it selects is present', () => {
    const collide = [
      { stackName: 'api-v2', displayName: 'Api' },
      { stackName: 'Api', displayName: 'Legacy' },
    ];
    const deployed = (s: { stackName: string }) => s.stackName === 'Api';
    // `Api` selects `api-v2` by its id; that it also spells the deployed
    // stack's physical name does not make it matched.
    expect(unmatchedPatterns(collide, ['Api'], deployed)).toEqual(['Api']);
    expect(unmatchedPatterns(collide, ['Legacy'], deployed)).toEqual([]);
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

// go-to-k/cdkd#4474: `--all` selects top-level stacks only, as the AWS CDK
// CLI's `--all` (MAIN_ASSEMBLY) does, and says what it left out.
describe('--all: top-level stacks only', () => {
  const app = [
    { stackName: 'TopStack', displayName: 'TopStack' },
    { stackName: 'Prod-Api', displayName: 'Prod/Api', stagePath: 'Prod' },
    { stackName: 'Prod-Db', displayName: 'Prod/Db', stagePath: 'Prod' },
  ];

  it('partitions on the Stage a stack was read from, not on its display path', () => {
    // A Stack nested in a Stack (not a Stage) displays `Parent/Child` but is a
    // stack of the app's own assembly, so `--all` keeps it.
    const nestedInStack = { stackName: 'ParentChild', displayName: 'Parent/Child' };
    const { topLevel, inStages } = partitionTopLevel([...app, nestedInStack]);
    expect(topLevel.map((s) => s.stackName)).toEqual(['TopStack', 'ParentChild']);
    expect(inStages.map((s) => s.stackName)).toEqual(['Prod-Api', 'Prod-Db']);
  });

  it('names what it left out and the patterns that select it', () => {
    expect(renderAllLeftOutStageStacks(app.slice(1))).toBe(
      '--all selects top-level stacks only; 2 stacks inside a CDK Stage were left out ' +
        "(Prod-Api (Prod/Api), Prod-Db (Prod/Db)). Name them with 'Prod/*', or select every stack with '**'."
    );
    expect(renderAllLeftOutStageStacks(app.slice(1, 2))).toMatch(
      /^--all selects top-level stacks only; 1 stack inside a CDK Stage was left out /
    );
  });

  it('names one pattern per distinct Stage, and falls back to the globstar alone', () => {
    const two = [...app.slice(1), { stackName: 'Dev-Api', displayName: 'Dev/Api', stagePath: 'Dev' }];
    expect(renderAllLeftOutStageStacks(two)).toMatch(/Name them with 'Prod\/\*', 'Dev\/\*', or select every stack with '\*\*'\.$/);
    const odd = [{ stackName: 'X', displayName: "It's/X", stagePath: "It's" }];
    expect(renderAllLeftOutStageStacks(odd)).toMatch(/\. Select them with '\*\*'\.$/);
  });

  it('refuses a stage-only app, naming its stacks', () => {
    expect(renderAllNoTopLevelStacks(app.slice(1))).toBe(
      '--all selects top-level stacks only, and this app has none: every stack is inside a CDK Stage ' +
        "(Prod-Api (Prod/Api), Prod-Db (Prod/Db)). Name them with 'Prod/*', or select every stack with '**'."
    );
  });
});

// go-to-k/cdkd#4474: a pattern without `/` used to be a glob over the physical
// name. deploy and destroy name what that rule selected and the CDK path no
// longer does.
describe('stacksNoLongerSelected / renderStacksNoLongerSelected', () => {
  const app = [
    { stackName: 'Top', displayName: 'Top' },
    { stackName: 'api-v2', displayName: 'Api' },
    { stackName: 'Prod-Api', displayName: 'Prod/Api', stagePath: 'Prod' },
  ];
  const names = (r: { stacks: { stackName: string }[]; patterns: string[] }) => [
    r.stacks.map((s) => s.stackName),
    r.patterns,
  ];

  it('returns what the old physical-name glob matched and the selection does not hold', () => {
    expect(names(stacksNoLongerSelected(app, ['*'], new Set(['Top', 'api-v2'])))).toEqual([
      ['Prod-Api'],
      ['*'],
    ]);
    // Only the patterns that reached a dropped stack are named.
    expect(names(stacksNoLongerSelected(app, ['Top', 'api-*'], new Set(['Top'])))).toEqual([
      ['api-v2'],
      ['api-*'],
    ]);
    // A pattern with `/` is judged on the display path, never the physical name.
    expect(names(stacksNoLongerSelected(app, ['Prod/*'], new Set(['Prod-Api']))).flat()).toEqual([]);
    expect(names(stacksNoLongerSelected(app, ['Prod-*/*'], new Set())).flat()).toEqual([]);
    expect(names(stacksNoLongerSelected(app, ['**'], new Set(app.map((s) => s.stackName)))).flat()).toEqual(
      []
    );
  });

  it('advises the Stage pattern, or the CDK path for a top-level stack', () => {
    expect(renderStacksNoLongerSelected(['*'], [app[2]!])).toBe(
      '"*" now matches the CDK path, with * inside one segment, and no longer selects 1 stack it used to ' +
        "(Prod-Api (Prod/Api)). Name them with 'Prod/*', or select every stack with '**'."
    );
    expect(renderStacksNoLongerSelected(['api-*', 'x*'], [app[1]!])).toBe(
      '"api-*", "x*" now match the CDK path, with * inside one segment, and no longer select 1 stack ' +
        'they used to (api-v2 (Api)). Name each by the CDK path shown in parentheses.'
    );
  });

  // `'Prod/*'` cannot reach a stack outside every Stage (a Stack inside a
  // plain construct, `Group/X`), so a mixed set gets the CDK-path advice.
  it('gives the Stage advice only when every named stack is in a Stage', () => {
    const grouped = { stackName: 'GroupX', displayName: 'Group/X' };
    expect(renderStacksNoLongerSelected(['*'], [app[2]!, grouped])).toMatch(
      /\(Prod-Api \(Prod\/Api\), GroupX \(Group\/X\)\)\. Name each by the CDK path shown in parentheses, or select every stack with '\*\*'\.$/
    );
  });

  // The old rule's `*` crossed `/` on the display path too, so `'Prod/*'`
  // reached a Stack nested in a Stack inside the Stage.
  it("names the deeper stack a slash pattern's `*` used to reach", () => {
    const deep = { stackName: 'ProdParentChild', displayName: 'Prod/Parent/Child', stagePath: 'Prod' };
    const withDeep = [...app, deep];
    expect(
      names(stacksNoLongerSelected(withDeep, ['Prod/*'], new Set(['Prod-Api'])))
    ).toEqual([['ProdParentChild'], ['Prod/*']]);
    // `'Prod/**'` selects it, so nothing is named.
    expect(
      names(stacksNoLongerSelected(withDeep, ['Prod/**'], new Set(['Prod-Api', 'ProdParentChild']))).flat()
    ).toEqual([]);
    // `'<stage>/*'` would not reach it, so the advice names its path instead.
    expect(renderStacksNoLongerSelected(['Prod/*'], [deep])).toMatch(
      /\(ProdParentChild \(Prod\/Parent\/Child\)\)\. Name each by the CDK path shown in parentheses, or select every stack with '\*\*'\.$/
    );
  });

});
