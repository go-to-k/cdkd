import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4049, the "coverage edges" row: the PIECES of a `NoEcho`
// parameter's value are log-only needles too.
//
// (a) A nested child's list-typed parameter (`CommaDelimitedList`) fed the
//     parent's `NoEcho` STRING arrives split and trimmed, so no element equals
//     or contains the inherited needle and `carryLogOnlyValuesCarriedBy`
//     carried nothing.
// (b) `Fn::Split` over the value printed its pieces on the resolver's
//     `Resolved Fn::Split` line, and a resource consuming a piece had it in the
//     clear in its provider's masker, its error and its event.
//
// Both record LOG-ONLY needles, so the state the deploy persists is
// byte-identical to the same deploy without `NoEcho`.
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const capture = (...args: unknown[]): void => {
    logLines.push(args.map(String).join(' '));
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { exportNameSecretExposure } from '../../../src/deployment/outputs-export-alias.js';
import {
  SECRET_MASK,
  carryLogOnlyValuesCarriedBy,
  hasMaskableValues,
  literalSplitDelimitersOf,
  maskSecretsInText,
  recordLogOnlyParameterValue,
  recordLogOnlySplitFragments,
  recordLogOnlyValue,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type {
  CloudFormationTemplate,
  CreateContext,
  TemplateOutput,
} from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const FIRST = 'alpha-first-piece';
const SECOND = 'bravo-second-piece';
const NOECHO = `${FIRST},${SECOND}`;

const lines = (): string => logLines.join('\n');

beforeEach(() => {
  logLines.length = 0;
});

function splitContext(
  noEcho: boolean,
  bag: RecordedSecretValues,
  value: string = NOECHO,
  extra: Partial<ResolverContext> = {}
): ResolverContext {
  return {
    template: { Parameters: { Secret: { Type: 'String', NoEcho: noEcho } }, Resources: {} },
    resources: {},
    parameters: { Secret: value },
    recordedSecretValues: bag,
    ...extra,
  };
}

describe('(b) Fn::Split over a NoEcho value records its pieces as log-only needles', () => {
  it('masks every piece on the Resolved Fn::Split line and in the pass masker; only the whole value is a map entry', async () => {
    const bag: RecordedSecretValues = new Map();
    const pieces = await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { Ref: 'Secret' }] },
      splitContext(true, bag)
    );
    // The value AWS receives is the real one.
    expect(pieces).toEqual([FIRST, SECOND]);
    expect(lines()).toContain('Resolved Fn::Split');
    expect(lines()).not.toContain(FIRST);
    expect(lines()).not.toContain(SECOND);
    expect(maskSecretsInText(`rejected '${FIRST}' and '${SECOND}'`, bag)).toBe(
      `rejected '${SECRET_MASK}' and '${SECRET_MASK}'`
    );
    // go-to-k/cdkd#4043: the WHOLE value is a mask-only map entry (the value
    // arm); the pieces stay LOG-ONLY, so a bare piece is not a needle of the
    // persist walk. The engine masks a split leaf by template POSITION
    // instead (the positional arm, pinned through the engine below).
    expect([...bag.entries()]).toEqual([[NOECHO, SECRET_MASK]]);
    expect(redactSecretsForState({ A: FIRST, B: [FIRST, SECOND] }, bag)).toEqual({
      A: FIRST,
      B: [FIRST, SECOND],
    });
    expect(redactSecretsForState({ W: NOECHO }, bag)).toEqual({ W: SECRET_MASK });
  });

  it('masks a piece consumed through Fn::Select on the Select line too', async () => {
    const bag: RecordedSecretValues = new Map();
    const picked = await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Select': [1, { 'Fn::Split': [',', { Ref: 'Secret' }] }] },
      splitContext(true, bag)
    );
    expect(picked).toBe(SECOND);
    expect(lines()).toContain('Resolved Fn::Select');
    expect(lines()).not.toContain(SECOND);
  });

  it('masks each piece of a split over a leaf embedding the value whole on its line', async () => {
    const bag: RecordedSecretValues = new Map();
    const pieces = await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { 'Fn::Join': ['', ['head-', { Ref: 'Secret' }, '-tail']] }] },
      splitContext(true, bag)
    );
    expect(pieces).toEqual([`head-${FIRST}`, `${SECOND}-tail`]);
    const logged = lines();
    // Since go-to-k/cdkd#4043 the value is a containment needle of the map, so
    // the leaf embedding it and each piece of it print as the mask whole
    // (over-masking a log line is the safe direction).
    expect(logged).toContain(`Resolved Fn::Join: ${SECRET_MASK}`);
    expect(logged).toContain(`resolved to ["${SECRET_MASK}","${SECRET_MASK}"]`);
    expect(logged).not.toContain(FIRST);
    expect(logged).not.toContain(SECOND);
  });

  it('holds the MIN_NEEDLE_LENGTH floor: a 1-3 character piece masks only a text it IS', async () => {
    // `abc` is a three-character fragment: masked whole, never inside a longer
    // string, exactly the substring floor a whole log-only value has.
    const bag: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { 'Fn::Join': ['', ['pre-', { Ref: 'Secret' }]] }] },
      splitContext(true, bag, 'abc,defghij')
    );
    expect(maskSecretsInText('abc', bag)).toBe(SECRET_MASK);
    expect(maskSecretsInText('xabcx', bag)).toBe('xabcx');
    expect(maskSecretsInText('pre-abc', bag)).toBe('pre-abc');
    expect(maskSecretsInText('v=defghij', bag)).toBe(`v=${SECRET_MASK}`);
    // The resolver's own Split line now masks each piece of an input that
    // embeds the whole value (go-to-k/cdkd#4043's containment needle), the
    // short one included; the bag's floor above is unchanged.
    expect(lines()).toContain(`resolved to ["${SECRET_MASK}","${SECRET_MASK}"]`);
    expect(lines()).not.toContain('pre-abc');
    expect(lines()).not.toContain('defghij');
  });

  it('masks every piece of an EMPTY-delimiter split on its line, recording no character', async () => {
    const bag: RecordedSecretValues = new Map();
    const pieces = await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': ['', { Ref: 'Secret' }] },
      splitContext(true, bag, 'hunter2zz')
    );
    expect(pieces).toEqual([...'hunter2zz']);
    const line = logLines.find((l) => l.includes('Resolved Fn::Split'))!;
    expect(line).toContain('["***","***","***","***","***","***","***","***","***"]');
    expect(line).not.toContain('"h","u"');
    // No single character became a needle: the export-name verdict and every
    // other line are unaffected.
    expect(maskSecretsInText('h', bag)).toBe('h');
  });

  it('prints an EMPTY-delimiter split of a value that carries no needle', async () => {
    const bag: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': ['', { Ref: 'Secret' }] },
      splitContext(false, bag, 'ab')
    );
    expect(lines()).toContain('["a","b"]');
  });

  it('masks the split line in a context with no pass bag (inherited-only)', async () => {
    // Nothing records into a pass bag here, and no earlier resolution did: the
    // line must mask the pieces on its own.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { Ref: 'Secret' }] },
      {
        template: { Parameters: { Secret: { Type: 'String' } }, Resources: {} },
        resources: {},
        parameters: { Secret: NOECHO },
        inheritedSecrets: inherited,
      }
    );
    expect(lines()).toContain('Resolved Fn::Split');
    expect(lines()).not.toContain(FIRST);
    expect(lines()).not.toContain(SECOND);
    // The parent's bag is not written.
    expect(maskSecretsInText(FIRST, inherited)).toBe(FIRST);
  });

  it('leaves an Fn::Join over an EMPTY-delimiter split character-spaced (a documented residual)', async () => {
    // The split line is masked; a Join re-assembling the characters with a
    // separator prints them, since no character is a needle.
    const bag: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Join': ['-', { 'Fn::Split': ['', { Ref: 'Secret' }] }] },
      splitContext(true, bag, 'hunter2zz')
    );
    const split = logLines.find((l) => l.includes('Resolved Fn::Split'))!;
    expect(split).not.toContain('"h"');
    expect(lines()).toContain('h-u-n-t-e-r-2-z-z');
  });

  it('records nothing for a parameter that is not NoEcho (negative control)', async () => {
    const bag: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { Ref: 'Secret' }] },
      splitContext(false, bag)
    );
    expect(hasMaskableValues(bag)).toBe(false);
    expect(lines()).toContain(FIRST);
  });

  it("records a child's split of the parent's value through a parameter it does not declare NoEcho", async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const own: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { Ref: 'Secret' }] },
      splitContext(false, own, NOECHO, { inheritedSecrets: inherited })
    );
    expect(maskSecretsInText(`x ${FIRST} y`, own)).toBe(`x ${SECRET_MASK} y`);
    expect(maskSecretsInText(`x ${SECOND} y`, own)).toBe(`x ${SECRET_MASK} y`);
    expect(own.size).toBe(0);
    // The parent's bag is not written.
    expect(maskSecretsInText(FIRST, inherited)).toBe(FIRST);
    expect(lines()).not.toContain(FIRST);
  });

  it("records a child's split of a resource id holding the parent's value, which no Ref carried", async () => {
    // Only the INHERITED bag knows the value here: a `Ref` to a resource
    // carries nothing into the pass bag, so the pieces must be derived from
    // the inherited needles directly.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const own: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { Ref: 'Holder' }] },
      splitContext(false, own, 'unused', {
        inheritedSecrets: inherited,
        resources: {
          Holder: {
            physicalId: NOECHO,
            resourceType: 'AWS::SSM::Parameter',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
      })
    );
    expect(maskSecretsInText(`x ${SECOND} y`, own)).toBe(`x ${SECRET_MASK} y`);
    expect(own.size).toBe(0);
    expect(lines()).not.toContain(SECOND);
  });

  it("records the print-only corpus's pieces into that corpus alone", async () => {
    const printing: RecordedSecretValues = new Map();
    recordLogOnlyValue(printing, NOECHO);
    const bag: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Split': [',', { Ref: 'Secret' }] },
      splitContext(false, bag, NOECHO, { printingSecrets: printing })
    );
    expect(maskSecretsInText(FIRST, printing)).toBe(SECRET_MASK);
    // Never into the pass bag, whose log-only set decides an export alias.
    expect(hasMaskableValues(bag)).toBe(false);
    expect(lines()).not.toContain(FIRST);
    expect(lines()).not.toContain(SECOND);
  });
});

