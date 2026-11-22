import { describe, it, expect, vi } from 'vite-plus/test';
import { writeAheadRevertAttestations } from '../../../src/cli/commands/drift/revert-attestation.js';
import type { StackDriftReport } from '../../../src/cli/commands/drift/outcome.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6824: `cdkd drift --revert` sends each secret reference at its
 * CURRENT version, so before any send the reverted records lose the
 * `versionsSent` attestation, in a write that must succeed first.
 */
const TOKEN = '{{resolve:secretsmanager:db-secret:SecretString:password::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';

const record = (attested: boolean): ResourceState => ({
  physicalId: 'endpoint-1',
  resourceType: 'AWS::DMS::Endpoint',
  provisionedBy: 'cc-api',
  properties: { Password: TOKEN },
  referenceProvenance: {
    [TOKEN]: { region: 'us-east-1', versions: [V1], ...(attested && { versionsSent: true }) },
  },
});

const report = (resources: Record<string, ResourceState>): StackDriftReport =>
  ({
    stackName: 's',
    region: 'us-east-1',
    etag: 'etag-1',
    migrationPending: false,
    state: { version: 17, stackName: 's', region: 'us-east-1', resources, outputs: {}, lastModified: 1 },
    outcomes: [],
  }) as unknown as StackDriftReport;

describe('drift --revert writes the attestation away before it sends (go-to-k/cdkd#6824)', () => {
  it('strips it from the reverted records, saves under the read ETag, and carries the new one', async () => {
    const r = report({ P: record(true), Q: record(true) });
    const saveState = vi.fn().mockResolvedValue('etag-2');
    await writeAheadRevertAttestations(r, ['P'], { saveState } as never);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState.mock.calls[0]![3]).toEqual({ expectedEtag: 'etag-1' });
    expect(r.state.resources['P']!.referenceProvenance![TOKEN]).toEqual({
      region: 'us-east-1',
      versions: [V1],
    });
    // A record this revert does not send keeps its attestation.
    expect(r.state.resources['Q']!.referenceProvenance![TOKEN]!.versionsSent).toBe(true);
    expect(r.etag).toBe('etag-2');
  });

  it('writes nothing when no reverted record carries it', async () => {
    const saveState = vi.fn();
    await writeAheadRevertAttestations(report({ P: record(false) }), ['P'], { saveState } as never);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('a failed write rejects, so the caller reverts nothing', async () => {
    const r = report({ P: record(true) });
    const saveState = vi.fn().mockRejectedValue(new Error('PreconditionFailed'));
    await expect(writeAheadRevertAttestations(r, ['P'], { saveState } as never)).rejects.toThrow(
      'PreconditionFailed'
    );
    expect(r.etag).toBe('etag-1');
  });
});
