import { describe, it, expect } from 'vite-plus/test';
import {
  pendingMovesOutOf,
  hasPendingMovesOut,
  pendingMovesRefusalMessage,
  refusePendingMovesOut,
} from '../../../src/state/pending-moves.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { StackState } from '../../../src/types/state.js';

const REGION = 'us-east-1';
const STACK = 'S';

const VALID = { from: 'Old', toStack: 'D', toRegion: REGION, to: 'New', startedAt: 1 };

function stateWith(pendingMovesOut: unknown): Pick<StackState, 'pendingMovesOut'> {
  return { pendingMovesOut } as Pick<StackState, 'pendingMovesOut'>;
}

describe('pendingMovesOutOf', () => {
  it('undefined reads as no moves, not malformed', () => {
    expect(pendingMovesOutOf(stateWith(undefined))).toEqual({ moves: [], malformed: false });
  });

  for (const [label, raw] of [
    ['a string', 'abc'],
    ['an object', { a: 1 }],
    ['a number', 5],
  ] as const) {
    it(`a non-array (${label}) reads as malformed`, () => {
      const { moves, malformed } = pendingMovesOutOf(stateWith(raw));
      expect(moves).toEqual([]);
      expect(malformed).toBe(true);
    });
  }

  it('an array mixing a valid entry with a null entry, a missing-field entry and a numeric-from entry', () => {
    const missingTo = { from: 'Old2', toStack: 'D', toRegion: REGION, startedAt: 1 };
    const numericFrom = { from: 7, toStack: 'D', toRegion: REGION, to: 'New2', startedAt: 1 };
    const { moves, malformed } = pendingMovesOutOf(stateWith([VALID, null, missingTo, numericFrom]));
    expect(moves).toEqual([VALID]);
    expect(malformed).toBe(true);
  });
});

describe('hasPendingMovesOut', () => {
  it('false for undefined', () => {
    expect(hasPendingMovesOut(stateWith(undefined))).toBe(false);
  });

  it('false for an empty array', () => {
    expect(hasPendingMovesOut(stateWith([]))).toBe(false);
  });

  it('true for a malformed-only field', () => {
    expect(hasPendingMovesOut(stateWith('abc'))).toBe(true);
  });

  it('true for a valid entry', () => {
    expect(hasPendingMovesOut(stateWith([VALID]))).toBe(true);
  });
});

describe('refusePendingMovesOut', () => {
  it('is a no-op when there are no pending moves', () => {
    expect(() => refusePendingMovesOut(stateWith(undefined), STACK, REGION, 'cdkd deploy')).not.toThrow();
    expect(() => refusePendingMovesOut(stateWith([]), STACK, REGION, 'cdkd deploy')).not.toThrow();
  });

  it('throws a CdkdError with code REFACTOR_UNFINISHED, naming the refused command/stack/region, the move and the remedy', () => {
    let thrown: unknown;
    try {
      refusePendingMovesOut(stateWith([VALID]), STACK, REGION, 'cdkd deploy');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CdkdError);
    const err = thrown as CdkdError;
    expect(err.code).toBe('REFACTOR_UNFINISHED');
    expect(err.message).toContain(`cdkd deploy refused stack ${STACK} (${REGION})`);
    expect(err.message).toContain('Old -> D.New');
    expect(err.message).toContain("'cdkd refactor S'");
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('names a malformed field as "a move this binary cannot read"', () => {
    let thrown: unknown;
    try {
      refusePendingMovesOut(stateWith('garbage'), STACK, REGION, 'cdkd destroy');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CdkdError);
    const err = thrown as CdkdError;
    expect(err.code).toBe('REFACTOR_UNFINISHED');
    expect(err.message).toContain('a move this binary cannot read');
    expect(err.message).toContain(`cdkd destroy refused stack ${STACK} (${REGION})`);
  });
});

describe('pendingMovesRefusalMessage', () => {
  it('lists every valid move, joined, and names the remedy command', () => {
    const second = { from: 'Old2', toStack: 'D2', toRegion: REGION, to: 'New2', startedAt: 2 };
    const message = pendingMovesRefusalMessage(stateWith([VALID, second]), STACK, REGION, 'cdkd deploy');
    expect(message).toContain('Old -> D.New');
    expect(message).toContain('Old2 -> D2.New2');
    expect(message).toContain("'cdkd refactor S'");
  });
});

describe('pendingMovesOut is carried by every writer (go-to-k/cdkd#5212)', () => {
  it('stackInstanceIdCarriedFrom carries it, and a field-enumerating rewrite keeps it', async () => {
    const { stackInstanceIdCarriedFrom } = await import('../../../src/types/state.js');
    const { applyLogicalIdRenames } = await import('../../../src/state/logical-id-rename.js');
    const pending = [{ from: 'Old', toStack: 'D', toRegion: 'us-east-1', to: 'New', startedAt: 1 }];
    expect(stackInstanceIdCarriedFrom({ pendingMovesOut: pending })).toEqual({ pendingMovesOut: pending });
    expect(stackInstanceIdCarriedFrom({})).toEqual({});
    const out = applyLogicalIdRenames(
      {
        version: 13,
        stackName: 'S',
        region: 'us-east-1',
        resources: { A: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} } },
        outputs: {},
        lastModified: 0,
        pendingMovesOut: pending,
      },
      [{ from: 'A', to: 'B' }],
      { Resources: {} }
    );
    expect(out.pendingMovesOut).toEqual(pending);
  });
});
