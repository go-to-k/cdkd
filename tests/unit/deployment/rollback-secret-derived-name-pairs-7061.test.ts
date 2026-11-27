/**
 * go-to-k/cdkd#7061: `secretDerivedNamePairs` derives the rewritten spellings of
 * a recorded name only from a name that IS one. A name that is the mask or holds
 * a dynamic reference derives nothing: `***` would derive the stack prefix as a
 * needle, which then masks every mention of the stack in the op's text.
 */
import { describe, expect, it } from 'vite-plus/test';
import { secretDerivedNamePairs } from '../../../src/deployment/rollback-executor/names.js';

const ROLE = 'AWS::IAM::Role';

describe('secretDerivedNamePairs (go-to-k/cdkd#7061)', () => {
  it('derives the rewritten spellings of a plain recorded name (control)', () => {
    const pairs = secretDerivedNamePairs({
      resourceType: ROLE,
      properties: { RoleName: 'my-plain-role' },
      logicalId: 'Role',
      physicalIds: [],
    });
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every(([value]) => value === 'my-plain-role')).toBe(true);
  });

  it.each([
    ['the mask', '***'],
    ['a dynamic reference', '{{resolve:secretsmanager:n:SecretString:role}}'],
  ])('derives nothing from a name that is %s', (_what, name) => {
    const pairs = secretDerivedNamePairs({
      resourceType: ROLE,
      properties: { RoleName: name },
      logicalId: 'Role',
      physicalIds: [],
    });
    expect(pairs).toEqual([]);
  });
});
