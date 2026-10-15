import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/local-state-loader.ts` slice. Every `--from-state` fallback
 * in this file logs a failed S3 read at debug and carries on -- to the
 * conventional asset-repo names, to the per-stack scan, to the next stack, or
 * to `undefined` (the env var warns and drops). Each built its line with
 * `err instanceof Error ? err.message : String(err)`, and
 * `String(Object.create(null))` throws `TypeError: Cannot convert object to
 * primitive value` -- so the handler itself threw. The bootstrap-marker reads
 * then failed `cdkd local run-task`; the resolver's throws reached cdk-local,
 * which drops the env entry, so the scan that would have answered it never ran.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION (the
 * fallback's result, the next read attempted), plus the placeholder on the
 * site's own debug line, so a fix that swallowed the failure without
 * reporting it would not pass.
 */

const mocks = vi.hoisted(() => ({
  debugSpy: vi.fn(),
  resolveStateBucketWithDefaultMock: vi.fn(),
  getRawObjectMock: vi.fn(),
  verifyBucketExistsMock: vi.fn(),
  listStacksMock: vi.fn(),
  getStateMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: mocks.debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: mocks.resolveStateBucketWithDefaultMock,
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getRawObject: mocks.getRawObjectMock,
    verifyBucketExists: mocks.verifyBucketExistsMock,
    listStacks: mocks.listStacksMock,
    getState: mocks.getStateMock,
  })),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => ({ lookup: mocks.lookupMock })),
}));

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...actual,
    AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  };
});

import {
  buildCrossStackResolver,
  loadBootstrapContainerRepo,
} from '../../../src/cli/commands/local-state-loader.js';
import { resetAwsClients } from '../../../src/utils/aws-clients.js';

const PLACEHOLDER = 'a value that could not be converted to text';

/** The one debug line carrying `needle`, so each case reads its own site. */
const debugLine = (needle: string): string | undefined =>
  mocks.debugSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes(needle));

const stateWithExport = (name: string, value: string): unknown => ({
  state: {
    version: 12,
    stackName: 'Producer',
    resources: {},
    outputs: { [name]: value },
    exportNames: [name],
  },
});

async function resolver() {
  const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
  if (built === undefined) throw new Error('resolver was not built');
  return built.resolver;
}

describe('local-state-loader: an unconvertible rejection still degrades (#3361)', () => {
  beforeEach(() => {
    resetAwsClients();
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetAwsClients();
  });

  it('bootstrap marker: a state-bucket resolution failure falls back to the conventional names', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockRejectedValue(Object.create(null));

    await expect(
      loadBootstrapContainerRepo('us-east-1', { statePrefix: 'cdkd', region: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(debugLine('could not resolve state bucket for the bootstrap-marker read')).toContain(
      PLACEHOLDER
    );
  });

  it('bootstrap marker: a failed marker read falls back to the conventional names', async () => {
    mocks.getRawObjectMock.mockRejectedValue(Object.create(null));

    await expect(
      loadBootstrapContainerRepo('us-east-1', { statePrefix: 'cdkd', region: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(debugLine('bootstrap-marker read failed')).toContain(PLACEHOLDER);
  });

  it('Fn::ImportValue: a failed exports-index lookup falls back to the per-stack scan', async () => {
    mocks.lookupMock.mockRejectedValue(Object.create(null));
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'Producer', region: 'us-east-1' }]);
    mocks.getStateMock.mockResolvedValue(stateWithExport('SharedName', 'from-scan'));

    await expect((await resolver()).resolveImport('SharedName')).resolves.toBe('from-scan');
    expect(mocks.getStateMock).toHaveBeenCalledWith('Producer', 'us-east-1');
    expect(debugLine('exports index lookup failed')).toContain(PLACEHOLDER);
  });

  it('Fn::ImportValue: a failed listStacks in the fallback resolves to undefined', async () => {
    mocks.lookupMock.mockResolvedValue(undefined);
    mocks.listStacksMock.mockRejectedValue(Object.create(null));

    await expect((await resolver()).resolveImport('SharedName')).resolves.toBeUndefined();
    expect(debugLine('failed to list stacks during Fn::ImportValue fallback')).toContain(
      PLACEHOLDER
    );
  });

  it('Fn::ImportValue: a failed state read moves on to the next stack', async () => {
    mocks.lookupMock.mockResolvedValue(undefined);
    mocks.listStacksMock.mockResolvedValue([
      { stackName: 'Broken', region: 'us-east-1' },
      { stackName: 'Producer', region: 'us-east-1' },
    ]);
    mocks.getStateMock.mockImplementation(async (stackName: string) => {
      if (stackName === 'Broken') throw Object.create(null);
      return stateWithExport('SharedName', 'from-next-stack');
    });

    await expect((await resolver()).resolveImport('SharedName')).resolves.toBe(
      'from-next-stack'
    );
    expect(mocks.getStateMock).toHaveBeenCalledTimes(2);
    expect(debugLine('state read failed for Broken')).toContain(PLACEHOLDER);
  });

  it('Fn::GetStackOutput: a failed state read resolves to undefined', async () => {
    mocks.getStateMock.mockRejectedValue(Object.create(null));

    await expect(
      (await resolver()).resolveGetStackOutput('Producer', 'us-east-1', 'Out')
    ).resolves.toBeUndefined();
    expect(debugLine('state read failed for Fn::GetStackOutput')).toContain(PLACEHOLDER);
  });
});
