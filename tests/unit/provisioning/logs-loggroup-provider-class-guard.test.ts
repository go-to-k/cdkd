import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

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

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const PHYSICAL_ID = '/cdkd/class-guard-test';

// LogGroupClass is documented by CloudFormation as "Update requires: Updates
// are not supported" and CloudWatch Logs has no API to change a log group's
// class after creation. cdkd previously silently DROPPED the change (deploy
// reported success while AWS kept the old class, and state recorded the new
// one so the next diff saw no change). The guard throws the typed
// ResourceUpdateNotSupportedError so the deploy fails actionably and
// `--replace` can recreate the log group under the new class.
describe('LogsLogGroupProvider LogGroupClass update guard', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new LogsLogGroupProvider();
  });

  it('throws ResourceUpdateNotSupportedError on a STANDARD -> INFREQUENT_ACCESS change, before any mutation', async () => {
    await expect(
      provider.update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        // RetentionInDays ALSO changes so a guard misplaced after the
        // retention branch would provably send PutRetentionPolicy first.
        { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 7 },
        { LogGroupClass: 'STANDARD', RetentionInDays: 1 }
      )
    ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });

    // The guard must fire BEFORE any other mutation is applied.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('treats an absent property as STANDARD (absent -> INFREQUENT_ACCESS throws)', async () => {
    await expect(
      provider.update('ClassLg', PHYSICAL_ID, RESOURCE_TYPE, { LogGroupClass: 'INFREQUENT_ACCESS' }, {})
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });

  it('does NOT throw on an explicit-STANDARD <-> absent transition (both mean the default class)', async () => {
    await expect(
      provider.update('ClassLg', PHYSICAL_ID, RESOURCE_TYPE, {}, { LogGroupClass: 'STANDARD' })
    ).resolves.toBeDefined();
  });

  it('proceeds with unrelated updates when the class is unchanged', async () => {
    await provider.update(
      'ClassLg',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 7 },
      { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 1 }
    );

    const retention = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutRetentionPolicyCommand
    );
    expect(retention).toBeDefined();
  });

  it('throws on a change to the DELIVERY class too', async () => {
    await expect(
      provider.update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'DELIVERY' },
        { LogGroupClass: 'STANDARD' }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });

  it('names the class transition it refused, in both directions', async () => {
    // The flag set used to be CONDITIONAL, and this case asserted the negative
    // — a never-expiring log group was told a bare `--replace` would do. Issue
    // #2558 retired that premise, and the unconditional-advice cases below own
    // the flag set now. What is left here is the TRANSITION text, which no
    // other case pins — and the BACKWARD direction below is coverage no other
    // case has at all (the forward arm differs from its sibling only in the
    // retention value, which is why it is not the point of this case).
    const forward = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupClass: 'STANDARD', RetentionInDays: 30 }
      )
      .catch((e: Error) => e);
    expect((forward as Error).message).toMatch(/'STANDARD' -> 'INFREQUENT_ACCESS'/);

    const backward = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'STANDARD', RetentionInDays: 30 },
        { LogGroupClass: 'INFREQUENT_ACCESS' }
      )
      .catch((e: Error) => e);
    expect((backward as Error).message).toMatch(/'INFREQUENT_ACCESS' -> 'STANDARD'/);
  });

  it('names --force-stateful-recreation when the log group retains data (stateful guard)', async () => {
    const err = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 7 },
        { LogGroupClass: 'STANDARD', RetentionInDays: 7 }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/--replace --force-stateful-recreation/);
  });

  it('names it for a NEVER-EXPIRING log group too — the advice is unconditional (issue #2558)', async () => {
    // The polarity the retention case above cannot see, and the one the flag
    // set used to get WRONG: with no `RetentionInDays` in either bag the
    // provider advised a bare `--replace`, on the retired premise that such a
    // log group was not stateful. It is CloudWatch Logs' never-expire, the
    // mid-deploy guard refuses it, and following that advice cost the user a
    // second failed deploy. Both bags are retention-free here, so a
    // conditional keyed on EITHER bag reds.
    const err = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupClass: 'STANDARD' }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/--replace --force-stateful-recreation/);
    // The flag's SCOPE, which the message names because this remedy now
    // reaches every log group rather than only retention-carrying ones.
    expect((err as Error).message).toMatch(/no per-resource granularity/i);
  });

  it('names it when only the DESIRED bag drops the retention (the recorded one still has it)', async () => {
    // The bag-selection case issue #2521 filed against this line: the guard
    // reads the RECORDED bag, so a template merely DROPPING the retention was
    // told `--replace` alone would do and was then refused. Unconditional
    // advice answers it without having to pick a bag.
    const err = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupClass: 'STANDARD', RetentionInDays: 7 }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/--replace --force-stateful-recreation/);
  });
});