describe('recordLogOnlySplitFragments', () => {
  it('splits by a multi-character delimiter and records nothing for a needle inside one piece', () => {
    const from: RecordedSecretValues = new Map();
    recordLogOnlyValue(from, 'left-side::right-side');
    recordLogOnlyValue(from, 'whole-in-one');
    const to: RecordedSecretValues = new Map();
    recordLogOnlySplitFragments([from], to, 'a::left-side::right-side::whole-in-one', '::');
    expect(maskSecretsInText('left-side', to)).toBe(SECRET_MASK);
    expect(maskSecretsInText('right-side', to)).toBe(SECRET_MASK);
    // Already a needle of `from`; nothing new, and the literal `a` stays out.
    expect(maskSecretsInText('whole-in-one', to)).toBe('whole-in-one');
    expect(maskSecretsInText('a', to)).toBe('a');
  });

  it('records nothing for an empty delimiter, which would make every character a needle', () => {
    const from: RecordedSecretValues = new Map();
    recordLogOnlyValue(from, 'secret-value');
    const to: RecordedSecretValues = new Map();
    recordLogOnlySplitFragments([from], to, 'secret-value', '');
    expect(hasMaskableValues(to)).toBe(false);
  });

  it('counts an embedded needle of EXACTLY the floor (4 characters)', () => {
    const from: RecordedSecretValues = new Map();
    recordLogOnlyValue(from, 'ab,c');
    const to: RecordedSecretValues = new Map();
    recordLogOnlySplitFragments([from], to, 'xab,cy', ',');
    expect(maskSecretsInText('ab', to)).toBe(SECRET_MASK);
    expect(maskSecretsInText('c', to)).toBe(SECRET_MASK);
  });

  it('ignores a 1-3 character needle embedded in a longer text, as the masker does', () => {
    const from: RecordedSecretValues = new Map();
    recordLogOnlyValue(from, 'x,y');
    const to: RecordedSecretValues = new Map();
    recordLogOnlySplitFragments([from], to, 'ax,yb', ',');
    expect(hasMaskableValues(to)).toBe(false);
    recordLogOnlySplitFragments([from], to, 'x,y', ',');
    expect(maskSecretsInText('x', to)).toBe(SECRET_MASK);
  });
});

