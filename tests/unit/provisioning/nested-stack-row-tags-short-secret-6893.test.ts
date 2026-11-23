/**
 * go-to-k/cdkd#6893: a 1-3 character secret or `NoEcho` value embedded in a
 * nested-stack row's tag value (`pin-{{resolve:...:pin::}}` -> `pin-q7`) is
 * below `MIN_NEEDLE_LENGTH`, so the substring carry could not find it and the
 * child got (and persisted) `pin-q7`, and the parent's `nestedStackTags`
 * record could hold it. The row's recorder now certifies each tag value's
 * spelling by position, and whatever is left is checked floorless.
 */
import { describe, it, expect } from 'vite-plus/test';
import { childRowTags } from '../../../src/provisioning/providers/nested-stack/row-tags.js';
import {
  recordIntrinsicLeafResolution,
  recordLogOnlyValue,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import {
  nestedStackTagsField,
  settleStackTagChildRuns,
} from '../../../src/deployment/nested-stack-tags.js';
import type { ResourceChange } from '../../../src/types/state/changes.js';

const ROW = 'AWS::CloudFormation::Stack';
const PIN = 'q7';
const PIN_TOKEN = '{{resolve:secretsmanager:app/conf:SecretString:pin::}}';
const OTHER = 'hunter2-plaintext-6893';
const OTHER_TOKEN = '{{resolve:secretsmanager:app/db:SecretString:password::}}';

function bagOf(...pairs: ReadonlyArray<readonly [string, string]>): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  for (const [token, plaintext] of pairs) {
    secrets.set(plaintext, token);
    recordResolvedPair(secrets, token, plaintext);
  }
  return secrets;
}

/** The row recorder, as `create.ts` / `resolve-inputs.ts` call it. */
function record(secrets: RecordedSecretValues, resolvedTags: unknown, sourceTags: unknown): void {
  recordNestedStackParameterExpressions(
    secrets,
    ROW,
    { TemplateURL: 'u', Tags: resolvedTags },
    { TemplateURL: 'u', Tags: sourceTags }
  );
}

