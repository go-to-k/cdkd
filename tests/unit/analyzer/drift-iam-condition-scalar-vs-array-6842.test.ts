/**
 * go-to-k/cdkd#6842: a trust-policy condition value that is a TWO-element
 * array on the baseline and a scalar in AWS (the live policy NARROWER than the
 * record) must be reported, whichever baseline `cdkd drift` compares.
 *
 * The issue's repro reported "no drift" because it ran `cdkd state
 * refresh-observed --yes` first, which re-captures `observedProperties` from
 * AWS: the baseline then held AWS's scalar, so baseline and AWS agreed, by
 * design. The incoherent record was `properties`, written by
 * `--migrate-from-cloudformation` from the synthesized template while AWS kept
 * the deployed one — go-to-k/cdkd#6840's defect, fixed there. These cases pin
 * that the comparator itself tells the two shapes apart, on the call shape
 * `cdkd drift` uses (`drift/compare.ts`).
 *
 * A ONE-element array against the same scalar is reported too. IAM returns a
 * role's trust policy as it was submitted (`AWS::IAM::Role` is a
 * `drift-verbatim-paths.ts` verbatim-echo type), so an observed baseline
 * captured from AWS never meets its own value in the other spelling: the
 * difference can only come from an out-of-band rewrite of the document, which
 * is drift of the document even where IAM evaluates both spellings alike.
 */
import { describe, it, expect } from 'vite-plus/test';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { verbatimEchoDriftKeys } from '../../../src/analyzer/drift-verbatim-paths.js';

const TYPE = 'AWS::IAM::Role';
const SUB = 'token.actions.githubusercontent.com:sub';
const MAIN = 'repo:go-to-k/cdkd:ref:refs/heads/main';
const IMMUTABLE = 'repo:go-to-k@24818752/cdkd@1191203392:ref:refs/heads/main';

function trust(sub: unknown): Record<string, unknown> {
  return {
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Federated: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
          },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: { StringLike: { [SUB]: sub } },
        },
      ],
    },
  };
}

function drift(baseline: unknown, aws: unknown, observed: boolean) {
  return calculateResourceDrift(trust(baseline), trust(aws), {
    unionWalkObjects: observed,
    unionWalkPaths: verbatimEchoDriftKeys(TYPE),
    resourceType: TYPE,
  });
}

describe.each([
  ['observedProperties baseline', true],
  ['properties baseline', false],
])('IAM trust condition scalar vs array (#6842) — %s', (_label, observed) => {
  it('reports a two-element baseline against a scalar in AWS', () => {
    const changes = drift([MAIN, IMMUTABLE], MAIN, observed);
    expect(changes).toHaveLength(1);
    // Arrays compare whole, so the change is the statement list, carrying both values.
    expect(changes[0]!.path).toBe('AssumeRolePolicyDocument.Statement');
    expect(JSON.stringify(changes[0]!.stateValue)).toContain(IMMUTABLE);
    expect(JSON.stringify(changes[0]!.awsValue)).not.toContain(IMMUTABLE);
  });

  it('reports a scalar baseline against a two-element array in AWS (the widened direction)', () => {
    expect(drift(MAIN, [MAIN, IMMUTABLE], observed)).toHaveLength(1);
  });

  it('reports a one-element baseline against the scalar spelling (a rewrite of a verbatim-echo document)', () => {
    expect(drift([MAIN], MAIN, observed)).toHaveLength(1);
  });

  it('is clean when both sides hold the same shape', () => {
    expect(drift(MAIN, MAIN, observed)).toEqual([]);
    expect(drift([MAIN, IMMUTABLE], [MAIN, IMMUTABLE], observed)).toEqual([]);
  });
});
