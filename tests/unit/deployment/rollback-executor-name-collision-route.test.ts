/**
 * The reverse-replacement arm reaches its delete-new-first fallback on a
 * collision cdkd can only see from the ERROR (issue
 * https://github.com/go-to-k/cdkd/issues/3208).
 *
 * Review of that change found the rollback consumer covered only by a
 * SOURCE-SHAPE string anchor in `rollback-executor-log-injection.test.ts` —
 * nothing fed a NAME-only failure through `replayRollback` and observed what
 * the executor did with it, and the integ exercises only the forward
 * `--replace` path. This file is that behavioural half.
 *
 * Why it matters more here than on the deploy side: this arm DELETES the live
 * NEW resource and drops its state entry before re-creating the old one. A
 * predicate that cannot see the collision leaves the op failing with both
 * resources intact (the pre-#3208 behaviour); one that sees it too eagerly
 * destroys a resource. Both directions are pinned.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/** VERBATIM, measured us-east-1 2026-09-16. Carries no code and no "already exists". */
const ELBV2_MESSAGE =
  "A target group with the same name 'CdkdX-Tg' exists, but with different settings";
const ELBV2_NAME = 'DuplicateTargetGroupNameException';
const TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function reverseReplacementOp(): CompletedOperation {
  return {
    logicalId: 'Tg',
    changeType: 'UPDATE',
    resourceType: TYPE,
    physicalId: 'arn-new',
    previousState: res({ physicalId: 'arn-old', resourceType: TYPE }),
  };
}

function makeCtx(provider: { delete?: unknown; create?: unknown }): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
}

/** Throws the SDK shape: the NAME states the collision, the message does not. */
function nameOnlyCollision(): Error {
  const e = new Error(ELBV2_MESSAGE);
  e.name = ELBV2_NAME;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the reverse-replacement arm routes a NAME-only collision to delete-new-first (#3208)', () => {
  it('deletes the new resource, then re-creates the old one', () => {
    const calls: string[] = [];
    let seen = 0;
    const create = vi.fn(async () => {
      calls.push('create');
      // The create-first attempt fails the way ELBv2 really does.
      if (seen++ === 0) throw nameOnlyCollision();
      return { physicalId: 'arn-restored', attributes: {} };
    });
    const del = vi.fn(async () => {
      calls.push('delete');
      return undefined;
    });
    const ctx = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Tg: res({ physicalId: 'arn-new' }) };

    return replayRollback([reverseReplacementOp()], state, 'CdkdX', ctx).then((result) => {
      expect(result.failures).toBe(0);
      // THE DISCRIMINATOR. Before #3208 the predicate could not see this
      // collision, so the `if (!nameCollision) throw createError` guard rethrew
      // and the op FAILED after a single create, with no delete at all.
      expect(calls).toEqual(['create', 'delete', 'create']);
      expect(state['Tg']?.physicalId).toBe('arn-restored');
    });
  });

  it('a failure that is NOT a collision still fails the op without deleting anything', () => {
    // The inverse, and the one that matters for blast radius: this arm must not
    // start deleting live resources on every create failure.
    const create = vi.fn(async () => {
      // Terminal on purpose: an authorization message would hit the
      // IAM-propagation patterns and spin the dense retry schedule with real
      // sleeps (measured: the case timed out at 5s), which would make this
      // assert nothing about the collision predicate.
      throw new Error('ValidationError: Port must be an integer between 1 and 65535');
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Tg: res({ physicalId: 'arn-new' }) };

    return replayRollback([reverseReplacementOp()], state, 'CdkdX', ctx).then((result) => {
      expect(result.failures).toBe(1);
      expect(del).not.toHaveBeenCalled();
      // The new resource is still recorded — nothing was destroyed.
      expect(state['Tg']?.physicalId).toBe('arn-new');
    });
  });

  it('a collision naming ANOTHER resource does not reach the destructive fallback', () => {
    // The anchor, from the rollback side. A child resource's collision arriving
    // on the parent's chain must not delete the parent's new resource.
    const create = vi.fn(async () => {
      const child = Object.assign(nameOnlyCollision(), { logicalId: 'SomeOtherResource' });
      throw new Error('Failed to create resource SomeOtherResource', { cause: child });
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Tg: res({ physicalId: 'arn-new' }) };

    return replayRollback([reverseReplacementOp()], state, 'CdkdX', ctx).then((result) => {
      expect(result.failures).toBe(1);
      expect(del).not.toHaveBeenCalled();
      expect(state['Tg']?.physicalId).toBe('arn-new');
    });
  });
});

describe('a cdkd refusal quoting a template value does not reach delete-new-first (#3816)', () => {
  it('fails the op without deleting the new resource', () => {
    // A provider refusal naming THIS resource whose message interpolates a
    // property value carrying the phrase. It has no AWS `$metadata` link, so it
    // is not a collision; before #3816 the depth-0 prose read deleted the live
    // NEW resource here and re-created into the same refusal.
    const create = vi.fn(async () => {
      throw Object.assign(
        new Error('Tg HealthCheckPath must start with "/", got "x already exists" — cdkd refuses'),
        { logicalId: 'Tg' }
      );
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Tg: res({ physicalId: 'arn-new' }) };

    return replayRollback([reverseReplacementOp()], state, 'CdkdX', ctx).then((result) => {
      expect(result.failures).toBe(1);
      expect(del).not.toHaveBeenCalled();
      expect(state['Tg']?.physicalId).toBe('arn-new');
    });
  });
});
