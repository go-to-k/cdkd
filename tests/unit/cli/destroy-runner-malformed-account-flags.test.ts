/**
 * Issue go-to-k/cdkd#3909: the malformed-record refusals `runDestroyForStack`
 * raises print pasteable `cdkd state show` / `cdkd state list --json` /
 * `cdkd state orphan` lines, and those re-resolve the bucket from the ambient
 * profile unless the line carries the run's own `--profile` / `--state-bucket`
 * / `--state-prefix`. So `cdkd destroy --state-bucket X` refusing pointed at a
 * listing of the DEFAULT bucket, which does not hold the record.
 *
 * One case per CALL SITE in the runner, because each passes the context
 * separately: the entry read and the under-lock re-read of the `resources`,
 * entry, `orphans` container and `orphans` row guards, the divergent-region
 * refusal and the `outputs` refusal. Deleting the argument at any one of them reddens exactly its case.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn() })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';
const STACK = 'TestStack';
const FLAGS = '--profile prod --state-bucket test-bucket --state-prefix team-a';

function record(overrides: Partial<Record<keyof StackState, unknown>>): StackState {
  return {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: {},
    outputs: {},
    lastModified: 1,
    ...overrides,
  } as StackState;
}

const LIVE_ROW = { resourceType: 'AWS::S3::Bucket', physicalId: 'p', properties: {} };

function makeCtx(account: { profile?: string; statePrefix?: string } = {
  profile: 'prod',
  statePrefix: 'team-a',
}) {
  const getState = vi.fn().mockResolvedValue(null);
  return {
    getState,
    ctx: {
      stateBackend: {
        getState,
        deleteState: vi.fn().mockResolvedValue(undefined),
        saveState: vi.fn(),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor: vi.fn() } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      ...account,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

async function refusal(h: ReturnType<typeof makeCtx>, state: StackState): Promise<string> {
  const thrown = await runDestroyForStack(STACK, state, h.ctx).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(thrown, 'the run did not refuse').toBeInstanceOf(Error);
  return (thrown as Error).message;
}

/** Re-read arm: the entry record is clean and empty, the under-lock one is damaged. */
function underLock(h: ReturnType<typeof makeCtx>, damaged: StackState): StackState {
  h.getState.mockResolvedValue({ state: damaged, etag: 'e' });
  return record({});
}

// The orphan-row text builds its inspect line through its own identity gate,
// which prints the same spelling for this plain identity.
const INSPECT = `cdkd state show ${STACK} --stack-region ${REGION} --json ${FLAGS}`;

describe('the destroy runner qualifies every malformed-record refusal with its account (go-to-k/cdkd#3909)', () => {
  beforeEach(() => vi.clearAllMocks());

  const SITES: Array<[string, (h: ReturnType<typeof makeCtx>) => StackState]> = [
    ['resources, entry read', () => record({ resources: [] })],
    ['resources, under-lock re-read', (h) => underLock(h, record({ resources: [] }))],
    ['resource rows, entry read', () => record({ resources: { Bad: null } })],
    ['resource rows, under-lock re-read', (h) => underLock(h, record({ resources: { Bad: null } }))],
    ['orphans, entry read', () => record({ orphans: 'x' })],
    ['orphans, under-lock re-read', (h) => underLock(h, record({ orphans: 'x' }))],
    ['outputs', () => record({ outputs: 'x' })],
    ['orphan rows, entry read', () => record({ orphans: [null] })],
    ['orphan rows, under-lock re-read', (h) => underLock(h, record({ orphans: [null] }))],
  ];

  for (const [site, arrange] of SITES) {
    it(`${site}: the inspect command carries --profile, the bucket and the prefix`, async () => {
      const h = makeCtx();
      const message = await refusal(h, arrange(h));
      expect(message).toContain(INSPECT);
    });
  }

  it('divergent region: the drop template carries them, and the message still ends on it', async () => {
    const h = makeCtx();
    (h.ctx as { divergentBodyRegion?: unknown }).divergentBodyRegion = 'eu-west-1';
    const message = await refusal(h, record({ resources: { A: LIVE_ROW } }));
    expect(message.endsWith(`cdkd state orphan '<stack>' --stack-region '<region>' ${FLAGS}`)).toBe(
      true
    );
  });

  it('the withhold arm prints the listing as its own line, carrying the same flags', async () => {
    const h = makeCtx();
    // A trailing space renders as a HEALTHY sibling's name, so the refusal
    // names no target and sends the reader to the listing (go-to-k/cdkd#3420).
    const thrown = await runDestroyForStack(`${STACK} `, record({ resources: [] }), h.ctx).then(
      () => undefined,
      (e: unknown) => e
    );
    const lines = (thrown as Error).message.split('\n');
    expect(lines.slice(1)).toEqual([
      `Find the exact name: cdkd state list --json ${FLAGS}`,
      `Inspect the record: cdkd state show '<stack>' --stack-region '<region>' --json ${FLAGS}`,
    ]);
  });

  it('CONTROL: an unset profile and the DEFAULT prefix add no flag, the bucket always rides', async () => {
    const h = makeCtx({ statePrefix: 'cdkd' });
    const message = await refusal(h, record({ resources: { Bad: null } }));
    expect(message.endsWith(`--stack-region ${REGION} --json --state-bucket test-bucket`)).toBe(true);
    expect(message).not.toContain('--profile');
    expect(message).not.toContain('--state-prefix');
  });

  it('a profile that is not a plain identifier is a described hole, never echoed', async () => {
    const h = makeCtx({ profile: 'Drop the record: x' });
    const message = await refusal(h, record({ resources: { Bad: null } }));
    expect(message).not.toContain('Drop the record: x');
    expect(message).toContain(
      "The '--profile' value this run was given is not a plain identifier"
    );
    expect(
      message.endsWith(`--json --profile '<profile>' --state-bucket test-bucket`),
      message
    ).toBe(true);
  });
});
