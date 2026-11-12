import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { record } from './sdk-wire-harness.js';

// go-to-k/cdkd#6126: the RDS client presigns a cross-region `PreSignedUrl` at
// the current second, so the harness's `create is not deterministic` check
// failed whenever its two recordings straddled a second boundary (likelier
// under host load). The clock is stepped here instead of waited on.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-rds', (orig) => wrap(orig, 'RDSClient'));

import { RDSClient, StartDBInstanceAutomatedBackupsReplicationCommand } from '@aws-sdk/client-rds';

const SOURCE = 'arn:aws:rds:us-east-1:123456789012:db:instance-1';

/** One replication start from the destination region, as the RDS provider sends it. */
const start = (kmsKeyId: string) => async () => {
  const client = new RDSClient({ region: 'us-west-2' });
  try {
    await client.send(
      new StartDBInstanceAutomatedBackupsReplicationCommand({
        SourceDBInstanceArn: SOURCE,
        KmsKeyId: kmsKeyId,
      })
    );
  } finally {
    client.destroy();
  }
};

const KEY = 'arn:aws:kms:us-west-2:123456789012:key/replica-key';

async function recordAt(iso: string, kmsKeyId = KEY) {
  vi.setSystemTime(new Date(iso));
  return record(start(kmsKeyId));
}

describe('sdk-wire harness: a presigned URL (go-to-k/cdkd#6126)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the same wire either side of a second boundary', async () => {
    const first = await recordAt('2026-11-11T12:00:00.999Z');
    // The URL is there to compare, signed: otherwise the equalities are vacuous.
    expect(first).toMatchObject({ threw: false });
    const wire = (first as { wire: string }).wire;
    expect(wire).toContain('PreSignedUrl=');
    expect(wire).toContain('X-Amz-Signature');
    expect(await recordAt('2026-11-11T12:00:01.000Z')).toEqual(first);
  });

  it('records the same wire across midnight UTC, where the credential scope day changes', async () => {
    const first = await recordAt('2026-11-11T23:59:59.999Z');
    expect(first).toMatchObject({ threw: false });
    expect(await recordAt('2026-11-12T00:00:00.000Z')).toEqual(first);
  });

  it('still sees a declared value carried inside the URL', async () => {
    const other = 'arn:aws:kms:us-west-2:123456789012:key/other-key';
    const a = await recordAt('2026-11-11T12:00:00.000Z');
    const b = await recordAt('2026-11-11T12:00:00.000Z', other);
    expect(b).not.toEqual(a);
    // Inside the URL too, not only as the top-level member.
    expect((b as { wire: string }).wire).toContain('key%252Fother-key%26');
  });
});
