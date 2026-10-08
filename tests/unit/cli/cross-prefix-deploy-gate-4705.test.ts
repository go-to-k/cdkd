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

import {
  composeStateLoadedGates,
  createCrossPrefixDeployGate,
  createCrossPrefixDestructiveGate,
  createCrossPrefixHolder,
  crossPrefixScanKey,
  deployStackRegion,
  startCrossPrefixScans,
} from '../../../src/cli/commands/cross-prefix-gate.js';
import type { CrossPrefixScanTarget } from '../../../src/state/cross-prefix-stack-scan.js';
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

  it('warns and proceeds when S3 denied a read', async () => {
    warn.mockClear();
    await expect(
      gate(Promise.resolve({ kind: 'denied', error: { name: 'AccessDenied' }, stage: 'probe' }))(
        'App',
        undefined
      )
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Could not check the other state prefixes for stack App');
  });
});

function fakeTarget(holders: Record<string, boolean> = {}, own = false) {
  return {
    prefix: 'cdkd',
    ownRecordExists: vi.fn(async () => own),
    listTopLevelPrefixes: vi.fn(async () => ['cdkd', 'team-b']),
    recordUnderPrefix: vi.fn(async (p: string, stackName: string) =>
      holders[`${p}|${stackName}`] ? ('holder' as const) : ('absent' as const)
    ),
  } satisfies CrossPrefixScanTarget;
}

describe('the deploy wiring (deploy.ts)', () => {
  it('scans every stack of the set through ONE listing, keyed by stack AND region, in the region given', async () => {
    const t = fakeTarget({ 'team-b|A': true });
    const regionOf = vi.fn((s: { region?: string | undefined }) => s.region || 'eu-west-1');
    const scans = startCrossPrefixScans(
      [{ stackName: 'A' }, { stackName: 'B', region: 'us-west-2' }],
      t,
      regionOf
    );
    expect([...scans.keys()]).toEqual([
      crossPrefixScanKey('A', 'eu-west-1'),
      crossPrefixScanKey('B', 'us-west-2'),
    ]);
    await expect(scans.get(crossPrefixScanKey('A', 'eu-west-1'))).resolves.toMatchObject({
      kind: 'found',
    });
    await expect(scans.get(crossPrefixScanKey('B', 'us-west-2'))).resolves.toEqual({ kind: 'clear' });
    expect(t.listTopLevelPrefixes).toHaveBeenCalledTimes(1);
    expect(t.ownRecordExists).toHaveBeenCalledWith('A', 'eu-west-1');
    expect(t.ownRecordExists).toHaveBeenCalledWith('B', 'us-west-2');
  });

  it('keys one stack name in two regions apart', () => {
    expect(crossPrefixScanKey('A', 'us-east-1')).not.toBe(crossPrefixScanKey('A', 'us-west-2'));
  });

  it('calls the cross-prefix gate first, then the prefix-migration gate', async () => {
    const order: string[] = [];
    const composed = composeStateLoadedGates(
      async () => {
        order.push('cross-prefix');
      },
      async () => {
        order.push('migration');
      }
    );
    await composed('App', undefined);
    expect(order).toEqual(['cross-prefix', 'migration']);
    const refusing = composeStateLoadedGates(async () => {
      throw new Error('refused');
    }, vi.fn());
    await expect(refusing('App', undefined)).rejects.toThrow('refused');
  });
});

describe('createCrossPrefixDestructiveGate', () => {
  it('refuses a destructive plan of a stack another prefix holds, naming it', async () => {
    const gate = createCrossPrefixDestructiveGate({
      region: 'us-east-1',
      bucket: 'b',
      target: fakeTarget({ 'team-b|App': true }, true),
    });
    await expect(gate('App', [])).rejects.toThrow(
      /Refusing to deploy stack App \(us-east-1\): this deploy deletes or replaces resources.*\(team-b\)/s
    );
  });

  it('scans for the name the engine passes (a nested child) and ignores its own record', async () => {
    const t = fakeTarget({}, true);
    const gate = createCrossPrefixDestructiveGate({ region: 'us-east-1', bucket: 'b', target: t });
    await expect(gate('App~Child', [])).resolves.toBeUndefined();
    expect(t.ownRecordExists).not.toHaveBeenCalled();
    expect(t.recordUnderPrefix).toHaveBeenCalledWith('team-b', 'App~Child', 'us-east-1');
  });
});

describe('deployStackRegion (the ONE region expression the engine and the scans share)', () => {
  it("uses the stack's own region when it differs from the base region", () => {
    expect(deployStackRegion({ region: 'eu-west-1' }, 'us-east-1')).toBe('eu-west-1');
  });
  it('falls back to the base region', () => {
    expect(deployStackRegion({}, 'us-east-1')).toBe('us-east-1');
    expect(deployStackRegion({ region: '' }, 'us-east-1')).toBe('us-east-1');
  });
  it('the scans of a deploy set use it: a stack in another region is scanned in that region', async () => {
    const t = fakeTarget();
    startCrossPrefixScans(
      [{ stackName: 'Here' }, { stackName: 'There', region: 'eu-west-1' }],
      t,
      (s) => deployStackRegion(s, 'us-east-1')
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(t.ownRecordExists).toHaveBeenCalledWith('Here', 'us-east-1');
    expect(t.ownRecordExists).toHaveBeenCalledWith('There', 'eu-west-1');
  });
});

describe('createCrossPrefixHolder (the settle of journaled orphans)', () => {
  it('answers an unreadable holding naming the other prefix when one records the stack', async () => {
    const holder = createCrossPrefixHolder({
      region: 'us-east-1',
      bucket: 'b',
      target: fakeTarget({ 'team-b|App': true }),
    });
    await expect(holder('App')).resolves.toEqual({
      kind: 'unreadable',
      what: 'bucket b also records this stack under another state prefix (team-b), whose record may hold it',
    });
  });

  it('answers nothing when no other prefix records it, so the settle may delete', async () => {
    const holder = createCrossPrefixHolder({ region: 'us-east-1', bucket: 'b', target: fakeTarget() });
    await expect(holder('App')).resolves.toBeUndefined();
  });

  it('keeps the orphan (unreadable) when the check cannot run', async () => {
    const t = fakeTarget();
    t.listTopLevelPrefixes.mockRejectedValue(Object.assign(new Error('x'), { name: 'SlowDown' }));
    const holder = createCrossPrefixHolder({ region: 'us-east-1', bucket: 'b', target: t });
    await expect(holder('App')).resolves.toMatchObject({ kind: 'unreadable' });
  });
});