describe('the up-front record of a NoEcho value records its split pieces (go-to-k/cdkd#4049)', () => {
  it('records the pieces of each literal Fn::Split delimiter, and only with delimiters passed', () => {
    const template = {
      Resources: {
        A: { Properties: { V: { 'Fn::Select': [1, { 'Fn::Split': [',', { Ref: 'P' }] }] } } },
        B: { Properties: { V: { 'Fn::Split': [{ Ref: 'Dyn' }, 'x'] } } },
      },
    };
    const delimiters = literalSplitDelimitersOf(template, new Set(['P']));
    expect([...delimiters]).toEqual([',']);
    // Only a split over a value READING the parameter counts: a `Ref` or an
    // `Fn::Sub` naming it. A split over anything else records no piece.
    expect([
      ...literalSplitDelimitersOf(
        {
          A: { 'Fn::Split': [':', { 'Fn::GetAtt': ['X', 'Arn'] }] },
          B: { 'Fn::Split': ['/', { 'Fn::Sub': 'pre/${P}' }] },
          C: { 'Fn::Split': ['|', { Ref: 'Other' }] },
        },
        new Set(['P'])
      ),
    ]).toEqual(['/']);
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyParameterValue(bag, NOECHO, delimiters);
    expect(maskSecretsInText(`old ${SECOND}`, bag)).toBe(`old ${SECRET_MASK}`);
    expect(bag.size).toBe(0);
    const bare: RecordedSecretValues = new Map();
    recordLogOnlyParameterValue(bare, NOECHO);
    expect(maskSecretsInText(`old ${SECOND}`, bare)).toBe(`old ${SECOND}`);
    // An empty delimiter would make every character a needle.
    const empty: RecordedSecretValues = new Map();
    recordLogOnlyParameterValue(empty, 'ab', new Set(['']));
    expect(maskSecretsInText('a', empty)).toBe('a');
  });

  it("masks a piece the state still holds in the deploy's diff log masker, though nothing splits it now", () => {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false },
      'us-east-1'
    );
    const masker = (
      engine as unknown as {
        diffLogMasker: (
          d: RecordedSecretValues | undefined,
          t: CloudFormationTemplate,
          p: Record<string, unknown>
        ) => (text: string) => string;
      }
    ).diffLogMasker(new Map(), splitTemplate(true), { Secret: NOECHO });
    expect(masker(`requires replacement ("${SECOND}" -> "new")`)).toBe(
      `requires replacement ("${SECRET_MASK}" -> "new")`
    );
    // Negative control: with no Fn::Split in the template, no delimiter is
    // known and the piece prints (the documented residual).
    const noSplit = (
      engine as unknown as {
        diffLogMasker: (
          d: RecordedSecretValues | undefined,
          t: CloudFormationTemplate,
          p: Record<string, unknown>
        ) => (text: string) => string;
      }
    ).diffLogMasker(
      new Map(),
      {
        Parameters: { Secret: { Type: 'String', NoEcho: true } },
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      },
      { Secret: NOECHO }
    );
    expect(noSplit(`("${SECOND}" -> "new")`)).toBe(`("${SECOND}" -> "new")`);
  });
});

