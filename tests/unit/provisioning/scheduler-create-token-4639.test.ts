import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { Readable } from 'node:stream';

// go-to-k/cdkd#4639: Scheduler `CreateSchedule` keeps the shared client's full
// SDK retry ON PURPOSE. cdkd sends no `ClientToken`; the SDK fills one while
// SERIALIZING the request, once per `send`, and its retry middleware replays
// that same serialized request, so a 5xx replay carries the first attempt's
// token and Scheduler answers it idempotently. If an SDK upgrade ever mints
// the token per ATTEMPT, the replay becomes a fresh create and this site needs
// the dedicated no-5xx-replay client its siblings have: these cases go red.

const { sent } = vi.hoisted(() => ({ sent: [] as Array<[string, Record<string, unknown>]> }));

vi.mock('@aws-sdk/client-scheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-scheduler')>();
  return {
    ...actual,
    // The provider's client: records each command's INPUT as cdkd built it.
    SchedulerClient: vi.fn().mockImplementation(() => ({
      config: { region: () => Promise.resolve('us-east-1') },
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push([command.constructor.name, command.input]);
        return { ScheduleArn: 'arn:aws:scheduler:us-east-1:123456789012:schedule/default/s' };
      },
    })),
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

import { SchedulerScheduleProvider } from '../../../src/provisioning/providers/scheduler-schedule-provider.js';

const INPUT = {
  Name: 'orders-schedule',
  ScheduleExpression: 'rate(1 day)',
  FlexibleTimeWindow: { Mode: 'OFF' as const },
  Target: {
    Arn: 'arn:aws:sqs:us-east-1:123456789012:orders',
    RoleArn: 'arn:aws:iam::123456789012:role/scheduler',
  },
};

describe('Scheduler CreateSchedule token across the SDK retry (issue #4639)', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('a REAL SchedulerClient replays a 5xx with the SAME ClientToken on every attempt', async () => {
    const real = await vi.importActual<typeof import('@aws-sdk/client-scheduler')>(
      '@aws-sdk/client-scheduler'
    );
    const tokens: unknown[] = [];
    const statuses = [500, 500, 200];
    const client = new real.SchedulerClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      requestHandler: {
        handle: async (request: { body: unknown }) => {
          tokens.push((JSON.parse(String(request.body)) as { ClientToken?: unknown }).ClientToken);
          const status = statuses.shift() ?? 200;
          const failed = status !== 200;
          return {
            response: {
              statusCode: status,
              headers: {
                'content-type': 'application/json',
                ...(failed && { 'x-amzn-errortype': 'InternalServerException' }),
              },
              body: Readable.from([
                Buffer.from(
                  failed
                    ? '{"message":"boom"}'
                    : '{"ScheduleArn":"arn:aws:scheduler:us-east-1:123456789012:schedule/default/s"}'
                ),
              ]),
            },
          };
        },
      } as never,
    });

    const out = await client.send(new real.CreateScheduleCommand(INPUT));

    expect(out.$metadata.attempts).toBe(3);
    expect(tokens).toHaveLength(3);
    expect(typeof tokens[0]).toBe('string');
    expect(tokens[0]).not.toBe('');
    expect(new Set(tokens).size).toBe(1);
  });

  it('cdkd sends no ClientToken of its own, so the SDK fills it', async () => {
    await new SchedulerScheduleProvider().create('Res', 'AWS::Scheduler::Schedule', {
      Name: INPUT.Name,
      ScheduleExpression: INPUT.ScheduleExpression,
      FlexibleTimeWindow: INPUT.FlexibleTimeWindow,
      Target: INPUT.Target,
    });

    const creates = sent.filter(([name]) => name === 'CreateScheduleCommand');
    expect(creates).toHaveLength(1);
    expect(creates[0]![1]).toMatchObject({ Name: INPUT.Name });
    expect(creates[0]![1]).not.toHaveProperty('ClientToken');
  });
});
