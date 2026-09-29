import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #3978 through the REAL Cloud Control provider: `CreateResource` is
 * sent with no `ClientToken`, so a replay after a 5xx that materialized the
 * resource is a NEW request, and its handler reports `AlreadyExists` as a
 * `CloudControlOperationFailedError` carrying the owner's logical id and no
 * `cause`. The auxiliary mark has no link to land on there, so only the
 * replay stamp keeps the verdict false. Found by the review of PR #3983.
 */

const mockCloudControlSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    // DescribeType for the write-only / read-only property lookups: an
    // unanswered lookup degrades to "no such properties".
    cloudFormation: { send: () => Promise.reject(new Error('DescribeType unavailable')) },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

import { withRetry } from '../../../src/deployment/retry.js';
import { isNameCollisionErrorFrom } from '../../../src/deployment/retryable-errors.js';
import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

const LOGICAL_ID = 'Canary';
const TYPE = 'AWS::Synthetics::Canary';
const NAME = 'cdkd-canary';

/** A smithy server fault, as in the Kinesis sibling file. */
function serverFault(status: number, name: string): Error {
  const error = new Error('UnknownError');
  error.name = name;
  Object.assign(error, {
    $fault: 'server',
    $metadata: { httpStatusCode: status, requestId: 'req-5xx', attempts: 3 },
  });
  return error;
}

/**
 * `'collide'`: the create is accepted and its handler reports `AlreadyExists`.
 * `{ failed }`: accepted, and the handler reports that code with NO
 * `Identifier`, so `cleanupFailedCreateRemnant` has nothing to delete -- the
 * shape where a materialized resource survives into the replay.
 * An `Error`: `CreateResource` itself rejects.
 */
type Outcome = 'collide' | { failed: string; message: string } | Error;

/** `outcomes[i]` is what the i-th `CreateResource` does. Returns the command log. */
function wire(outcomes: Outcome[]): string[] {
  const sent: string[] = [];
  let creates = 0;
  const byToken = new Map<string, Outcome>();
  mockCloudControlSend.mockImplementation(
    (cmd: { constructor: { name: string }; input?: { RequestToken?: string } }) => {
      const name = cmd.constructor.name;
      sent.push(name);
      if (name === 'CreateResourceCommand') {
        const outcome = outcomes[creates++] ?? 'collide';
        if (outcome instanceof Error) return Promise.reject(outcome);
        byToken.set(`tok-${creates}`, outcome);
        return Promise.resolve({ ProgressEvent: { RequestToken: `tok-${creates}` } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        const outcome = byToken.get(cmd.input?.RequestToken ?? '');
        if (outcome !== undefined && outcome !== 'collide' && !(outcome instanceof Error)) {
          return Promise.resolve({
            ProgressEvent: {
              OperationStatus: 'FAILED',
              TypeName: TYPE,
              ErrorCode: outcome.failed,
              StatusMessage: outcome.message,
            },
          });
        }
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'FAILED',
            TypeName: TYPE,
            Identifier: NAME,
            ErrorCode: 'AlreadyExists',
            StatusMessage: `Resource of type '${TYPE}' with identifier '${NAME}' already exists.`,
          },
        });
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    }
  );
  return sent;
}

const noSleep = (): Promise<void> => Promise.resolve();

async function createThroughRetry(provider: CloudControlProvider): Promise<unknown> {
  return withRetry(() => provider.create(LOGICAL_ID, TYPE, { Name: NAME }), LOGICAL_ID, {
    sleep: noSleep,
  }).then(
    () => undefined,
    (e: unknown) => e
  );
}

const creates = (sent: string[]): number => sent.filter((c) => c === 'CreateResourceCommand').length;

beforeEach(() => {
  mockCloudControlSend.mockReset();
});

describe('a Cloud Control create replayed after an ambiguous 5xx (#3978)', () => {
  it('is not credited as the resource name collision', async () => {
    const sent = wire([serverFault(500, 'InternalFailure'), 'collide']);
    const error = await createThroughRetry(new CloudControlProvider());

    expect(creates(sent)).toBe(2);
    // The shape the review found: the replay's own handler verdict, carrying
    // the owner id and the AlreadyExists code the classifier credits.
    expect(error).toMatchObject({ logicalId: LOGICAL_ID, ccErrorCode: 'AlreadyExists' });
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('a handler Throttling after the create was accepted is not credited either', async () => {
    // The handler reports its throttle from INSIDE the create, possibly after
    // materializing; no Identifier, so no remnant cleanup runs. "Rate
    // exceeded" is what makes the default classifier replay it.
    const sent = wire([{ failed: 'Throttling', message: 'Rate exceeded' }, 'collide']);
    const error = await createThroughRetry(new CloudControlProvider());

    expect(creates(sent)).toBe(2);
    expect(sent.filter((c) => c === 'DeleteResourceCommand')).toHaveLength(0);
    expect(error).toMatchObject({ logicalId: LOGICAL_ID, ccErrorCode: 'AlreadyExists' });
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('a handler GeneralServiceException after the create was accepted is not credited', async () => {
    // GeneralServiceException's message decides replay; this one is transient.
    const sent = wire([
      { failed: 'GeneralServiceException', message: 'Rate exceeded' },
      'collide',
    ]);
    const error = await createThroughRetry(new CloudControlProvider());

    expect(creates(sent)).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('a genuine first-attempt AlreadyExists still classifies (negative control)', async () => {
    const sent = wire(['collide']);
    const error = await createThroughRetry(new CloudControlProvider());

    expect(creates(sent)).toBe(1);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });

  it('a throttled first attempt leaves the collision credited (negative control)', async () => {
    const throttle = new Error('Rate exceeded');
    throttle.name = 'ThrottlingException';
    Object.assign(throttle, { $metadata: { httpStatusCode: 400 } });
    const sent = wire([throttle, 'collide']);
    const error = await createThroughRetry(new CloudControlProvider());

    expect(creates(sent)).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });
});
