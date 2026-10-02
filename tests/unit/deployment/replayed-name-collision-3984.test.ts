import { describe, it, expect } from 'vite-plus/test';

import {
  isNameCollisionErrorFrom,
  isReplayedNameCollisionFrom,
  markReplayMayCollide,
} from '../../../src/deployment/retryable-errors.js';
import {
  auxiliaryLogicalId,
  isAuxiliaryMarkOf,
  markAuxiliaryFailure,
  RETRY_AUXILIARY_OWNER,
} from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { awsSdkError, ccAlreadyExistsError } from '../_aws-sdk-error.js';

/**
 * Issue #3984: the replayed-collision classifier the #2902 orphan advice reads.
 * It must say yes exactly where `isNameCollisionErrorFrom` withholds the verdict
 * for a replay, and never where the ordinary classifier would refuse for
 * another reason.
 */
const LOGICAL = 'Pipe';
const TYPE = 'AWS::Pipes::Pipe';
const seesRetryMark = (link: unknown): boolean => isAuxiliaryMarkOf(link, RETRY_AUXILIARY_OWNER);

/** A provider's wrapped collision, as `withRetry` settles it after an ambiguous attempt. */
function replayedCollision(): ProvisioningError {
  const error = new ProvisioningError(
    `Failed to create ${LOGICAL}: Role with name x already exists.`,
    TYPE,
    LOGICAL,
    'x',
    awsSdkError('Role with name x already exists.', 'EntityAlreadyExistsException')
  );
  return markReplayMayCollide(markAuxiliaryFailure(error, RETRY_AUXILIARY_OWNER));
}

describe('isReplayedNameCollisionFrom', () => {
  it('credits a replayed collision the ordinary classifier withholds', () => {
    const error = replayedCollision();

    expect(isNameCollisionErrorFrom(error, LOGICAL)).toBe(false);
    expect(isReplayedNameCollisionFrom(error, LOGICAL, seesRetryMark)).toBe(true);
  });

  it('needs the stamp: an unstamped collision is the ordinary classifier’s', () => {
    const error = new ProvisioningError(
      `Failed to create ${LOGICAL}: Role with name x already exists.`,
      TYPE,
      LOGICAL,
      'x',
      awsSdkError('Role with name x already exists.', 'EntityAlreadyExistsException')
    );

    expect(isReplayedNameCollisionFrom(error, LOGICAL, seesRetryMark)).toBe(false);
    expect(isNameCollisionErrorFrom(error, LOGICAL)).toBe(true);
  });

  it('sees through the retry mark only when the caller says so', () => {
    // Without the see-through, `withRetry`'s mark on the SDK link anchors the
    // walk to another resource and the collision under it is never read.
    expect(isReplayedNameCollisionFrom(replayedCollision(), LOGICAL, () => false)).toBe(false);
  });

  it('still refuses a PROVIDER auxiliary mark under the stamp', () => {
    const error = markReplayMayCollide(
      markAuxiliaryFailure(
        new ProvisioningError(
          `Failed to create ${LOGICAL}: Policy already exists.`,
          TYPE,
          LOGICAL,
          'x',
          awsSdkError('Policy already exists.', 'EntityAlreadyExistsException')
        ),
        LOGICAL
      )
    );

    expect(isReplayedNameCollisionFrom(error, LOGICAL, seesRetryMark)).toBe(false);
  });

  it('still refuses a link anchored to ANOTHER resource', () => {
    expect(isReplayedNameCollisionFrom(replayedCollision(), 'Other', seesRetryMark)).toBe(false);
  });

  it('refuses a stamped non-collision', () => {
    const error = markReplayMayCollide(
      new ProvisioningError(
        `Failed to create ${LOGICAL}: Member must satisfy constraint`,
        TYPE,
        LOGICAL,
        'x',
        awsSdkError('Member must satisfy constraint', 'ValidationException')
      )
    );

    expect(isReplayedNameCollisionFrom(error, LOGICAL, seesRetryMark)).toBe(false);
  });

  it('credits a stamped Cloud Control AlreadyExists (owner id, no cause)', () => {
    const error = markReplayMayCollide(ccAlreadyExistsError(`CREATE failed for ${LOGICAL}: taken`));

    expect(isNameCollisionErrorFrom(error, LOGICAL)).toBe(false);
    expect(isReplayedNameCollisionFrom(error, LOGICAL, seesRetryMark)).toBe(true);
  });
});

describe('isAuxiliaryMarkOf', () => {
  it('tells withRetry’s mark from a provider’s', () => {
    const retryMarked = markAuxiliaryFailure(new Error('a'), RETRY_AUXILIARY_OWNER);
    const providerMarked = markAuxiliaryFailure(new Error('b'), LOGICAL);

    expect(isAuxiliaryMarkOf(retryMarked, RETRY_AUXILIARY_OWNER)).toBe(true);
    expect(isAuxiliaryMarkOf(providerMarked, RETRY_AUXILIARY_OWNER)).toBe(false);
    expect(isAuxiliaryMarkOf(providerMarked, LOGICAL)).toBe(true);
  });

  it('requires the mark’s descriptor shape, not just its value', () => {
    // A ProvisioningError's logical-id slot is an ordinary assignment, so a
    // physical id spelled like the mark there is not the mark (go-to-k/cdkd#4222).
    const lookalike = new ProvisioningError(
      'x',
      TYPE,
      auxiliaryLogicalId(RETRY_AUXILIARY_OWNER),
      undefined
    );

    expect(isAuxiliaryMarkOf(lookalike, RETRY_AUXILIARY_OWNER)).toBe(false);
  });

  it('reads the link itself, not its cause', () => {
    const wrapper = new ProvisioningError(
      'x',
      TYPE,
      LOGICAL,
      undefined,
      markAuxiliaryFailure(new Error('a'), RETRY_AUXILIARY_OWNER)
    );

    expect(isAuxiliaryMarkOf(wrapper, RETRY_AUXILIARY_OWNER)).toBe(false);
  });

  it('never throws, and is false for primitives', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      }
    );

    expect(isAuxiliaryMarkOf(hostile, RETRY_AUXILIARY_OWNER)).toBe(false);
    expect(isAuxiliaryMarkOf(null, RETRY_AUXILIARY_OWNER)).toBe(false);
    expect(isAuxiliaryMarkOf('withRetry/auxiliary', RETRY_AUXILIARY_OWNER)).toBe(false);
  });
});
