/**
 * Issue go-to-k/cdkd#4159, the `cdkd local --from-state` half: the three
 * malformed-record warnings `S3LocalStateProvider.load` prints carry the run's
 * `--profile`, the bucket the record was READ from (not the raw flag) and a
 * non-default `--state-prefix` on their `cdkd state show` pointer.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mocks = vi.hoisted(() => ({
  loadStateForStackMock: vi.fn(),
  buildCrossStackResolverMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../../src/cli/commands/local-state-loader.js', () => ({
  loadStateForStack: mocks.loadStateForStackMock,
  buildCrossStackResolver: mocks.buildCrossStackResolverMock,
}));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: mocks.warnMock,
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});

import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';

const REGION = 'us-east-1';
const SHOW = `cdkd state show TargetStack --stack-region ${REGION} --json`;

function loaded(patch: Record<string, unknown>): unknown {
  const state = {
    version: 9,
    stackName: 'TargetStack',
    region: REGION,
    resources: { R: { physicalId: 'f', resourceType: 'AWS::S3::Bucket', properties: {} } },
    outputs: { Out: 'v' },
    lastModified: 1,
    ...patch,
  } as StackState;
  // The bucket the loader RESOLVED: no `stateBucket` flag is passed below.
  return { state, region: REGION, stateBucket: 'resolved-bucket' };
}

/** FACTORIES: the repairs mutate the record they are handed. */
const SITES: Array<[string, () => Record<string, unknown>]> = [
  ['the outputs bag', () => ({ outputs: 'abc' })],
  ['the resources bag', () => ({ resources: 'abc' })],
  ['a resource row', () => ({ resources: { R: null } })],
];

const warned = (): string => mocks.warnMock.mock.calls.map((c) => String(c[0])).join('\n');

describe('S3LocalStateProvider warnings carry the account flags (go-to-k/cdkd#4159)', () => {
  beforeEach(() => {
    mocks.loadStateForStackMock.mockReset();
    mocks.warnMock.mockReset();
  });

  for (const [site, patch] of SITES) {
    it(`${site}: --profile, the resolved bucket and the prefix ride`, async () => {
      mocks.loadStateForStackMock.mockResolvedValue(loaded(patch()));
      await new S3LocalStateProvider({ statePrefix: 'team-a', profile: 'prod' }).load(
        'TargetStack',
        REGION
      );
      expect(warned()).toContain(
        `${SHOW} --profile prod --state-bucket resolved-bucket --state-prefix team-a`
      );
    });

    it(`${site}: CONTROL — no --profile, default prefix: only the resolved bucket`, async () => {
      mocks.loadStateForStackMock.mockResolvedValue(loaded(patch()));
      await new S3LocalStateProvider({ statePrefix: 'cdkd' }).load('TargetStack', REGION);
      expect(warned()).toContain(`${SHOW} --state-bucket resolved-bucket`);
      expect(warned()).not.toContain('--profile');
      expect(warned()).not.toContain('--state-prefix');
    });
  }
});
