import { describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: EventBridge Pipes `CreatePipe` calls (the Pipes API has no `ClientToken`) carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-pipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-pipes')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    PipesClient: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ConflictException } from '@aws-sdk/client-pipes';
import { PipesPipeProvider } from '../../../src/provisioning/providers/pipes-provider.js';
import { topLevel, useService, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const CREATES: Record<string, NamedCreate> = {
  CreatePipeCommand: {
    nameOf: topLevel('Name'),
    collision: (n) =>
      new ConflictException({
        message: `Pipe ${n} already exists.`,
        resourceId: n,
        resourceType: 'pipe',
        $metadata: { httpStatusCode: 409 },
      }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::Pipes::Pipe',
    command: 'CreatePipeCommand',
    name: 'orders-pipe',
    props: {
      Name: 'orders-pipe',
      RoleArn: 'arn:aws:iam::123456789012:role/pipe',
      Source: 'arn:aws:sqs:eu-west-3:123456789012:orders',
      Target: 'arn:aws:sqs:eu-west-3:123456789012:orders-out',
    },
    provider: () => new PipesPipeProvider(),
    prose: true,
    postCreateCalls: true,
    successResponses: {
      // `waitForSettled` polls until a settled state.
      DescribePipeCommand: {
        Name: 'orders-pipe',
        Arn: 'arn:aws:pipes:eu-west-3:123456789012:pipe/orders-pipe',
        CurrentState: 'RUNNING',
        DesiredState: 'RUNNING',
      },
    },
  },
];

describeCreateRetrySafety(SITES, CREATES);

describe('a Pipes create / update failure masks the AWS text it carries', () => {
  const SECRET = 'pipe-s3cr3t-value';
  const maskSecrets = (text: string) => text.replaceAll(SECRET, '****');
  const props = { ...SITES[0]!.props, Description: SECRET };

  it('masks a resolved value AWS echoes into a failed CreatePipe', async () => {
    useService(async (command) => {
      if (command.constructor.name === 'CreatePipeCommand') {
        throw new Error(`Invalid Description '${SECRET}'`);
      }
      return {};
    });

    const error = await new PipesPipeProvider()
      .create('Res', 'AWS::Pipes::Pipe', props, { maskSecrets })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain("Invalid Description '****'");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('masks a resolved value AWS echoes into a failed UpdatePipe', async () => {
    useService(async (command) => {
      if (command.constructor.name === 'UpdatePipeCommand') {
        throw new Error(`Invalid Description '${SECRET}'`);
      }
      return {};
    });

    const error = await new PipesPipeProvider()
      .update('Res', 'orders-pipe', 'AWS::Pipes::Pipe', props, SITES[0]!.props, { maskSecrets })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain("Invalid Description '****'");
    expect((error as Error).message).not.toContain(SECRET);
  });
});
