/**
 * Issue go-to-k/cdkd#5212: `loadStateOrEmpty` pushes
 * `pendingMovesRefusalMessage(...)` into `deployRefusals` when the record
 * carries a pending `cdkd refactor` move — the same go-to-k/cdkd#3512 rule as
 * `diff-recursive-dropped-container-blocking.test.ts`'s dropped containers:
 * a condition the deploy refuses over must raise `cdkd diff`'s exit 3 too.
 *
 * Harness reused from `diff-recursive-dropped-container-blocking.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { buildDiffTree, countBlocking } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { resetRefactorMarkerReadsForTest } from '../../../src/state/refactor-marker.js';

const STACK = 'S';
const REGION = 'us-east-1';

const queue = (properties: Record<string, unknown> = {}): ResourceState => ({
  physicalId: 'q',
  resourceType: 'AWS::SQS::Queue',
  properties,
});

const PENDING_MOVE = {
  from: 'Q',
  toStack: 'D',
  toRegion: REGION,
  to: 'Q2',
  startedAt: 1,
};

function record(extra: Record<string, unknown> = {}): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 13,
    resources: { Q: queue() },
    outputs: {},
    lastModified: 0,
    ...extra,
  } as StackState;
}

const TPL: CloudFormationTemplate = { Resources: { Q: { Type: 'AWS::SQS::Queue' } } };

function backendHolding(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

const MARKER_MOVE = {
  fromStack: 'Src',
  fromRegion: REGION,
  from: 'X',
  toStack: STACK,
  toRegion: REGION,
  to: 'Moved',
  startedAt: 1,
};

function backendHoldingWithMarker(
  states: Record<string, StackState>,
  marker: { body: unknown; etag: string } | null
): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
    refactorMarkerKey: () => 'cdkd/_refactor/pending.json',
    getRefactorMarker: async () => marker,
  } as unknown as S3StateBackend;
}

type PreviewOrphanAdoption = Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'];
const adoptNothing = (async () => ({ adopted: {}, refusals: [] })) as unknown as PreviewOrphanAdoption;

async function diff(state: StackState) {
  return diffWithBackend(backendHolding({ [STACK]: state }));
}

async function diffWithBackend(stateBackend: S3StateBackend) {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template: TPL,
    nestedTemplates: {},
    recursive: false,
    stateBackend,
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    previewOrphanAdoption: adoptNothing,
  });
}

describe("cdkd diff blocks over an unfinished cdkd refactor move (go-to-k/cdkd#5212)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefactorMarkerReadsForTest();
  });

  it('puts exactly one blocking reason naming cdkd refactor, REFACTOR-free prose "did not finish"', async () => {
    const node = await diff(record({ pendingMovesOut: [PENDING_MOVE] }));

    expect(node.blocking).toHaveLength(1);
    expect(node.blocking[0]).toContain('cdkd refactor');
    expect(node.blocking[0]).toContain('did not finish');
    expect(node.blocking[0]).not.toContain('REFACTOR');
    expect(countBlocking(node)).toBe(1);
  });

  it('CONTROL: a record with no pendingMovesOut adds no blocking reason', async () => {
    const node = await diff(record());

    expect(node.blocking).toEqual([]);
    expect(countBlocking(node)).toBe(0);
  });

  it('blocks when the shared marker (not the record) lists a move whose destination is the diffed stack', async () => {
    const node = await diffWithBackend(
      backendHoldingWithMarker(
        { [STACK]: record() },
        { body: { moves: [MARKER_MOVE] }, etag: '"e"' }
      )
    );

    expect(node.blocking.length).toBeGreaterThanOrEqual(1);
    expect(node.blocking.some((r) => r.includes('did not finish'))).toBe(true);
  });

  it('still reports the marker reason when the diffed stack has no state record at all', async () => {
    const node = await diffWithBackend(
      backendHoldingWithMarker({}, { body: { moves: [MARKER_MOVE] }, etag: '"e"' })
    );

    expect(node.blocking.some((r) => r.includes('did not finish'))).toBe(true);
  });
});