describe('(a) a child list parameter split out of the parent NoEcho string carries its fragments', () => {
  function childContext(
    own: RecordedSecretValues,
    inherited: RecordedSecretValues,
    type: string,
    value: unknown
  ): ResolverContext {
    return {
      // A CDK-synthesized child parameter never says NoEcho.
      template: { Parameters: { ChildList: { Type: type } }, Resources: {} },
      resources: {},
      parameters: { ChildList: value },
      recordedSecretValues: own,
      inheritedSecrets: inherited,
    };
  }

  it('carries each element, and masks the Resolved Ref line that prints them', async () => {
    const inherited: RecordedSecretValues = new Map();
    // The parent's spelling, with the space CloudFormation trims away.
    recordLogOnlyValue(inherited, `${FIRST}, ${SECOND}`);
    const own: RecordedSecretValues = new Map();
    const value = await new IntrinsicFunctionResolver().resolve(
      { Ref: 'ChildList' },
      childContext(own, inherited, 'CommaDelimitedList', [FIRST, SECOND])
    );
    expect(value).toEqual([FIRST, SECOND]);
    expect(maskSecretsInText(`bad ${FIRST}`, own)).toBe(`bad ${SECRET_MASK}`);
    expect(maskSecretsInText(`bad ${SECOND}`, own)).toBe(`bad ${SECRET_MASK}`);
    expect(own.size).toBe(0);
    expect(lines()).toContain('Resolved Ref to parameter: ChildList');
    expect(lines()).not.toContain(FIRST);
    expect(lines()).not.toContain(SECOND);
  });

  it('carries the fragments of a value the parent EMBEDDED in a longer list string', () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, ['public', `x-${FIRST}`, `${SECOND}-y`]);
    expect(maskSecretsInText(`x-${FIRST}`, own)).toBe(`x-${SECRET_MASK}`);
    expect(maskSecretsInText(`${SECOND}-y`, own)).toBe(`${SECRET_MASK}-y`);
    expect(maskSecretsInText('public', own)).toBe('public');
  });

  it('carries the fragments of a List<Number> parameter', () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, '7391,8642');
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, [7391, 8642]);
    expect(maskSecretsInText('pin 8642 rejected', own)).toBe(`pin ${SECRET_MASK} rejected`);
  });

  it('carries a List<Number> whose parent spelling is not the number form (leading zeros)', () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, '07391, 08642');
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, [7391, 8642]);
    expect(maskSecretsInText('value 7391 and 8642', own)).toBe(
      `value ${SECRET_MASK} and ${SECRET_MASK}`
    );
  });

  it('carries a List<Number> whose parent value holds a word (NaN) or an empty piece (0)', () => {
    // The coercion is `Number(piece.trim())`, so a word becomes NaN and an
    // empty piece 0: the sibling elements are still the value's.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, 'abc,7391');
    recordLogOnlyValue(inherited, '12345,,67890');
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, [Number.NaN, 7391]);
    carryLogOnlyValuesCarriedBy(inherited, own, [12345, 0, 67890]);
    expect(maskSecretsInText('pin 7391', own)).toBe(`pin ${SECRET_MASK}`);
    expect(maskSecretsInText('a 12345 b 67890', own)).toBe(`a ${SECRET_MASK} b ${SECRET_MASK}`);
  });

  it('skips only a needle whose EVERY piece is a word or empty, for a List<Number>', () => {
    // `foo` normalizes to `NaN` and would match any list of `NaN`s — a child
    // fed some other word — while printing nothing of it if skipped.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, 'foo');
    recordLogOnlyValue(inherited, 'bar, ');
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, [Number.NaN]);
    carryLogOnlyValuesCarriedBy(inherited, own, [Number.NaN, 0]);
    expect(hasMaskableValues(own)).toBe(false);
  });

  it("records the list needle ITSELF, which masks a line quoting the comma-joined value", () => {
    // The fragments `ab` / `cd` are under the floor, so only the whole needle
    // masks `ab,cd` inside a longer line.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, 'ab,cd');
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, ['ab', 'cd']);
    expect(maskSecretsInText('x ab,cd y', own)).toBe(`x ${SECRET_MASK} y`);
  });

  it('carries a comma-free needle whose edge whitespace the list coercion trimmed', () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, ' hunter2pw ');
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, ['hunter2pw']);
    expect(maskSecretsInText('bad hunter2pw', own)).toBe(`bad ${SECRET_MASK}`);
  });

  it('carries nothing for a list the needle is not split into (negative control)', () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, [FIRST, 'other-element']);
    carryLogOnlyValuesCarriedBy(inherited, own, [SECOND, FIRST]);
    expect(hasMaskableValues(own)).toBe(false);
  });

  it('holds the floor: a sub-floor needle is carried only when the list IS it', () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, 'a,b');
    const own: RecordedSecretValues = new Map();
    carryLogOnlyValuesCarriedBy(inherited, own, ['xa', 'b']);
    expect(hasMaskableValues(own)).toBe(false);
    carryLogOnlyValuesCarriedBy(inherited, own, ['a', 'b']);
    expect(maskSecretsInText('a', own)).toBe(SECRET_MASK);
    expect(maskSecretsInText('ab', own)).toBe('ab');
  });
});

