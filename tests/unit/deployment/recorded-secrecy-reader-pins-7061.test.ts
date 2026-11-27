/**
 * go-to-k/cdkd#7061: pins for two nested-child readers the slice routed
 * through `recorded-secrecy.ts`, whose marker arms no other test reached.
 *
 * - `holdsSubFloorSecret` (`record-parameter-expressions.ts`) skips a
 *   MASK-ONLY pair: its plaintext is no secret's text, so a value holding it
 *   marks no parameter `sub-floor`.
 * - `evaluatePureSub` (`reread.ts`) refuses an `Fn::Sub` whose text names a
 *   dynamic reference: the resolver would resolve it, so no re-read is the
 *   value the pass held.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { attributionRefusedParameters } from '../../../src/deployment/secret-redaction/nested-stack/parameter-tables.js';
import { rereadParameterExpression } from '../../../src/deployment/secret-redaction/nested-stack.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { setLevel: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

const STACK_TYPE = 'AWS::CloudFormation::Stack';
const LONG_EXPR = '{{resolve:secretsmanager:prod/app:SecretString:pw::}}';
const LONG = 'l0ng-pl4intext-7061';

describe('holdsSubFloorSecret skips a mask-only pair (#7061)', () => {
  function markOf(short: string, expression: string): string | undefined {
    const secrets: RecordedSecretValues = new Map([
      [LONG, LONG_EXPR],
      [short, expression],
    ]);
    recordResolvedPair(secrets, LONG_EXPR, LONG);
    recordNestedStackParameterExpressions(
      secrets,
      STACK_TYPE,
      { Parameters: { P: `x${short}y` } },
      { Parameters: { P: `x${short}y` } }
    );
    return attributionRefusedParameters.get(secrets)?.get('P');
  }

  it('a value holding a short mask-only plaintext marks nothing', () => {
    expect(markOf('ab', SECRET_MASK)).toBeUndefined();
  });

  it('a value holding a short SECRET plaintext is marked sub-floor (control)', () => {
    expect(markOf('ab', '{{resolve:ssm-secure:/short}}')).toBe('sub-floor');
  });
});

describe('a re-read refuses an Fn::Sub whose text names a dynamic reference (#7061)', () => {
  const parent: RecordedSecretValues = new Map([[LONG, LONG_EXPR]]);
  recordResolvedPair(parent, LONG_EXPR, LONG);
  // A re-read needs a trigger (`Fn::Select`, `Fn::Split`, `Fn::If`) around the `Fn::Sub`.
  const select = (text: string): unknown => ({ 'Fn::Select': [0, [{ 'Fn::Sub': text }]] });
  const bind = (name: string): { value: unknown } | undefined =>
    name === 'Conn' ? { value: 'plain-conn-7061' } : undefined;

  it('refuses the text holding an opener', () => {
    expect(rereadParameterExpression(select('${Conn}{{resolve:'), bind, parent)).toBeUndefined();
  });

  it('re-reads the same text without one (control)', () => {
    expect(rereadParameterExpression(select('${Conn}{{resolv'), bind, parent)?.resolved).toBe(
      'plain-conn-7061{{resolv'
    );
  });
});
