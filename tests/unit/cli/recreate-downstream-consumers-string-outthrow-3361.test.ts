import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/recreate-downstream-consumers.ts` slice: both soft-fail
 * catches in `findDownstreamConsumers` built their debug line with
 * `x instanceof Error ? x.message : String(x)`, which turned a graceful
 * degradation into a hard failure when the value could not be converted --
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * Each case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the empty fallback, the other stacks' consumers), never merely "it
 * did not throw". The placeholder is asserted too, so a fix that swallowed the
 * failure without reporting it would not pass.
 */

const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { findDownstreamConsumers } from '../../../src/cli/commands/recreate-downstream-consumers.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const PLACEHOLDER = 'a value that could not be converted to text';
const REGION = 'us-east-1';

function debugLines(): string[] {
  return debugSpy.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  debugSpy.mockClear();
});

describe('findDownstreamConsumers with an unconvertible rejection (#3361)', () => {
  it('falls back to an empty enumeration when listStacks rejects', async () => {
    const stateBackend = {
      listStacks: vi.fn(async () => {
        throw Object.create(null);
      }),
      getState: vi.fn(),
    } as unknown as S3StateBackend;

    const consumers = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: REGION,
      stateBackend,
      baseRegion: REGION,
    });

    expect(consumers).toEqual([]);
    expect(debugLines()).toContain(
      `findDownstreamConsumers: listStacks failed; falling back to empty enumeration. ${PLACEHOLDER}`
    );
  });

  it('skips the one unreadable stack and still reports the others', async () => {
    const stateBackend = {
      listStacks: vi.fn(async () => [
        { stackName: 'Unreadable', region: REGION },
        { stackName: 'Consumer', region: REGION },
      ]),
      getState: vi.fn(async (stackName: string) => {
        if (stackName === 'Unreadable') throw Object.create(null);
        return {
          state: {
            imports: [{ sourceStack: 'Producer', sourceRegion: REGION, exportName: 'BucketArn' }],
          },
        };
      }),
    } as unknown as S3StateBackend;

    const consumers = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: REGION,
      stateBackend,
      baseRegion: REGION,
    });

    expect(consumers).toEqual([
      {
        consumerStack: 'Consumer',
        consumerRegion: REGION,
        exportName: 'BucketArn',
        intrinsic: 'ImportValue',
      },
    ]);
    expect(debugLines()).toContain(
      `findDownstreamConsumers: skip Unreadable (${REGION}); ${PLACEHOLDER}`
    );
  });
});
