import { describe, it, expect, vi } from 'vite-plus/test';

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
 *   - any OTHER failure still throws, because swallowing a throttle or an
 *     AccessDenied would degrade into the same silent not-found this fix
 *     removes.
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
  ])('rethrows on %s rather than reporting no stack', async (_label, name, message) => {
    // Swallowing these would silently skip the CFn lookup and send the import
    // back to the tag walk that cannot match — the exact silent not-found this
    // change removes.
    const err = new Error(message) as Error & { name: string };
    err.name = name;
    const client = fakeClient(async () => {
      throw err;
    });

    await expect(tryGetCloudFormationResourceMap('MyStack', client)).rejects.toThrow(message);
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
