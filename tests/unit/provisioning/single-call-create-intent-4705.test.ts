/**
 * go-to-k/cdkd#4705 review E-3 / F-4: the creates whose resource exists only
 * after ONE creating call. A 4xx from that call made nothing, so the intent
 * may go (`provenNothingCreated`); nothing after it can fail the create:
 *
 * - ECS: `CreateCluster` is the only call;
 * - Step Functions: `CreateStateMachine`, then a read-back whose failure (a 4xx
 *   included) is swallowed -- the create returns its resource, so it is
 *   recorded and never leaves an unrecorded machine behind.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  quiet.child.mockReturnValue(quiet);
  return { getLogger: () => quiet };
});

import { CreateClusterCommand } from '@aws-sdk/client-ecs';
import { CreateStateMachineCommand, DescribeStateMachineCommand } from '@aws-sdk/client-sfn';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';
import { provenNothingCreated } from '../../../src/deployment/generated-name-guard.js';

const rejected400 = (): Error =>
  Object.assign(new Error('InvalidParameterException: bad'), {
    name: 'InvalidParameterException',
    $metadata: { httpStatusCode: 400 },
  });

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
}

describe('ECS cluster: one creating call', () => {
  it('a 4xx from CreateCluster made nothing (the intent may go), and no other call was sent', async () => {
    const send = vi.fn(async () => {
      throw rejected400();
    });
    const provider = new ECSProvider();
    (provider as unknown as { ecsClient: unknown }).ecsClient = { send };
    const error = await caught(provider.create('Cluster', 'AWS::ECS::Cluster', {}));
    expect(provenNothingCreated(error, 'Cluster', 'AWS::ECS::Cluster')).toBe(true);
    expect(send.mock.calls.map((c) => (c as unknown[])[0]).every((c) => c instanceof CreateClusterCommand)).toBe(true);
  });
});

describe('Step Functions: the read-back after CreateStateMachine cannot fail the create', () => {
  it('a 4xx from DescribeStateMachine after a successful create still returns the machine (recorded, never lost)', async () => {
    const arn = 'arn:aws:states:us-east-1:123456789012:stateMachine:App-Sm';
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof CreateStateMachineCommand) return { stateMachineArn: arn };
      if (cmd instanceof DescribeStateMachineCommand) throw Object.assign(rejected400(), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
      throw new Error('unexpected');
    });
    const provider = new StepFunctionsProvider();
    (provider as unknown as { sfnClient: unknown }).sfnClient = { send };
    const result = await provider.create('Sm', 'AWS::StepFunctions::StateMachine', {
      RoleArn: 'arn:aws:iam::123456789012:role/r',
      DefinitionString: '{"StartAt":"P","States":{"P":{"Type":"Pass","End":true}}}',
    });
    expect(result.physicalId).toBe(arn);
  });

  it('a 4xx from CreateStateMachine itself made nothing (the intent may go)', async () => {
    const send = vi.fn(async () => {
      throw rejected400();
    });
    const provider = new StepFunctionsProvider();
    (provider as unknown as { sfnClient: unknown }).sfnClient = { send };
    const error = await caught(
      provider.create('Sm', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/r',
        DefinitionString: '{"StartAt":"P","States":{"P":{"Type":"Pass","End":true}}}',
      })
    );
    expect(provenNothingCreated(error, 'Sm', 'AWS::StepFunctions::StateMachine')).toBe(true);
  });
});
