/**
 * Issue [#2603](https://github.com/go-to-k/cdkd/issues/2603): the replacement
 * rollback used to re-derive "was the old resource retained?" from
 * `previousState.updateReplacePolicy`, while every engine path that DECIDES it
 * reads `UpdateReplacePolicy` off the TEMPLATE being applied. The two answers
 * differ on exactly the deploy that CHANGES the attribute, in both directions,
 * so `CompletedOperation.oldResourceRetained` now carries the verdict the
 * engine acted on and the classifier consults that.
 *
 * The cases below are written as a 2x3 matrix — recorded verdict (`true` /
 * `false` / absent) against previous-state policy (`Retain` / not) — because
 * the whole defect lives in the CELLS WHERE THE TWO DISAGREE. A test that only
 * exercised the agreeing cells would pass against the pre-fix code.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  classifyRollbackOp,
  type CompletedOperation,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

/**
 * A completed REPLACEMENT op: the previous record names `phys-old`, the op
 * recorded `phys-new`, and the state map still points at `phys-new` (nothing
 * has reverted it yet). Every earlier guard in the classifier — physical-id
 * mismatch, already-reverted, orphan flag — is therefore passed, so the ONLY
 * thing deciding the verdict is the retain read this file is about.
 */
function replacementOp(
  overrides: {
    oldResourceRetained?: boolean;
    previousPolicy?: ResourceState['updateReplacePolicy'];
  } = {}
): CompletedOperation {
  return {
    logicalId: 'B',
    changeType: 'UPDATE',
    resourceType: 'AWS::S3::Bucket',
    physicalId: 'phys-new',
    previousState: res({
      physicalId: 'phys-old',
      properties: { a: 1 },
      ...(overrides.previousPolicy !== undefined && {
        updateReplacePolicy: overrides.previousPolicy,
      }),
    }),
    ...(overrides.oldResourceRetained !== undefined && {
      oldResourceRetained: overrides.oldResourceRetained,
    }),
  };
}

const currentState = { B: res({ physicalId: 'phys-new', properties: { a: 2 } }) };

describe('classifyRollbackOp reads the retain verdict the DEPLOY acted on (issue #2603)', () => {
  describe('the two disagreeing cells — the whole point of the change', () => {
    it('ADD direction: recorded retained=true with NO policy on the previous record → readopt', () => {
      // The deploy's template newly declared `UpdateReplacePolicy: Retain`, so
      // the old resource is alive and orphaned — but the PREVIOUS state record
      // predates the attribute and carries nothing. Pre-fix this classified as
      // plain `reverse-replacement` and the rollback RE-CREATED a resource
      // that was still running (a duplicate for an auto-named type, an
      // `AlreadyExists` failure for a user-named one).
      expect(
        classifyRollbackOp(replacementOp({ oldResourceRetained: true }), currentState, new Set())
      ).toBe('reverse-replacement-readopt');
    });

    it('DROP direction: recorded retained=false with a STALE Retain on the previous record → re-create', () => {
      // The previous deploy persisted `Retain`; the current template omits it,
      // so the engine correctly DELETED the old resource. Pre-fix the stale
      // policy made this `reverse-replacement-readopt`, which points state at
      // `phys-old` with NO re-create — leaving the stack describing a resource
      // that does not exist, and nothing downstream detects it as absent.
      expect(
        classifyRollbackOp(
          replacementOp({ oldResourceRetained: false, previousPolicy: 'Retain' }),
          currentState,
          new Set()
        )
      ).toBe('reverse-replacement');
    });
  });

  describe('the agreeing cells stay where they were', () => {
    it('retained=true and the previous record also says Retain → readopt', () => {
      expect(
        classifyRollbackOp(
          replacementOp({ oldResourceRetained: true, previousPolicy: 'Retain' }),
          currentState,
          new Set()
        )
      ).toBe('reverse-replacement-readopt');
    });

    it('retained=false and the previous record has no policy → re-create', () => {
      expect(
        classifyRollbackOp(replacementOp({ oldResourceRetained: false }), currentState, new Set())
      ).toBe('reverse-replacement');
    });

    it('`Snapshot` is not retention on either source — recorded false, previous Snapshot → re-create', () => {
      expect(
        classifyRollbackOp(
          replacementOp({ oldResourceRetained: false, previousPolicy: 'Snapshot' }),
          currentState,
          new Set()
        )
      ).toBe('reverse-replacement');
    });
  });

  describe('a journal written by a pre-#2603 binary keeps the old read', () => {
    // The ONLY case the previous-state fallback still serves: those ops carry
    // no verdict at all, so the stale read is the only information that
    // exists. `??` rather than `||` is what keeps this arm from swallowing the
    // DROP direction's explicit `false` above.
    it('absent verdict + previous Retain → readopt (unchanged from pre-#2603)', () => {
      expect(
        classifyRollbackOp(replacementOp({ previousPolicy: 'Retain' }), currentState, new Set())
      ).toBe('reverse-replacement-readopt');
    });

    it('absent verdict + no previous policy → re-create (unchanged from pre-#2603)', () => {
      expect(classifyRollbackOp(replacementOp(), currentState, new Set())).toBe(
        'reverse-replacement'
      );
    });
  });

  it('the recorded verdict does NOT override the earlier already-reverted guard', () => {
    // Scoping: `oldResourceRetained` decides between the two REPLACEMENT arms
    // and nothing else. State already pointing at `phys-old` means a prior
    // replay (or a manual fix) reverted this op, and a `true` here must not
    // resurrect it into a second readopt that deletes a resource twice.
    const state = { B: res({ physicalId: 'phys-old', properties: { a: 1 } }) };
    expect(
      classifyRollbackOp(replacementOp({ oldResourceRetained: true }), state, new Set())
    ).toBe('skip-already-done');
  });
});
