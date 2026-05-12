import { describe, expect, it } from 'vitest';
import { envHasIntrinsicValue } from '../../../src/cli/commands/local-invoke.js';
import {
  substituteEnvVarsFromState,
  type SubstitutionContext,
} from '../../../src/local/state-resolver.js';
import type { ResourceState } from '../../../src/types/state.js';

function res(physicalId: string, attributes: Record<string, unknown> = {}): ResourceState {
  return {
    physicalId,
    resourceType: 'AWS::Test::Type',
    properties: {},
    attributes,
    dependencies: [],
  };
}

describe('envHasIntrinsicValue', () => {
  it('returns false for undefined env', () => {
    expect(envHasIntrinsicValue(undefined)).toBe(false);
  });

  it('returns false for fully-literal env map', () => {
    expect(envHasIntrinsicValue({ A: 'a', B: 42, C: true })).toBe(false);
  });

  it('returns true when any value is a CFn intrinsic object', () => {
    expect(envHasIntrinsicValue({ A: 'a', REGION: { Ref: 'AWS::Region' } })).toBe(true);
    expect(envHasIntrinsicValue({ ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] } })).toBe(true);
    expect(envHasIntrinsicValue({ X: { 'Fn::Join': [':', ['a', { Ref: 'AWS::Region' }]] } })).toBe(
      true
    );
  });

  it('ignores null / undefined entries (they pass through as not-intrinsic)', () => {
    expect(envHasIntrinsicValue({ A: 'a', B: null as unknown as undefined })).toBe(false);
  });
});

describe('cdkd local invoke --from-state: pseudo-parameter wiring via substituteEnvVarsFromState', () => {
  it('resolves ${AWS::Region} inside Fn::Sub when pseudoParameters bag is supplied', () => {
    const ctx: SubstitutionContext = {
      resources: {},
      pseudoParameters: { region: 'us-east-1' },
    };
    const { env, audit } = substituteEnvVarsFromState(
      { REGION_URL: { 'Fn::Sub': 'https://${AWS::Region}.example.com' } },
      ctx
    );
    expect(env).toEqual({ REGION_URL: 'https://us-east-1.example.com' });
    expect(audit.resolvedKeys).toEqual(['REGION_URL']);
    expect(audit.unresolved).toEqual([]);
  });

  it('resolves Fn::Join over AWS pseudo parameters + a state Ref (canonical Secret/SSM shape)', () => {
    // Models the SSM Parameter ARN shape CDK synthesizes for env vars built from
    // ssm.StringParameter.parameterArn — Fn::Join over ${AWS::Partition} +
    // ${AWS::Region} + ${AWS::AccountId} + Ref to the parameter.
    const ctx: SubstitutionContext = {
      resources: {
        MyParam: res('/my/param'),
      },
      pseudoParameters: {
        partition: 'aws',
        region: 'us-east-1',
        accountId: '123456789012',
      },
    };
    const { env, audit } = substituteEnvVarsFromState(
      {
        PARAM_ARN: {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':ssm:',
              { Ref: 'AWS::Region' },
              ':',
              { Ref: 'AWS::AccountId' },
              ':parameter',
              { Ref: 'MyParam' },
            ],
          ],
        },
      },
      ctx
    );
    expect(env).toEqual({
      PARAM_ARN: 'arn:aws:ssm:us-east-1:123456789012:parameter/my/param',
    });
    expect(audit.resolvedKeys).toEqual(['PARAM_ARN']);
    expect(audit.unresolved).toEqual([]);
  });

  it('drops a ${AWS::Region} placeholder when no pseudoParameters bag is supplied (PR-294 baseline)', () => {
    // This is the pre-fix behavior at the CLI layer: when local-invoke.ts
    // did not pass pseudoParameters, AWS::Region placeholders fell through to
    // unresolved and the env var was dropped. The fix is the CLI now builds
    // the bag (tested via envHasIntrinsicValue gating + the wired call).
    const ctx: SubstitutionContext = { resources: {} };
    const { env, audit } = substituteEnvVarsFromState(
      { REGION: { 'Fn::Sub': '${AWS::Region}' } },
      ctx
    );
    expect(env).toEqual({});
    expect(audit.unresolved).toHaveLength(1);
    expect(audit.unresolved[0]!.key).toBe('REGION');
    expect(audit.unresolved[0]!.reason).toMatch(/pseudo parameter not supplied/);
  });

  it('mixed-success: state Ref resolves, AWS::AccountId resolves, unsupported Fn::ImportValue is dropped', () => {
    const ctx: SubstitutionContext = {
      resources: { MyTable: res('my-table-name') },
      pseudoParameters: { accountId: '123456789012' },
    };
    const { env, audit } = substituteEnvVarsFromState(
      {
        TABLE: { Ref: 'MyTable' },
        ACCOUNT: { Ref: 'AWS::AccountId' },
        IMPORTED: { 'Fn::ImportValue': 'OtherStackExport' },
      },
      ctx
    );
    expect(env).toEqual({ TABLE: 'my-table-name', ACCOUNT: '123456789012' });
    expect(audit.resolvedKeys.sort()).toEqual(['ACCOUNT', 'TABLE']);
    expect(audit.unresolved.map((u) => u.key)).toEqual(['IMPORTED']);
  });
});