// The ENGINE half, with the real resolver.
function harness(
  props: Record<string, unknown>,
  parameters: Record<string, string>,
  extraOptions: Record<string, unknown> = {}
) {
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: '/app/param' }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const updateForStack = vi.fn().mockResolvedValue(undefined);
  const events: unknown[] = [];
  const diff = {
    calculateDiff: vi.fn().mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'R',
          {
            logicalId: 'R',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: props,
          },
        ],
      ])
    ),
    hasChanges: vi.fn().mockReturnValue(true),
    filterByType: vi
      .fn()
      .mockImplementation((c: Map<string, ResourceChange>, t: string) =>
        [...c.values()].filter((x) => x.changeType === t)
      ),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['R']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    diff as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      parameters,
      eventRecorder: { runId: 'run', record: (event: unknown) => events.push(event) } as never,
      ...extraOptions,
    },
    'us-east-1',
    { updateForStack } as never
  );
  return { engine, provider, saveState, updateForStack, events };
}

const SPLIT_PROPS = {
  Name: '/app/param',
  Type: 'String',
  Value: { 'Fn::Select': [1, { 'Fn::Split': [',', { Ref: 'Secret' }] }] },
};

function splitTemplate(
  noEcho: boolean,
  outputs?: Record<string, unknown>
): CloudFormationTemplate {
  return {
    Parameters: { Secret: { Type: 'String', NoEcho: noEcho } },
    Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: SPLIT_PROPS } },
    ...(outputs && { Outputs: outputs as unknown as Record<string, TemplateOutput> }),
  };
}

