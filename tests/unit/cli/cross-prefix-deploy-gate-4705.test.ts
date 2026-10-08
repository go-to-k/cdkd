/**
 * go-to-k/cdkd#4705: the deploy gate refuses a stack's FIRST deploy under this
 * state prefix when another prefix of the bucket records it, and never waits
 * on the scan for a stack whose record it loaded.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: (): unknown => quiet };
  return { ...actual, getLogger: () => quiet };
});

import { createCrossPrefixDeployGate } from '../../../src/cli/commands/cross-prefix-gate.js';
import type { CrossPrefixScanResult } from '../../../src/state/cross-prefix-stack-scan.js';
import { STATE_SCHEMA_VERSION_CURRENT, type StackState } from '../../../src/types/state.js';

const loaded: StackState = {
  version: STATE_SCHEMA_VERSION_CURRENT,
  stackName: 'App',
  region: 'us-east-1',
  resources: {},
  outputs: {},
  lastModified: 1,
};

function gate(scan: Promise<CrossPrefixScanResult> | undefined) {
  return createCrossPrefixDeployGate({
    stackName: 'App',
    region: 'us-east-1',
    bucket: 'cdkd-state-123456789012',
    scan,
  });
}

describe('createCrossPrefixDeployGate', () => {
  it('refuses a first deploy when another prefix records the stack', async () => {
    await expect(
      gate(Promise.resolve({ kind: 'found', prefixes: ['team-b'] }))('App', undefined)
    ).rejects.toThrow(/Refusing to deploy stack App \(us-east-1\): it is already recorded under another state prefix/);
  });

  it('does not wait on the scan when the record was loaded', async () => {
    // A scan that never settles: awaiting it would hang the test.
    const never = new Promise<CrossPrefixScanResult>(() => {});
    await expect(gate(never)('App', loaded)).resolves.toBeUndefined();
  });

  it('ignores another stack name (a nested child inherits the options)', async () => {
    const never = new Promise<CrossPrefixScanResult>(() => {});
    await expect(gate(never)('App~Child', undefined)).resolves.toBeUndefined();
  });

  it('proceeds on a clear scan, and when no scan was started', async () => {
    await expect(gate(Promise.resolve({ kind: 'clear' }))('App', undefined)).resolves.toBeUndefined();
    await expect(gate(undefined)('App', undefined)).resolves.toBeUndefined();
  });

  it('warns and proceeds when S3 denied the scan', async () => {
    warn.mockClear();
    await expect(
      gate(Promise.resolve({ kind: 'denied', error: { name: 'AccessDenied' } }))('App', undefined)
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Could not check whether stack App');
  });
});
