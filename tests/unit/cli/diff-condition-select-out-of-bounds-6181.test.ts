/**
 * go-to-k/cdkd#6181: a condition selecting past the end of a list makes
 * `cdkd deploy` refuse the template, so `cdkd diff`, which skips its condition
 * evaluation then, WARNS instead of showing every gated resource silently.
 */

import { describe, expect, it, vi } from 'vite-plus/test';

const warns = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: (m: unknown): void => void warns.push(String(m)),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

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

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      destroy: vi.fn(),
    })),
  };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const backend = {
  getState: async () => null,
  saveState: vi.fn(),
  putState: vi.fn(),
  deleteState: vi.fn(),
} as unknown as S3StateBackend;

const state: StackState = {
  stackName: 'S',
  region: 'us-east-1',
  version: 16,
  lastModified: 0,
  outputs: {},
  resources: {},
};

function templateWith(condition: unknown): CloudFormationTemplate {
  return {
    Conditions: { C: condition },
    Resources: {
      P: { Type: 'AWS::SSM::Parameter', Condition: 'C', Properties: { Type: 'String', Value: 'v' } },
    },
  } as unknown as CloudFormationTemplate;
}

describe('cdkd diff warns on a condition cdkd deploy refuses (go-to-k/cdkd#6181)', () => {
  it('an out-of-bounds Fn::Select in a condition is a warning naming the refusal', async () => {
    warns.length = 0;
    await computeStackDiff(
      state,
      templateWith({ 'Fn::Equals': [{ 'Fn::Select': [1, { 'Fn::Split': [',', 'only'] }] }, 'x'] }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    const line = warns.find((w) => w.includes('Diff condition evaluation for stack'));
    expect(line).toBeDefined();
    expect(line).toContain('the index 1 is out of bounds (array length: 1)');
    expect(line).toContain('`cdkd deploy` refuses this template.');
  });

  it('CONTROL: an in-bounds condition warns nothing about skipping', async () => {
    warns.length = 0;
    await computeStackDiff(
      state,
      templateWith({ 'Fn::Equals': [{ 'Fn::Select': [0, { 'Fn::Split': [',', 'only'] }] }, 'x'] }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    expect(warns.some((w) => w.includes('Diff condition evaluation for stack'))).toBe(false);
  });
});
