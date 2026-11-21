/**
 * go-to-k/cdkd#6655: a CloudWatch Logs log group's create REFUSES a name
 * another log group already holds, as CloudFormation does, instead of adopting
 * that group (which a later destroy then deleted). The raw
 * `ResourceAlreadyExistsException` stays on the cause chain so the collision
 * classifier sees it (a rollback re-create's delete-new-first). The one
 * exception is the holder the generated-name guard licensed from this stack's
 * own evidence, and only that holder.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

import { ResourceAlreadyExistsException } from '@aws-sdk/client-cloudwatch-logs';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import {
  logGroupCreateClient,
  resetCreateLogGroupLatchForTests,
} from '../../../src/provisioning/providers/logs-loggroup/own-replay.js';
import { markReplayMayCollide } from '../../../src/deployment/retryable-errors/name-collision.js';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { withLicensedNameHolder } from '../../../src/provisioning/licensed-name-holder.js';
import { isNameCollisionErrorFrom } from '../../../src/deployment/retryable-errors.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { provenNothingCreated } from '../../../src/deployment/generated-name-guard.js';

const TYPE = 'AWS::Logs::LogGroup';
const NAME = '/cdkd/App-Lg';
const PROPS = { LogGroupName: NAME, RetentionInDays: 7 };

/** The exception as the SDK raises it (us-east-1 wording). */
function taken(): ResourceAlreadyExistsException {
  return new ResourceAlreadyExistsException({
    message: 'The specified log group already exists',
    $metadata: { httpStatusCode: 400 },
  });
}

function sentCommands(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('create() did not throw');
}

describe('LogsLogGroupProvider.create on a taken name (go-to-k/cdkd#6655)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    resetCreateLogGroupLatchForTests();
    provider = new LogsLogGroupProvider();
  });

  it('refuses it with the raw exception as the cause, sends nothing more, and classifies as a name collision', async () => {
    const raw = taken();
    mockSend.mockRejectedValueOnce(raw);

    const error = await failure(() => provider.create('Lg', TYPE, PROPS));

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message).toContain('Failed to create log group Lg');
    expect(error.cause).toBe(raw);
    expect(sentCommands()).toEqual(['CreateLogGroupCommand']);
    expect(isNameCollisionErrorFrom(error, 'Lg')).toBe(true);
    // Nothing this create made is left behind for the rollback to delete.
    expect(createdBeforeFailure(error, 'Lg', TYPE)).toBeUndefined();
  });

  it('the refusal never proves nothing was created (it may meet a group an earlier attempt made)', async () => {
    // A 400 is otherwise a definite rejection; the collision keeps the
    // create-token ledger intent so the next deploy can take its own group back.
    mockSend.mockRejectedValueOnce(taken());

    const error = await failure(() => provider.create('Lg', TYPE, PROPS));

    expect(provenNothingCreated(error, 'Lg', TYPE)).toBe(false);
    // Control: a non-collision 400 still proves it.
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('bad retention'), {
        name: 'InvalidParameterException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const invalid = await failure(() => provider.create('Lg', TYPE, PROPS));
    expect(provenNothingCreated(invalid, 'Lg', TYPE)).toBe(true);
  });

  it('refuses it when the license names ANOTHER holder', async () => {
    mockSend.mockRejectedValueOnce(taken());

    const error = await failure(() =>
      withLicensedNameHolder('/cdkd/App-Other', () => provider.create('Lg', TYPE, PROPS))
    );

    expect(sentCommands()).toEqual(['CreateLogGroupCommand']);
    expect(isNameCollisionErrorFrom(error, 'Lg')).toBe(true);
  });

  it('refuses it when an inner scope licenses nothing (a nested create never reads an outer license)', async () => {
    mockSend.mockRejectedValueOnce(taken());

    const error = await failure(() =>
      withLicensedNameHolder(NAME, () =>
        withLicensedNameHolder(undefined, () => provider.create('Lg', TYPE, PROPS))
      )
    );

    expect(sentCommands()).toEqual(['CreateLogGroupCommand']);
    expect(isNameCollisionErrorFrom(error, 'Lg')).toBe(true);
  });

  it('takes back the licensed holder: configures it and returns it', async () => {
    mockSend.mockRejectedValueOnce(taken());
    mockSend.mockResolvedValueOnce({}); // PutRetentionPolicy

    const result = await withLicensedNameHolder(NAME, () => provider.create('Lg', TYPE, PROPS));

    expect(result.physicalId).toBe(NAME);
    expect(result.attributes?.['Arn']).toBe(`arn:aws:logs:us-east-1:123456789012:log-group:${NAME}:*`);
    // go-to-k/cdkd#6665: the identity read (unanswered here: the STS-built ARN).
    expect(sentCommands()).toEqual([
      'CreateLogGroupCommand',
      'PutRetentionPolicyCommand',
      'DescribeLogGroupsCommand',
    ]);
  });

  it('a free name creates as before', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateLogGroup
    mockSend.mockResolvedValueOnce({}); // PutRetentionPolicy

    const result = await provider.create('Lg', TYPE, PROPS);

    expect(result.physicalId).toBe(NAME);
    expect(sentCommands()).toEqual([
      'CreateLogGroupCommand',
      'PutRetentionPolicyCommand',
      'DescribeLogGroupsCommand',
    ]);
  });
});

