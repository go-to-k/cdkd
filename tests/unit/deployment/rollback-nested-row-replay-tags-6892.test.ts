/**
 * go-to-k/cdkd#6892: a nested-stack row re-created by a reverse-replacement
 * replay must keep its own `Tags` (they become the child's stack tags,
 * #6871). The replay re-creates from the row's STATE RECORD, which before
 * go-to-k/cdkd#6893 (PR #6896) never held `Tags` (SDK-unwired on
 * `AWS::CloudFormation::Stack`, stripped from the record), so the re-created
 * child got only the parent's stack tags. `Tags` is now a handled property
 * kept in the record, so the replay hands it to the provider's `create()`.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { propertiesToRecord } from '../../../src/deployment/deploy-engine/record-shape.js';
import type { ResourceState } from '../../../src/types/state.js';

const ROW = 'AWS::CloudFormation::Stack';
const ROW_TAGS = [
  { Key: 'team', Value: 'core' },
  { Key: 'env', Value: 'prod' },
];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };

function row(physicalId: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId, resourceType: ROW, properties, attributes: {}, dependencies: [] };
}

describe("a reverse-replacement replay of a nested-stack row keeps the row's Tags (go-to-k/cdkd#6892)", () => {
  it('the record a deploy writes for a tagged row holds Tags, and the replay re-creates with them', async () => {
    // The record exactly as a deploy writes it on the SDK route.
    const recorded = propertiesToRecord(
      { TemplateURL: 'https://bucket/child.json', Tags: ROW_TAGS },
      {},
      ROW,
      'sdk'
    );
    expect(recorded['Tags']).toEqual(ROW_TAGS);

    const create = vi.fn().mockResolvedValue({ physicalId: 'arn:row-old-2' });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider: { create, delete: del } }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: () => undefined,
    };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: ROW,
        physicalId: 'arn:row-new',
        previousState: row('arn:row-old', recorded),
      },
    ];
    const state = { Child: row('arn:row-new', { TemplateURL: 'https://bucket/child-2.json' }) };

    const result = await replayRollback(ops, state, 'Parent', ctx, { isInterrupted: () => false });

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    const [logicalId, resourceType, properties] = create.mock.calls[0]!;
    expect([logicalId, resourceType]).toEqual(['Child', ROW]);
    expect((properties as Record<string, unknown>)['Tags']).toEqual(ROW_TAGS);
  });
});