describe('childRowTags: a short embedded secret (go-to-k/cdkd#6893)', () => {
  it('passes a LITERAL frame around a 2-character secret down as its expression', () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    const resolved = [{ Key: 'pin', Value: `pin-${PIN}` }];
    record(bag, resolved, [{ Key: 'pin', Value: `pin-${PIN_TOKEN}` }]);
    const result = childRowTags(resolved, bag);
    expect(result).toEqual({ tags: { pin: `pin-${PIN_TOKEN}` }, withheld: [] });
  });

  it('passes an Fn::Join frame down as the spelling its own resolution proves', () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    const source = { 'Fn::Join': ['', ['pin-', PIN_TOKEN]] };
    recordIntrinsicLeafResolution(bag, source, {
      input: `pin-${PIN_TOKEN}`,
      output: `pin-${PIN}`,
      substitutions: [{ token: PIN_TOKEN, value: PIN, secret: true }],
      complete: true,
    });
    const resolved = [{ Key: 'pin', Value: `pin-${PIN}` }];
    record(bag, resolved, [{ Key: 'pin', Value: source }]);
    expect(childRowTags(resolved, bag)).toEqual({
      tags: { pin: `pin-${PIN_TOKEN}` },
      withheld: [],
    });
  });

  it('withholds a short embedded secret no spelling was certified for', () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    const result = childRowTags([{ Key: 'pin', Value: `pin-${PIN}` }], bag);
    expect(result).toEqual({ tags: {}, withheld: ['pin'] });
  });

  it('does not use a spelling certified for another value of the key', () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    record(
      bag,
      [{ Key: 'pin', Value: `pin-${PIN}` }],
      [{ Key: 'pin', Value: `pin-${PIN_TOKEN}` }]
    );
    expect(childRowTags([{ Key: 'pin', Value: `pon-${PIN}` }], bag)).toEqual({
      tags: {},
      withheld: ['pin'],
    });
  });

  it('certifies nothing for a key the source spells twice', () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    const resolved = [{ Key: 'pin', Value: `pin-${PIN}` }];
    record(bag, resolved, [
      { Key: 'pin', Value: `pin-${PIN_TOKEN}` },
      { Key: 'pin', Value: `pin-${PIN_TOKEN}` },
    ]);
    expect(childRowTags(resolved, bag).withheld).toEqual(['pin']);
  });

  it('certifies nothing when a source item names its key through an intrinsic', () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    const resolved = [{ Key: 'pin', Value: `pin-${PIN}` }];
    record(bag, resolved, [
      { Key: 'pin', Value: `pin-${PIN_TOKEN}` },
      { 'Fn::If': ['C', { Key: 'pin', Value: 'x' }, { Ref: 'AWS::NoValue' }] },
    ]);
    expect(childRowTags(resolved, bag).withheld).toEqual(['pin']);
  });

  it("keeps a template literal that merely contains a short secret's text", () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    const resolved = [{ Key: 'team', Value: `${PIN}-team` }];
    record(bag, resolved, [{ Key: 'team', Value: `${PIN}-team` }]);
    expect(childRowTags(resolved, bag)).toEqual({ tags: { team: `${PIN}-team` }, withheld: [] });
  });

  it('withholds a 2-character NoEcho value embedded in a tag', () => {
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, 'ab');
    const result = childRowTags(
      [
        { Key: 'leak', Value: 'pin-ab' },
        { Key: 'ok', Value: 'fine' },
      ],
      bag
    );
    expect(result).toEqual({ tags: { ok: 'fine' }, withheld: ['leak'] });
  });

  it('withholds an Fn::Join spelling whose non-token text carries a NoEcho value', () => {
    // `Fn::Join ['', [{Ref: NoEchoParam}, '-', token]]`: the resolution record
    // proves the token, but the spelling still holds the parameter's value.
    const bag = bagOf([PIN_TOKEN, PIN]);
    recordLogOnlyValue(bag, 'ab');
    const source = { 'Fn::Join': ['', [{ Ref: 'NoEchoParam' }, '-', PIN_TOKEN]] };
    recordIntrinsicLeafResolution(bag, source, {
      input: `ab-${PIN_TOKEN}`,
      output: `ab-${PIN}`,
      substitutions: [{ token: PIN_TOKEN, value: PIN, secret: true }],
      complete: true,
    });
    const resolved = [{ Key: 'k', Value: `ab-${PIN}` }];
    record(bag, resolved, [{ Key: 'k', Value: source }]);
    const result = childRowTags(resolved, bag);
    expect(result).toEqual({ tags: {}, withheld: ['k'] });
    expect(JSON.stringify(result)).not.toContain('ab-');
  });

  it('withholds a value carried as a mask rather than an expression', () => {
    const bag = new Map([[OTHER, '***']]);
    expect(childRowTags([{ Key: 'k', Value: `x-${OTHER}` }], bag)).toEqual({
      tags: {},
      withheld: ['k'],
    });
  });

  it('withholds a tag whose KEY holds a short secret, without naming it', () => {
    const bag = bagOf([PIN_TOKEN, PIN]);
    const result = childRowTags([{ Key: `k-${PIN}`, Value: 'v' }], bag);
    expect(result).toEqual({ tags: {}, withheld: ['(a key cdkd does not print)'] });
  });

  it('still carries a 4+ character embedded secret by substring', () => {
    const bag = bagOf([OTHER_TOKEN, OTHER]);
    expect(childRowTags([{ Key: 'k', Value: `x-${OTHER}` }], bag).tags).toEqual({
      k: `x-${OTHER_TOKEN}`,
    });
  });
});

describe('settleStackTagChildRuns: a short NoEcho value (go-to-k/cdkd#6893)', () => {
  it('never records a 2-character NoEcho value embedded in a resolved tag', async () => {
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, 'ab');
    const changes = new Map<string, ResourceChange>([
      ['Child', { logicalId: 'Child', changeType: 'NO_CHANGE', resourceType: ROW }],
    ]);
    const expected = await settleStackTagChildRuns({
      changes,
      template: {
        Resources: {
          Child: {
            Type: ROW,
            Properties: {
              TemplateURL: 'u',
              Tags: [{ Key: 'k', Value: { 'Fn::Join': ['', ['pin-', { Ref: 'P' }]] } }],
            },
          },
        },
      },
      stackTags: undefined,
      state: {
        resources: { Child: { resourceType: ROW, physicalId: 'arn', properties: {} } } as never,
        nestedStackTags: {},
      },
      resolve: async () => [{ Key: 'k', Value: 'pin-ab' }],
      secrets: bag,
    });
    expect(expected.get('Child')).toBeUndefined();
    expect(JSON.stringify(nestedStackTagsField(expected) ?? {})).not.toContain('pin-ab');
    expect(changes.get('Child')?.changeType).toBe('UPDATE');
  });
});
