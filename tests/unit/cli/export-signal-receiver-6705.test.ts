import { describe, it, expect, vi } from 'vite-plus/test';
import { assertCfnStackAbsent } from '../../../src/cli/commands/export/command-helpers.js';
import { RECEIVER_DESCRIPTION, RECEIVER_TAG_KEY } from '../../../src/deployment/deploy-engine/signal-receiver.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * go-to-k/cdkd#6705: `cdkd export`'s "the CloudFormation stack must not exist"
 * pre-flight lets cdkd's own signal receiver through (it is deleted right
 * before the IMPORT changeset), and still refuses a foreign stack.
 */
const clientAnswering = (stack: Record<string, unknown>): AwsClients['cloudFormation'] =>
  ({ send: vi.fn().mockResolvedValue({ Stacks: [stack] }) }) as unknown as AwsClients['cloudFormation'];

describe('assertCfnStackAbsent and the signal receiver (go-to-k/cdkd#6705)', () => {
  it('lets the stack own receiver (tag AND description) through', async () => {
    const client = clientAnswering({
      StackName: 'S',
      StackStatus: 'CREATE_COMPLETE',
      Description: RECEIVER_DESCRIPTION,
      Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }],
    });
    await expect(assertCfnStackAbsent(client, 'S', 'S')).resolves.toBeUndefined();
  });

  it('refuses a receiver held under a name other than the exported cdkd stack own', async () => {
    const client = clientAnswering({
      StackName: 'Other',
      StackStatus: 'CREATE_COMPLETE',
      Description: RECEIVER_DESCRIPTION,
      Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }],
    });
    await expect(assertCfnStackAbsent(client, 'Other', 'S')).rejects.toThrow(/already exists/);
    await expect(assertCfnStackAbsent(client, 'Other')).rejects.toThrow(/already exists/);
  });

  it('still refuses a foreign stack', async () => {
    const client = clientAnswering({ StackName: 'S', StackStatus: 'CREATE_COMPLETE' });
    await expect(assertCfnStackAbsent(client, 'S', 'S')).rejects.toThrow(/already exists/);
  });

  it('refuses a stack carrying only the tag, or only the description', async () => {
    await expect(
      assertCfnStackAbsent(
        clientAnswering({
          StackStatus: 'CREATE_COMPLETE',
          Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }],
        }),
        'S',
        'S'
      )
    ).rejects.toThrow(/already exists/);
    await expect(
      assertCfnStackAbsent(
        clientAnswering({ StackStatus: 'CREATE_COMPLETE', Description: RECEIVER_DESCRIPTION }),
        'S',
        'S'
      )
    ).rejects.toThrow(/already exists/);
  });
});