describe('LogsLogGroupProvider.create meeting its OWN group after a lost answer (go-to-k/cdkd#6655)', () => {
  let provider: LogsLogGroupProvider;
  const serverError = () =>
    Object.assign(new Error('Service unavailable'), {
      name: 'ServiceUnavailableException',
      $fault: 'server',
      $metadata: { httpStatusCode: 503 },
    });
  const describedAt = (creationTime: number) => ({
    logGroups: [{ logGroupName: NAME, creationTime }],
  });

  beforeEach(() => {
    mockSend.mockReset();
    resetCreateLogGroupLatchForTests();
    provider = new LogsLogGroupProvider();
  });

  it('an ambiguous earlier attempt + a group created after its send: taken as this create\'s own', async () => {
    const firstSend = Date.now();
    mockSend.mockRejectedValueOnce(serverError()); // attempt 1: 503, outcome unknown
    await failure(() => provider.create('Lg', TYPE, PROPS));

    mockSend.mockRejectedValueOnce(taken()); // the engine's retry meets the group
    mockSend.mockResolvedValueOnce(describedAt(firstSend + 100)); // DescribeLogGroups
    mockSend.mockResolvedValueOnce({}); // PutRetentionPolicy
    const result = await provider.create('Lg', TYPE, PROPS);

    expect(result.physicalId).toBe(NAME);
    expect(sentCommands()).toEqual([
      'CreateLogGroupCommand',
      'CreateLogGroupCommand',
      'DescribeLogGroupsCommand',
      'PutRetentionPolicyCommand',
      'DescribeLogGroupsCommand',
    ]);
  });

  it('an ambiguous earlier attempt + a group OLDER than its send: refused (another owner\'s)', async () => {
    const firstSend = Date.now();
    mockSend.mockRejectedValueOnce(serverError());
    await failure(() => provider.create('Lg', TYPE, PROPS));

    mockSend.mockRejectedValueOnce(taken());
    mockSend.mockResolvedValueOnce(describedAt(firstSend - 60_000));
    const error = await failure(() => provider.create('Lg', TYPE, PROPS));

    expect(isNameCollisionErrorFrom(error, 'Lg')).toBe(true);
    expect(sentCommands()).not.toContain('PutRetentionPolicyCommand');
  });

  it("the SDK's replay inside one send after an ambiguous attempt (the stamp) + a group created since: taken as its own", async () => {
    mockSend.mockRejectedValueOnce(
      markReplayMayCollide(Object.assign(taken(), { $metadata: { httpStatusCode: 400, attempts: 2 } }))
    );
    mockSend.mockResolvedValueOnce(describedAt(Date.now()));
    mockSend.mockResolvedValueOnce({}); // PutRetentionPolicy
    const result = await provider.create('Lg', TYPE, PROPS);
    expect(result.physicalId).toBe(NAME);
  });

  it('a replay after a THROTTLE (attempts > 1, no stamp) proves nothing: refused unread, even with a group in the window', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(taken(), { $metadata: { httpStatusCode: 400, attempts: 2 } })
    );
    mockSend.mockResolvedValueOnce(describedAt(Date.now()));
    const error = await failure(() => provider.create('Lg', TYPE, PROPS));
    expect(isNameCollisionErrorFrom(error, 'Lg')).toBe(true);
    expect(sentCommands()).toEqual(['CreateLogGroupCommand']);
  });

  it('a creation time that cannot be read refuses', async () => {
    mockSend.mockRejectedValueOnce(
      markReplayMayCollide(Object.assign(taken(), { $metadata: { httpStatusCode: 400, attempts: 2 } }))
    );
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
    const error = await failure(() => provider.create('Lg', TYPE, PROPS));
    // Refused; the stamp keeps the classifier from crediting it to another
    // holder (#3978), so no delete-first acts on it either.
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isNameCollisionErrorFrom(error, 'Lg')).toBe(false);
    expect(sentCommands()).toEqual(['CreateLogGroupCommand', 'DescribeLogGroupsCommand']);
  });

  it('a non-ambiguous collision refuses without reading anything (no earlier attempt, one send)', async () => {
    mockSend.mockRejectedValueOnce(taken());
    await failure(() => provider.create('Lg', TYPE, PROPS));
    expect(sentCommands()).toEqual(['CreateLogGroupCommand']);
  });

  it('a definite earlier failure (a 400) arms nothing: the next collision refuses unread', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('bad'), {
        name: 'InvalidParameterException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    await failure(() => provider.create('Lg', TYPE, PROPS));
    mockSend.mockRejectedValueOnce(taken());
    await failure(() => provider.create('Lg', TYPE, PROPS));
    expect(sentCommands()).toEqual(['CreateLogGroupCommand', 'CreateLogGroupCommand']);
  });
});

describe('logGroupCreateClient (go-to-k/cdkd#6655)', () => {
  it('a real shared client gets a dedicated sibling in its region (memoized); a test double is used as is', async () => {
    const shared = new CloudWatchLogsClient({ region: 'eu-west-1' });
    const created = await logGroupCreateClient(shared);
    expect(created).toBeInstanceOf(CloudWatchLogsClient);
    expect(created).not.toBe(shared);
    expect(await created.config.region()).toBe('eu-west-1');
    expect(await logGroupCreateClient(shared)).toBe(created);
    const double = { send: vi.fn() } as unknown as CloudWatchLogsClient;
    expect(await logGroupCreateClient(double)).toBe(double);
    shared.destroy();
    created.destroy();
  });
});
