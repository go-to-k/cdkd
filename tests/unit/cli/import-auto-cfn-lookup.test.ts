import { describe, it, expect, vi } from 'vite-plus/test';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() }),
  }),
}));

/**
 * Issue #1128: auto mode asks CloudFormation for physical IDs before falling
 * back to the per-provider lookups.
 *
 * Why the lookup exists at all: auto mode's per-resource fallback is an
 * `aws:cdk:path` tag walk, and that tag CANNOT be present on an AWS resource —
 * AWS rejects any `aws:`-prefixed tag write, and CloudFormation keeps the value
 * in the template's resource `Metadata` without promoting it to a tag. So a
 * resource whose physical name CloudFormation generated (the usual CDK shape)
 * came back `not found` even though it was importable.
 *
 * These tests pin the two properties that make the lookup safe to run
 * speculatively on EVERY auto-mode import:
 *   - a missing stack returns `null` (the normal case for a cdkd-native stack)
 *     rather than aborting the import;
 *   - NO failure is fatal. The lookup is an optimization; when it cannot
 *     answer, the caller falls through to the per-provider lookups, which is
 *     exactly the pre-#1128 behavior. Throwing would turn a missed improvement
 *     into a hard failure for the users least likely to benefit — an operator
 *     whose IAM policy has no `cloudformation:*` would see `AccessDenied` abort
 *     an import of a cdkd-native stack that worked the day before. Both PR
 *     reviewers flagged that regression.
 *   - a non-not-found failure still WARNS, so the degraded resolution is
 *     visible rather than silent.
 */

import {
  tryGetCloudFormationResourceMap,
  isStackNotFoundError,
} from '../../../src/cli/commands/retire-cfn-stack.js';

/** CloudFormation's shape for "no such stack" — a ValidationError, no dedicated type. */
function stackNotFound(stackName: string): Error {
  const err = new Error(`Stack with id ${stackName} does not exist`) as Error & { name: string };
  err.name = 'ValidationError';
  return err;
}

function fakeClient(impl: () => Promise<unknown>) {
  return { send: vi.fn(impl) } as never;
}

describe('isStackNotFoundError', () => {
  it('recognizes the CloudFormation not-found shape', () => {
    expect(isStackNotFoundError(stackNotFound('MyStack'))).toBe(true);
  });

  it.each([
    ['a different ValidationError', 'ValidationError', '1 validation error detected: bad name'],
    ['a throttle', 'ThrottlingException', 'Rate exceeded'],
    ['an authz failure', 'AccessDenied', 'not authorized to perform'],
  ])('does not swallow %s', (_label, name, message) => {
    const err = new Error(message) as Error & { name: string };
    err.name = name;
    expect(isStackNotFoundError(err)).toBe(false);
  });

  it('tolerates non-error inputs', () => {
    expect(isStackNotFoundError(undefined)).toBe(false);
    expect(isStackNotFoundError('nope')).toBe(false);
  });
});

describe('tryGetCloudFormationResourceMap', () => {
  it('returns the logicalId -> physicalId map', async () => {
    const client = fakeClient(async () => ({
      StackResources: [
        { LogicalResourceId: 'Policy', PhysicalResourceId: 'arn:aws:iam::1:policy/P' },
        { LogicalResourceId: 'Bucket', PhysicalResourceId: 'my-bucket' },
      ],
    }));

    const map = await tryGetCloudFormationResourceMap('MyStack', client);
    expect(map).toEqual(
      new Map([
        ['Policy', 'arn:aws:iam::1:policy/P'],
        ['Bucket', 'my-bucket'],
      ])
    );
  });

  it('returns null when the stack does not exist', async () => {
    const client = fakeClient(async () => {
      throw stackNotFound('MyStack');
    });

    // The normal case for a cdkd-native stack: no CFn counterpart, so the
    // import must fall through to the per-provider lookups, not abort.
    expect(await tryGetCloudFormationResourceMap('MyStack', client)).toBeNull();
  });

  it.each([
    ['throttling', 'ThrottlingException', 'Rate exceeded'],
    ['authz', 'AccessDeniedException', 'not authorized to perform'],
  ])('falls through with a WARN on %s instead of aborting', async (_label, name, message) => {
    // Regression guard: an earlier cut rethrew here, which would abort an
    // import of a cdkd-native stack for any caller lacking
    // cloudformation:DescribeStackResources — a stack that never needed the
    // lookup in the first place.
    warnSpy.mockReset();
    const err = new Error(message) as Error & { name: string };
    err.name = name;
    const client = fakeClient(async () => {
      throw err;
    });

    expect(await tryGetCloudFormationResourceMap('MyStack', client)).toBeNull();
    // ...but not silently: the user must learn why ids were not resolved.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain(message);
    expect(warnSpy.mock.calls[0]![0]).toContain('cloudformation:DescribeStackResources');
  });

  it('does NOT warn when the stack simply does not exist', async () => {
    // The common case for a cdkd-native stack — warning here would be noise on
    // every single import.
    warnSpy.mockReset();
    const client = fakeClient(async () => {
      throw stackNotFound('MyStack');
    });

    expect(await tryGetCloudFormationResourceMap('MyStack', client)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips rows missing either id', async () => {
    const client = fakeClient(async () => ({
      StackResources: [
        { LogicalResourceId: 'Good', PhysicalResourceId: 'p-1' },
        { LogicalResourceId: 'NoPhysical' },
        { PhysicalResourceId: 'no-logical' },
      ],
    }));

    expect(await tryGetCloudFormationResourceMap('MyStack', client)).toEqual(
      new Map([['Good', 'p-1']])
    );
  });

  it('returns an empty map for a stack with no resources', async () => {
    const client = fakeClient(async () => ({}));
    expect(await tryGetCloudFormationResourceMap('MyStack', client)).toEqual(new Map());
  });
});
