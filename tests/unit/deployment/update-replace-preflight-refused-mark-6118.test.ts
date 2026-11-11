/**
 * go-to-k/cdkd#6118: `updateByReplacement`'s pre-flight refusals run before
 * any delete or create, so they must carry `markRefusedBeforeApplying` --
 * otherwise the journal records a failed update and the deploy advises
 * `--revert-failed` for a resource nothing touched.
 */
import { describe, it, expect } from 'vite-plus/test';
import { refuseUnsafeReplacement } from '../../../src/deployment/deploy-engine/update-replace/preflight.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type {
  ResourceChange,
  ResourceState,
} from '../../../src/types/state.js';

function run(
  over: { recreateViaCcApi?: boolean; ccReason?: string },
  type = 'AWS::DynamoDB::Table',
): unknown {
  const engine = {
    options: {},
    stackRegion: 'us-east-1',
    providerRegistry: { ccRouteUnavailableReason: () => over.ccReason },
  } as unknown as DeployEngine;
  const change = {
    logicalId: 'T',
    changeType: 'UPDATE',
    propertyChanges: [{ path: 'KeySchema', requiresReplacement: true }],
  } as unknown as ResourceChange;
  try {
    refuseUnsafeReplacement(engine, {
      change,
      currentProps: { TableName: 'x' },
      currentResource: {
        physicalId: 'x',
        resourceType: type,
        properties: {},
      } as ResourceState,
      logicalId: 'T',
      oldResourceType: type,
      propertyDrivenReplacement: !over.recreateViaCcApi,
      recreateFlagged: false,
      recreateViaCcApi: over.recreateViaCcApi === true,
      resourceType: type,
      typeChanged: false,
      updateReplacePolicy: undefined,
    });
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('refuseUnsafeReplacement marks its refusals refused-before-applying (#6118)', () => {
  it('STATEFUL_REPLACE_BLOCKED carries the mark', () => {
    const e = run({}) as Error & { code?: string };
    expect(e.code).toBe('STATEFUL_REPLACE_BLOCKED');
    expect(isRefusedBeforeApplying(e, 'T')).toBe(true);
    expect(isMarkedNonRetryable(e)).toBe(true);
  });

  it('RECREATE_TARGETS_INVALID (no CC route) carries the mark', () => {
    const e = run({
      recreateViaCcApi: true,
      ccReason: 'no handlers',
    }) as Error & {
      code?: string;
    };
    expect(e.code).toBe('RECREATE_TARGETS_INVALID');
    expect(isRefusedBeforeApplying(e, 'T')).toBe(true);
    expect(isMarkedNonRetryable(e)).toBe(true);
  });

  it('RECREATE_TARGETS_INVALID (CC-broken type) carries the mark', () => {
    const e = run({ recreateViaCcApi: true }, 'AWS::Scheduler::Schedule') as Error & { code?: string };
    expect(e.code).toBe('RECREATE_TARGETS_INVALID');
    expect(isRefusedBeforeApplying(e, 'T')).toBe(true);
    expect(isMarkedNonRetryable(e)).toBe(true);
  });
});
