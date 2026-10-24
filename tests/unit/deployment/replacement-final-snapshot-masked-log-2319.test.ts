import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2319: the pre-delete final snapshot's debug line quotes a
 * withheld AWS failure's text, so the replacement path hands the snapshot
 * helper a logger routed through the caller's secret masker.
 */

const { snapshot } = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPreDeleteFinalSnapshot: snapshot,
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => ({}) }));

const { prepareFinalSnapshotForDelete } = await import(
  '../../../src/deployment/deploy-engine/replacement.js'
);

const debug = vi.fn();
const info = vi.fn();
const deps = { options: {}, logger: { debug, info, warn: vi.fn(), error: vi.fn() } } as never;
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const lines = (spy: typeof debug): string[] => spy.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  debug.mockReset();
  info.mockReset();
  snapshot.mockReset();
  snapshot.mockImplementation(
    async (_t: string, _p: string, _l: string, _c: unknown, log: typeof deps) => {
      const l = log as unknown as { debug(m: string): void; info(m: string): void };
      l.debug('Failed to create the final snapshot: User: assumed-role/deployer/s3cr3t is not authorized');
      l.info('Creating final snapshot for s3cr3t-vol');
      return 'snap-1';
    }
  );
});

describe('prepareFinalSnapshotForDelete masks the snapshot helper lines (go-to-k/cdkd#2319)', () => {
  it("routes the helper's debug and info lines through the caller's masker", async () => {
    await prepareFinalSnapshotForDelete(deps, 'Vol', 'AWS::EC2::Volume', { physicalId: 'vol-1' }, 'Snapshot', mask);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(lines(debug)).toContain(
      'Failed to create the final snapshot: User: assumed-role/deployer/*** is not authorized'
    );
    expect(lines(info)).toContain('Creating final snapshot for ***-vol');
    expect([...lines(debug), ...lines(info)].join('\n')).not.toContain('s3cr3t');
  });

  it('without a masker the lines pass through as they were (negative control)', async () => {
    await prepareFinalSnapshotForDelete(deps, 'Vol', 'AWS::EC2::Volume', { physicalId: 'vol-1' }, 'Snapshot');
    expect(lines(debug).join('\n')).toContain('s3cr3t');
  });
});
