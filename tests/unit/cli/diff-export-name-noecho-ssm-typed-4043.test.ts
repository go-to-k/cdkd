/**
 * go-to-k/cdkd#4043: `cdkd diff`'s export-name seed for a `NoEcho`
 * `AWS::SSM::Parameter::Value<...>` parameter holds the LOOKED-UP value, never
 * the SSM parameter NAME the template spells as its `Default` -- the deploy's
 * rule (`export-name-noecho-refusal-4043.test.ts` pins that side). A file of
 * its own because it mocks the SSM lookup.
 */

import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: 'lookedUpSsmSecret42' } }) },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

describe('cdkd diff - a NoEcho SSM-typed parameter seeds its looked-up value only (go-to-k/cdkd#4043)', () => {
  it('publishes a name spelling the SSM path and refuses one spelling the looked-up value', async () => {
    const template = {
      Parameters: {
        Pw: { Type: 'AWS::SSM::Parameter::Value<String>', NoEcho: true, Default: 'DbPassword' },
      },
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x', Description: { Ref: 'Pw' } } },
      },
      Outputs: {
        ByName: { Value: 'n', Export: { Name: 'exp-DbPasswordArn' } },
        ByValue: { Value: 'v', Export: { Name: 'exp-lookedUpSsmSecret42' } },
      },
    } as unknown as CloudFormationTemplate;
    const state: StackState = {
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        A: {
          physicalId: 'pid',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: 'x', Description: 'lookedUpSsmSecret42' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: { ByName: 'n', ByValue: 'v' },
      version: 6,
      lastModified: 0,
    };
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    const result = await computeStackDiff(
      state,
      template,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    expect(result.outputChanges.map((c) => `${c.changeType} ${c.name}`)).toEqual([
      'ADD exp-DbPasswordArn',
    ]);
  });

  it('publishes a name spelling an operator-supplied SSM name, as the deploy does', async () => {
    const template = {
      Parameters: { Pw: { Type: 'AWS::SSM::Parameter::Value<String>', NoEcho: true } },
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x', Description: { Ref: 'Pw' } } },
      },
      Outputs: { ByName: { Value: 'n', Export: { Name: 'exp-DbPasswordArn' } } },
    } as unknown as CloudFormationTemplate;
    const state: StackState = {
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        A: {
          physicalId: 'pid',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: 'x', Description: 'DbPassword' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: { ByName: 'n' },
      version: 6,
      lastModified: 0,
    };
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    const result = await computeStackDiff(
      state,
      template,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { Pw: 'DbPassword' } }
    );
    expect(result.outputChanges.map((c) => `${c.changeType} ${c.name}`)).toEqual([
      'ADD exp-DbPasswordArn',
    ]);
  });
});