function persisted(saveState: ReturnType<typeof vi.fn>): string {
  expect(saveState).toHaveBeenCalled();
  return JSON.stringify(
    saveState.mock.calls.map((call) => {
      const state = { ...(call[2] as StackState) };
      delete (state as { lastModified?: unknown }).lastModified;
      return state;
    })
  );
}

describe('DeployEngine - a split piece of a NoEcho value is masked on the deploy surfaces', () => {
  it("hands the provider a masker that masks the piece it received (the provider's warn line)", async () => {
    const h = harness(SPLIT_PROPS, { Secret: NOECHO });
    await h.engine.deploy('s', splitTemplate(true));
    const sent = h.provider.create.mock.calls[0]![2] as Record<string, unknown>;
    expect(sent['Value']).toBe(SECOND);
    const context = h.provider.create.mock.calls[0]![3] as CreateContext;
    expect(context.maskSecrets!(`retrying: Value '${SECOND}' throttled`)).toBe(
      `retrying: Value '${SECRET_MASK}' throttled`
    );
    expect(lines()).not.toContain(SECOND);
    expect(lines()).not.toContain(FIRST);
  });

  it('masks a provider error quoting the piece in the thrown error, the event and the log', async () => {
    const h = harness(SPLIT_PROPS, { Secret: NOECHO });
    h.provider.create.mockRejectedValue(new Error(`Value '${SECOND}' at 'value' failed`));
    let thrown: unknown;
    try {
      await h.engine.deploy('s', splitTemplate(true));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const chain: string[] = [];
    for (let e: unknown = thrown; e instanceof Error; e = (e as { cause?: unknown }).cause) {
      chain.push(e.message, e.stack ?? '');
    }
    expect(chain.join('\n')).toContain("at 'value' failed");
    expect(chain.join('\n')).not.toContain(SECOND);
    expect(h.events.some((e) => JSON.stringify(e).includes("at 'value' failed"))).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain(SECOND);
    expect(lines()).not.toContain(SECOND);
  });

  it('prints the piece when the parameter is not NoEcho (negative control)', async () => {
    const h = harness(SPLIT_PROPS, { Secret: NOECHO });
    await h.engine.deploy('s', splitTemplate(false));
    const context = h.provider.create.mock.calls[0]![3] as CreateContext;
    expect(context.maskSecrets!(SECOND)).toBe(SECOND);
  });

  it('persists *** for a split piece of a NoEcho value by template position (go-to-k/cdkd#4043)', async () => {
    const saved = async (noEcho: boolean): Promise<string> => {
      const h = harness(SPLIT_PROPS, { Secret: NOECHO });
      await h.engine.deploy(
        's',
        splitTemplate(noEcho, {
          Piece: { Value: { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'Secret' }] }] } },
        })
      );
      return persisted(h.saveState);
    };
    // Negative control: without NoEcho both pieces stay in the clear, so the
    // positive half is not vacuous.
    const without = await saved(false);
    expect(without).toContain(`"Value":"${SECOND}"`);
    expect(without).toContain(`"Piece":"${FIRST}"`);
    const withNoEcho = await saved(true);
    expect(withNoEcho).not.toContain(FIRST);
    expect(withNoEcho).not.toContain(SECOND);
    expect(withNoEcho).toContain('"Value":"***"');
    expect(withNoEcho).toContain('"Piece":"***"');
  });

  it("masks a nested child's list parameter split out of the parent's value", async () => {
    // (a) through the engine: the child's own parameter never says NoEcho.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const props = {
      Name: '/app/param',
      Type: 'String',
      Value: { 'Fn::Select': [0, { Ref: 'ChildList' }] },
    };
    const h = harness(
      props,
      { ChildList: NOECHO },
      {
        inheritedSecrets: inherited,
        parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
      }
    );
    await h.engine.deploy('P~C', {
      Parameters: { ChildList: { Type: 'CommaDelimitedList' } },
      Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
    });
    const sent = h.provider.create.mock.calls[0]![2] as Record<string, unknown>;
    expect(sent['Value']).toBe(FIRST);
    const context = h.provider.create.mock.calls[0]![3] as CreateContext;
    expect(context.maskSecrets!(`Value '${FIRST}' failed`)).toBe(`Value '${SECRET_MASK}' failed`);
    expect(lines()).toContain('Resolved Ref to parameter: ChildList');
    expect(lines()).not.toContain(FIRST);
    expect(lines()).not.toContain(SECOND);
  });

  it("saves the child's state byte-identical whether or not the parent's value is NoEcho", async () => {
    const props = {
      Name: '/app/param',
      Type: 'String',
      Value: { 'Fn::Select': [0, { Ref: 'ChildList' }] },
    };
    const saved = async (noEcho: boolean): Promise<string> => {
      const inherited: RecordedSecretValues = new Map();
      if (noEcho) recordLogOnlyValue(inherited, NOECHO);
      const h = harness(
        props,
        { ChildList: NOECHO },
        {
          inheritedSecrets: inherited,
          parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
        }
      );
      await h.engine.deploy('P~C', {
        Parameters: { ChildList: { Type: 'CommaDelimitedList' } },
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
      });
      return persisted(h.saveState);
    };
    const withNoEcho = await saved(true);
    expect(withNoEcho).toContain(`"Value":"${FIRST}"`);
    expect(withNoEcho).toBe(await saved(false));
  });
});

