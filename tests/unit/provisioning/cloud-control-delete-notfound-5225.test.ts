/**
 * Issue go-to-k/cdkd#5225: `deleteThroughCloudControl`'s already-deleted arm
 * reads only TYPED not-found signals, and a failure it keeps is not dropped
 * one level up.
 *
 * Before the fix the arm also matched `does not exist` / `not found` /
 * `NotFound` anywhere in the message. A `TypeNotFoundException`, a FAILED
 * delete whose handler `StatusMessage` names a missing DEPENDENCY, and a
 * logical id such as `PageNotFound` all satisfied it, and `delete()` returned
 * success over a live resource, so its state record was dropped.
 *
 * The downstream classifiers (`deploy-engine/delete.ts`,
 * `deploy-engine/update-in-place.ts`, `destroy-runner.ts`) match the same
 * phrases in the THROWN message, behind an `isMarkedNotGone` guard (#5228). So
 * a kept failure whose message holds one is asserted MARKED not gone, and one
 * without a phrase unmarked. Retryability is left to the retry classifiers
 * either way: a transient failure that holds a phrase keeps its retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockCloudControlConfigRegion = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: mockCloudControlConfigRegion },
    },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => child,
  };
  return { getLogger: () => child };
});

import {
  CloudControlProvider,
  CloudControlOperationFailedError,
} from '../../../src/provisioning/cloud-control-provider.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';

const TYPE = 'AWS::SQS::Queue';
const REGION = 'us-east-1';

function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

/** `DeleteResource` itself rejects with `error`. */
function wireSyncReject(error: unknown): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) =>
    cmd.constructor.name === 'DeleteResourceCommand' ? Promise.reject(error) : Promise.resolve({})
  );
}

/** `DeleteResource` is accepted; the first status poll reports FAILED. */
function wireAsyncFailed(errorCode: string | undefined, statusMessage: string): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'DeleteResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-5225' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({
        ProgressEvent: {
          OperationStatus: 'FAILED',
          TypeName: TYPE,
          ErrorCode: errorCode,
          StatusMessage: statusMessage,
        },
      });
    }
    return Promise.resolve({});
  });
}

describe('CloudControlProvider delete: only typed not-found reads as gone (issue #5225)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockCloudControlConfigRegion.mockReset();
    mockCloudControlConfigRegion.mockResolvedValue(REGION);
    provider = new CloudControlProvider();
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
  });

  async function deleteOutcome(logicalId = 'Queue'): Promise<unknown> {
    return provider
      .delete(logicalId, 'my-queue', TYPE, {}, { expectedRegion: REGION })
      .then(
        (value) => ({ resolved: value }),
        (e: unknown) => e
      );
  }

  describe('kept: the record survives, and the downstream classifiers are fenced off', () => {
    it('a TypeNotFoundException from DeleteResource is not gone, whatever its text', async () => {
      wireSyncReject(awsError('TypeNotFoundException', `The type ${TYPE} does not exist or is not found`));

      const error = await deleteOutcome();

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('is not supported by Cloud Control API');
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    it.each([
      ['GeneralServiceException', 'Subnet subnet-0abc not found (Service: Ec2, Status Code: 400)'],
      ['InvalidRequest', 'The KMS key alias/app does not exist'],
      ['NotStabilized', 'Dependency NotFoundException from a downstream call'],
      [undefined, 'Referenced role was not found'],
      // One row per remaining downstream phrase, each spelling no other.
      ['GeneralServiceException', 'NoSuchEntity: The role app-role cannot be found'],
      ['InvalidRequest', 'No policy found for the referenced bucket'],
    ])(
      'a FAILED delete with ErrorCode %s and StatusMessage %j is not gone',
      async (code, statusMessage) => {
        wireAsyncFailed(code, statusMessage);

        const error = await deleteOutcome();

        expect(error).toBeInstanceOf(CloudControlOperationFailedError);
        expect((error as CloudControlOperationFailedError).ccErrorCode).toBe(code);
        expect(isMarkedNotGone(error)).toBe(true);
        expect(isMarkedNonRetryable(error)).toBe(false);
      }
    );

    it('an untyped error whose prose says "does not exist" is not gone', async () => {
      wireSyncReject(new Error('Queue does not exist'));

      const error = await deleteOutcome();

      expect(error).toBeInstanceOf(Error);
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    it('a cdkd-authored failure for a logical id spelling `NotFound` is not gone', async () => {
      // DeleteResource answered without a RequestToken: cdkd's own
      // ProvisioningError, whose message interpolates the logical id.
      mockCloudControlSend.mockResolvedValue({ ProgressEvent: {} });

      const error = await deleteOutcome('PageNotFound');

      expect((error as Error).message).toContain('No request token received');
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    it('an ordinary FAILED delete with a not-found logical id is not gone either', async () => {
      wireAsyncFailed('GeneralServiceException', 'internal failure');

      const error = await deleteOutcome('ErrorPageNotFound');

      expect(error).toBeInstanceOf(CloudControlOperationFailedError);
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
    });
  });

  describe('negative controls', () => {
    it('a ResourceNotFoundException from DeleteResource is still gone', async () => {
      wireSyncReject(awsError('ResourceNotFoundException', 'Resource not found'));

      await expect(deleteOutcome()).resolves.toEqual({ resolved: undefined });
    });

    it('a FAILED delete with handler ErrorCode NotFound is still gone, whatever its text', async () => {
      wireAsyncFailed('NotFound', 'No Deployment Group found for name: dg');

      await expect(deleteOutcome()).resolves.toEqual({ resolved: undefined });
    });

    it('a throttle for a logical id spelling `NotFound` is marked not gone AND keeps its retry', async () => {
      wireSyncReject(awsError('ThrottlingException', 'Rate exceeded'));

      const error = await deleteOutcome('PageNotFound');

      expect((error as Error).message).toContain('PageNotFound');
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(isRetryableTransientError(error, (error as Error).message)).toBe(true);
    });

    it('a message-pattern transient for a logical id spelling `NotFound` keeps its retry too', async () => {
      wireAsyncFailed('GeneralServiceException', 'DependencyViolation: the group has a dependent object');

      const error = await deleteOutcome('PageNotFound');

      expect(error).toBeInstanceOf(CloudControlOperationFailedError);
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(isRetryableTransientError(error, (error as Error).message)).toBe(true);
    });

    it('an IAM-propagation `PrincipalNotFound` is marked not gone AND keeps its retry', async () => {
      // The retry table's `Policy Error: PrincipalNotFound` pattern spells a
      // `NotFound`: the race clears with time, so it must keep its retry.
      wireAsyncFailed('InvalidRequest', 'Policy Error: PrincipalNotFound for role app-role');

      const error = await deleteOutcome();

      expect(error).toBeInstanceOf(CloudControlOperationFailedError);
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(isRetryableTransientError(error, (error as Error).message)).toBe(true);
    });

    it('a kept failure WITHOUT a not-found phrase is left unmarked, so it stays retryable', async () => {
      wireSyncReject(awsError('ThrottlingException', 'Rate exceeded'));

      const error = await deleteOutcome();

      expect(error).toBeInstanceOf(Error);
      expect(isMarkedNotGone(error)).toBe(false);
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(isRetryableTransientError(error, (error as Error).message)).toBe(true);
    });
  });
});
