/**
 * The recorded-verdict fingerprint and record (issue
 * [#4479](https://github.com/go-to-k/cdkd/issues/4479)),
 * `src/deployment/condition-verdicts.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  buildConditionVerdictRecord,
  conditionFingerprint,
  conditionInputsFrom,
  conditionsReadByDiff,
  deployConditionInputs,
  parentSuppliedValues,
  readRecordedConditionVerdicts,
} from '../../../src/deployment/condition-verdicts.js';
import { recordAssumedConditions } from '../../../src/deployment/assumed-conditions.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const EXPR = '{{resolve:secretsmanager:app/config:SecretString:stage::}}';
const isProd = { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] };

function template(
  conditions: Record<string, unknown>,
  parameters: Record<string, unknown> = { Stage: { Type: 'String' } }
): CloudFormationTemplate {
  return {
    Parameters: parameters as CloudFormationTemplate['Parameters'],
    Conditions: conditions,
    Resources: {
      R: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::If': ['C', 'a', 'b'] } } },
    },
  };
}

const tokens = conditionInputsFrom({ tokens: { Stage: EXPR }, bound: {} });
const fp = (t: CloudFormationTemplate, inputs = tokens, name = 'C') =>
  conditionFingerprint(t, name, inputs)?.fingerprint;

describe('conditionFingerprint', () => {
  it('is deterministic across two separately built templates', () => {
    const a = fp(template({ C: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } }));
    const b = fp(
      template({ C: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } }, { Stage: { Type: 'String' } })
    );
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('changes with the definition, a chained definition, the token expression and a plain value', () => {
    const base = fp(template({ C: { 'Fn::And': [isProd, { Condition: 'D' }] }, D: { 'Fn::Equals': ['a', 'a'] } }));
    expect(fp(template({ C: { 'Fn::And': [isProd, { Condition: 'D' }] }, D: { 'Fn::Equals': ['a', 'b'] } }))).not.toBe(base);
    expect(fp(template({ C: { 'Fn::Or': [isProd, { Condition: 'D' }] }, D: { 'Fn::Equals': ['a', 'a'] } }))).not.toBe(base);
    const other = conditionInputsFrom({ tokens: { Stage: `${EXPR}x` }, bound: {} });
    expect(fp(template({ C: { 'Fn::And': [isProd, { Condition: 'D' }] }, D: { 'Fn::Equals': ['a', 'a'] } }), other)).not.toBe(base);

    const withEnv = (env: string) =>
      fp(
        template(
          { C: { 'Fn::And': [isProd, { 'Fn::Equals': [{ Ref: 'Env' }, 'x'] }] } },
          { Stage: { Type: 'String' }, Env: { Type: 'String' } }
        ),
        conditionInputsFrom({ tokens: { Stage: EXPR }, bound: { Env: env } })
      );
    expect(withEnv('x')).not.toBe(withEnv('y'));
  });

  it('does not change when an UNRELATED condition changes', () => {
    expect(fp(template({ C: isProd, Other: { 'Fn::Equals': ['a', 'a'] } }))).toBe(
      fp(template({ C: isProd, Other: { 'Fn::Equals': ['a', 'b'] } }))
    );
  });

  it.each([
    ['Fn::Sub', { 'Fn::Equals': [{ 'Fn::Sub': '${Stage}' }, 'prod'] }],
    ['Fn::Join', { 'Fn::Equals': [{ 'Fn::Join': ['', [{ Ref: 'Stage' }]] }, 'prod'] }],
    ['Fn::FindInMap', { 'Fn::Equals': [{ 'Fn::FindInMap': ['M', { Ref: 'Stage' }, 'k'] }, 'v'] }],
    ['a pseudo parameter', { 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'us-east-1'] }],
    ['an undeclared Ref', { 'Fn::Equals': [{ Ref: 'Nope' }, 'x'] }],
    ['a dynamic-reference literal', { 'Fn::Equals': [{ Ref: 'Stage' }, EXPR] }],
    ['a number literal', { 'Fn::Equals': [{ Ref: 'Stage' }, 3] }],
    ['an undeclared condition', { 'Fn::And': [isProd, { Condition: 'Missing' }] }],
    ['a two-key object', { 'Fn::Equals': [{ Ref: 'Stage' }, 'p'], Extra: 1 }],
  ])('is undefined for %s', (_label, definition) => {
    expect(fp(template({ C: definition }))).toBeUndefined();
  });

  it('is undefined for a reference cycle', () => {
    expect(
      fp(template({ C: { 'Fn::And': [isProd, { Condition: 'D' }] }, D: { 'Fn::Or': [{ Condition: 'C' }] } }))
    ).toBeUndefined();
  });

  it('is undefined for a list-typed or Number parameter', () => {
    expect(fp(template({ C: isProd }, { Stage: { Type: 'CommaDelimitedList' } }))).toBeUndefined();
    expect(fp(template({ C: isProd }, { Stage: { Type: 'Number' } }))).toBeUndefined();
  });

  it('is undefined for a Number parameter holding a PLAIN numeric value', () => {
    const t = template(
      { C: { 'Fn::And': [isProd, { 'Fn::Equals': [{ Ref: 'Port' }, '3'] }] } },
      { Stage: { Type: 'String' }, Port: { Type: 'Number' } }
    );
    expect(fp(t, conditionInputsFrom({ tokens: { Stage: EXPR }, bound: { Port: '3' } }))).toBeUndefined();
  });

  it('is undefined when an input is unavailable (an unbound parameter)', () => {
    const inputs = conditionInputsFrom({ tokens: { Stage: EXPR }, bound: {}, unavailable: new Set(['Stage']) });
    expect(fp(template({ C: isProd }), inputs)).toBeUndefined();
    expect(fp(template({ C: isProd }), conditionInputsFrom({ tokens: {}, bound: {} }))).toBeUndefined();
  });

  it('keeps a NoEcho PLAIN value out of the hash (no fingerprint), but accepts a NoEcho token', () => {
    const noEcho = { Stage: { Type: 'String', NoEcho: true } };
    expect(
      fp(template({ C: isProd }, noEcho), conditionInputsFrom({ tokens: {}, bound: { Stage: 'prod' } }))
    ).toBeUndefined();
    expect(fp(template({ C: isProd }, noEcho))).toMatch(/^sha256:/);
  });

  it('refuses a "token" input that carries no dynamic reference', () => {
    const fake = conditionInputsFrom({ tokens: { Stage: 'prod' }, bound: {} });
    expect(fp(template({ C: isProd }), fake)).toBeUndefined();
  });

  it('reports hasToken only when a secret-fed parameter is in the closure', () => {
    const plain = conditionInputsFrom({ tokens: {}, bound: { Stage: 'prod' } });
    expect(conditionFingerprint(template({ C: isProd }), 'C', plain)?.hasToken).toBe(false);
    expect(conditionFingerprint(template({ C: isProd }), 'C', tokens)?.hasToken).toBe(true);
  });
});

describe('conditionsReadByDiff', () => {
  it('collects Fn::If names in Resources and Outputs, and Condition keys, and nothing else', () => {
    const names = conditionsReadByDiff({
      Conditions: { A: {}, B: {}, C: {}, D: {}, Unused: {} },
      Resources: {
        R: {
          Type: 'T',
          Condition: 'A',
          Properties: { X: { 'Fn::Join': ['', [{ 'Fn::If': ['B', 'x', 'y'] }]] } },
        },
      },
      Outputs: { O: { Condition: 'C', Value: { 'Fn::If': ['D', 'x', 'y'] } } },
    });
    expect([...names].sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('conditionsReadByDiff skips entries a known-false condition prunes', () => {
  it('keeps the gate name, drops the Fn::If names inside the pruned entry', () => {
    const t: CloudFormationTemplate = {
      Conditions: { Gate: {}, Inner: {}, Live: {} },
      Resources: {
        Gone: { Type: 'T', Condition: 'Gate', Properties: { X: { 'Fn::If': ['Inner', 1, 2] } } },
        Kept: { Type: 'T', Properties: { X: { 'Fn::If': ['Live', 1, 2] } } },
      },
    };
    expect([...conditionsReadByDiff(t, { Gate: false })].sort()).toEqual(['Gate', 'Live']);
    expect([...conditionsReadByDiff(t, { Gate: true })].sort()).toEqual(['Gate', 'Inner', 'Live']);
  });
});

describe('parentSuppliedValues', () => {
  const t: CloudFormationTemplate = {
    Parameters: { A: { Type: 'String', Default: 'd' }, B: { Type: 'String' }, T: { Type: 'String' } },
    Resources: {},
  };
  it('withholds a supplied value other than the Default, and one with no Default, but not a token', () => {
    expect([...parentSuppliedValues(t, { A: 'x', B: 'y', T: EXPR }, new Set(['T']))].sort()).toEqual([
      'A',
      'B',
    ]);
  });
  it('keeps a supplied value equal to the Default, and anything not supplied', () => {
    expect([...parentSuppliedValues(t, { A: 'd' }, new Set())]).toEqual([]);
    expect([...parentSuppliedValues(t, undefined, new Set())]).toEqual([]);
  });
});

describe('buildConditionVerdictRecord', () => {
  it('records only a read condition whose closure reaches a secret-fed parameter', () => {
    const t: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' }, Env: { Type: 'String' } },
      Conditions: {
        C: isProd,
        Plain: { 'Fn::Equals': [{ Ref: 'Env' }, 'x'] },
        Unread: isProd,
      },
      Resources: {
        R: { Type: 'T', Properties: { A: { 'Fn::If': ['C', 1, 2] }, B: { 'Fn::If': ['Plain', 1, 2] } } },
      },
    };
    const record = buildConditionVerdictRecord(
      t,
      { C: true, Plain: false, Unread: true },
      conditionInputsFrom({ tokens: { Stage: EXPR }, bound: { Env: 'x' } })
    );
    expect(Object.keys(record ?? {})).toEqual(['C']);
    expect(record!['C']!.verdict).toBe(true);
  });

  it('never records a verdict the evaluator only assumed', () => {
    const conditions: Record<string, boolean> = { C: false };
    recordAssumedConditions(conditions, new Set(['C']));
    expect(buildConditionVerdictRecord(template({ C: isProd }), conditions, tokens)).toBeUndefined();
  });

  it('is undefined when nothing qualifies, so no field is written', () => {
    expect(buildConditionVerdictRecord(template({ C: isProd }), {}, tokens)).toBeUndefined();
  });

  it('holds neither a secret value nor its expression in clear', () => {
    const record = buildConditionVerdictRecord(template({ C: isProd }), { C: true }, tokens);
    const json = JSON.stringify(record);
    expect(json).not.toContain('resolve');
    expect(json).not.toContain('prod');
  });
});

describe('readRecordedConditionVerdicts', () => {
  it('reads a well-formed record and skips malformed entries', () => {
    const read = readRecordedConditionVerdicts({
      conditionVerdicts: {
        Good: { verdict: true, fingerprint: 'sha256:a' },
        NoFingerprint: { verdict: true },
        StringVerdict: { verdict: 'true', fingerprint: 'sha256:b' },
        Bare: true,
      } as never,
    });
    expect(Object.keys(read)).toEqual(['Good']);
  });

  it.each([undefined, null, 'x', [], 3])('reads %p as no record', (field) => {
    expect(readRecordedConditionVerdicts({ conditionVerdicts: field as never })).toEqual({});
  });

  it('reads a record named like an Object.prototype member as data', () => {
    const read = readRecordedConditionVerdicts({
      conditionVerdicts: JSON.parse('{"__proto__":{"verdict":true,"fingerprint":"sha256:a"}}'),
    });
    expect(Object.hasOwn(read, '__proto__')).toBe(true);
  });
});

describe('deployConditionInputs: no resolved secret ever enters a fingerprint', () => {
  const LONG = 'cdkd-4479-long-secret';
  const map = (entries: Array<[string, string]>) => new Map(entries);

  it('a whole-value secret becomes its expression', () => {
    const { tokens, unavailable } = deployConditionInputs({ Stage: LONG }, map([[LONG, EXPR]]));
    expect(tokens['Stage']).toBe(EXPR);
    expect(unavailable.has('Stage')).toBe(false);
  });

  it('a secret embedded in a literal becomes the embedded expression', () => {
    const { tokens } = deployConditionInputs({ Stage: `pre-${LONG}` }, map([[LONG, EXPR]]));
    expect(tokens['Stage']).toBe(`pre-${EXPR}`);
  });

  it('a plain value is neither a token nor unavailable', () => {
    const { tokens, unavailable } = deployConditionInputs({ Env: 'dev' }, map([[LONG, EXPR]]));
    expect(Object.keys(tokens)).toEqual([]);
    expect(unavailable.size).toBe(0);
  });

  it('a parent NoEcho value (a LOG-ONLY needle) is unavailable', () => {
    const inherited = map([[LONG, EXPR]]);
    recordLogOnlyValue(inherited, '4821');
    const { tokens, unavailable } = deployConditionInputs({ Pin: '4821' }, inherited);
    expect(Object.hasOwn(tokens, 'Pin')).toBe(false);
    expect(unavailable.has('Pin')).toBe(true);
  });

  it('a short secret below the redaction floor, embedded in a literal, is unavailable', () => {
    const { unavailable } = deployConditionInputs({ Pin: 'pin-123' }, map([['123', EXPR]]));
    expect(unavailable.has('Pin')).toBe(true);
  });

  it('a token that still holds a plaintext outside its reference span is unavailable', () => {
    const { tokens, unavailable } = deployConditionInputs(
      { Stage: `${LONG}:ab` },
      map([
        [LONG, EXPR],
        ['ab', '{{resolve:secretsmanager:other:SecretString:k::}}'],
      ])
    );
    expect(Object.hasOwn(tokens, 'Stage')).toBe(false);
    expect(unavailable.has('Stage')).toBe(true);
  });

  it('a value redaction masks rather than rewrites to an expression is unavailable', () => {
    const { unavailable } = deployConditionInputs({ Pin: LONG }, map([[LONG, '***']]));
    expect(unavailable.has('Pin')).toBe(true);
  });

  it('a non-string value of a child holding inherited secrets is unavailable', () => {
    const { unavailable } = deployConditionInputs({ List: ['a', 'b'] }, map([[LONG, EXPR]]));
    expect(unavailable.has('List')).toBe(true);
  });

  it('a name a state resource shadows is unavailable, with or without inherited secrets', () => {
    expect(deployConditionInputs({ Pin: 'x' }, undefined, new Set(['Pin'])).unavailable.has('Pin')).toBe(
      true
    );
  });

  it('end to end: a closure over a token and a parent NoEcho value records nothing', () => {
    const t: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' }, Pin: { Type: 'String' } },
      Conditions: {
        C: { 'Fn::And': [isProd, { 'Fn::Equals': [{ Ref: 'Pin' }, 'expected'] }] },
      },
      Resources: { R: { Type: 'T', Properties: { A: { 'Fn::If': ['C', 1, 2] } } } },
    };
    const inherited = map([['prod', EXPR]]);
    recordLogOnlyValue(inherited, '4821');
    const values = { Stage: 'prod', Pin: '4821' };
    const { tokens, unavailable } = deployConditionInputs(values, inherited);
    expect(
      buildConditionVerdictRecord(t, { C: false }, conditionInputsFrom({ tokens, bound: values, unavailable }))
    ).toBeUndefined();
  });
});