// The one publication verdict reading log-only needles reads the pieces too:
// an intended widening, at the same MIN_NEEDLE_LENGTH floor.
describe('exportNameSecretExposure refuses an Export.Name holding a split piece (go-to-k/cdkd#4049)', () => {
  it('refuses a name built from a piece, and publishes it without NoEcho (negative control)', async () => {
    const outputs = {
      Echo: {
        Value: 'v',
        Export: {
          Name: {
            'Fn::Join': [
              '-',
              ['exp', { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'Secret' }] }] }],
            ],
          },
        },
      },
      Innocent: { Value: 'w', Export: { Name: 'plain-export' } },
    };
    const refused = harness(SPLIT_PROPS, { Secret: NOECHO });
    await refused.engine.deploy('s', splitTemplate(true, outputs));
    const refusedStates = refused.saveState.mock.calls.map((call) => call[2] as StackState);
    const last = refusedStates[refusedStates.length - 1]!;
    expect(last.exportNames).toEqual(['plain-export']);
    for (const state of refusedStates) expect(JSON.stringify(state)).not.toContain(`exp-${FIRST}`);
    // The name reads `Secret`, so the positional refusal decides it
    // (go-to-k/cdkd#4657), ahead of the piece's containment arm.
    expect(lines()).toContain('Output Echo has an Export.Name that reads the NoEcho template parameter Secret');
    expect(lines()).not.toContain(FIRST);

    const published = harness(SPLIT_PROPS, { Secret: NOECHO });
    await published.engine.deploy('s', splitTemplate(false, outputs));
    const publishedStates = published.saveState.mock.calls.map((call) => call[2] as StackState);
    expect(publishedStates[publishedStates.length - 1]!.exportNames).toContain(`exp-${FIRST}`);
  });

  it('keeps the floor: a 1-3 character piece refuses only a name that IS it', () => {
    const pass: RecordedSecretValues = new Map();
    recordLogOnlyValue(pass, 'abc,defghij');
    recordLogOnlySplitFragments([pass], pass, 'abc,defghij', ',');
    expect(exportNameSecretExposure('abc', pass)).toBeDefined();
    expect(exportNameSecretExposure('exp-abc-name', pass)).toBeUndefined();
    expect(exportNameSecretExposure('exp-defghij', pass)).toBeDefined();
  });
});
