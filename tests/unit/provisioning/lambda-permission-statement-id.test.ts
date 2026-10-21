import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { AddPermissionCommand } from '@aws-sdk/client-lambda';

// go-to-k/cdkd#5137: the StatementId a create sends is generated as
// CloudFormation does on a stack with an instance id, with a new one at each
// replacement's name generation; a legacy stack keeps the bare logical id.
const mockSend = vi.fn();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';
import {
  stackInstanceNameSuffix,
  withNameGeneration,
  withStackScope,
  withStackScopeBeforeStateRead,
} from '../../../src/provisioning/resource-name.js';

const INSTANCE_ID = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';
const PROPS = { FunctionName: 'my-function', Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com' };

async function sentStatementId(
  logicalId: string,
  scope: { stackInstanceId: string | undefined },
  generation?: number
): Promise<{ sent: string | undefined; physicalId: string }> {
  mockSend.mockResolvedValueOnce({});
  const provider = new LambdaPermissionProvider();
  const create = (): ReturnType<LambdaPermissionProvider['create']> =>
    provider.create(logicalId, 'AWS::Lambda::Permission', PROPS);
  const result = await withStackScope(
    { stackName: 'MyStack', stackInstanceId: scope.stackInstanceId, nameGenerations: new Map() },
    () => (generation === undefined ? create() : withNameGeneration({ logicalId, generation }, create))
  );
  const cmd = mockSend.mock.calls.at(-1)?.[0] as AddPermissionCommand;
  expect(cmd).toBeInstanceOf(AddPermissionCommand);
  return { sent: cmd.input.StatementId, physicalId: result.physicalId };
}

describe('LambdaPermissionProvider StatementId (go-to-k/cdkd#5137)', () => {
  beforeEach(() => mockSend.mockReset());

  it('sends {StackName}-{LogicalId}-{suffix} on a stack with an instance id, and records it', async () => {
    const { sent, physicalId } = await sentStatementId('ApiPermission', { stackInstanceId: INSTANCE_ID });
    expect(sent).toBe(`MyStack-ApiPermission-${stackInstanceNameSuffix(INSTANCE_ID, 'ApiPermission')}`);
    expect(physicalId).toBe(sent);
  });

  it('sends a different id at the next name generation, so a replacement creates first', async () => {
    const first = await sentStatementId('ApiPermission', { stackInstanceId: INSTANCE_ID });
    const next = await sentStatementId('ApiPermission', { stackInstanceId: INSTANCE_ID }, 1);
    expect(next.sent).toBe(`MyStack-ApiPermission-${stackInstanceNameSuffix(INSTANCE_ID, 'ApiPermission', 1)}`);
    expect(next.sent).not.toBe(first.sent);
  });

  it('keeps a long logical id within 100 allowed characters', async () => {
    const logicalId = `ChatBackendChatApichatPOSTApiPermissionTest${'X'.repeat(80)}913B820B`;
    const { sent } = await sentStatementId(logicalId, { stackInstanceId: INSTANCE_ID });
    expect(sent!.length).toBeLessThanOrEqual(100);
    expect(sent).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(sent!.endsWith(`-${stackInstanceNameSuffix(INSTANCE_ID, logicalId)}`)).toBe(true);
  });

  it('keeps the bare logical id on a legacy stack', async () => {
    const { sent } = await sentStatementId('ApiPermission', { stackInstanceId: undefined });
    expect(sent).toBe('ApiPermission');
  });
  it('throws before the state read instead of falling back to the legacy id', async () => {
    const provider = new LambdaPermissionProvider();
    await expect(
      withStackScopeBeforeStateRead('MyStack', () =>
        provider.create('ApiPermission', 'AWS::Lambda::Permission', PROPS)
      )
    ).rejects.toThrow(/before the state record/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
