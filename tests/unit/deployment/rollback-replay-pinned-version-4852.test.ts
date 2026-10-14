/**
 * go-to-k/cdkd#4852: the rollback replay restores a recorded token at the
 * VERSION its v12 record names (design §3, replay pinning), so the restore
 * sends what the previous record described, not a value rotated in since.
 * A pin that cannot be read, or whose plaintext is under the needle floor,
 * falls back to the current value with a warning; a record with no field is
 * today's replay.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const log = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: unknown) => {
      log.warn.push(String(m));
    }),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
const secret = vi.hoisted(() => ({
  value: 'current-password',
  version: 'b1b2c3d4-0000-1111-2222-333333333333',
  history: {} as Record<string, string>,
  lookups: [] as string[],
  regions: [] as string[],
}));
const answer = vi.hoisted(() => async (command?: unknown, region = 'us-east-1'): Promise<unknown> => {
  const input = (command as { input?: { SecretId?: string; VersionId?: string } } | undefined)
    ?.input;
  secret.lookups.push(`${String(input?.SecretId)}@${input?.VersionId ?? ''}`);
  secret.regions.push(region);
  if (input?.VersionId !== undefined) {
    const value = secret.history[input.VersionId];
    if (value === undefined) {
      throw Object.assign(new Error('no such version'), { name: 'ResourceNotFoundException' });
    }
    return { SecretString: value, VersionId: input.VersionId };
  }
  return { SecretString: secret.value, VersionId: secret.version };
});
vi.mock('../../../src/utils/aws-clients.js', () => {
  // A region-scoped client set per region, so a lookup says which region asked.
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: (command: unknown) => answer(command, region),
      config: { region: () => Promise.resolve(region) },
    },
    credentialConfig: {},
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1') };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config: { region: () => Promise<string> };
    private readonly ctorRegion: string;
    constructor(config?: { region?: string }) {
      this.ctorRegion = config?.region ?? 'us-east-1';
      this.config = { region: () => Promise.resolve(this.ctorRegion) };
    }
    send(command: unknown): Promise<unknown> {
      return answer(command, this.ctorRegion);
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

import { resolveReplayProps } from '../../../src/deployment/rollback-executor/replay-props.js';
import {
  ReplayResolvers,
  redactRollbackRecord,
} from '../../../src/deployment/rollback-executor/replay-secrets.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resolvedPlaintextOf } from '../../../src/deployment/secret-redaction/pairs.js';

const REF = '{{resolve:secretsmanager:pw}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';

beforeEach(() => {
  secret.value = 'current-password';
  secret.version = V2;
  secret.history = { [V1]: 'previous-password', [V2]: 'current-password' };
  secret.lookups = [];
  secret.regions = [];
  log.warn.length = 0;
});

const props = { Password: REF, Url: `https://x/${REF}/y` };

function recordWith(versions: string[] | undefined, region = 'us-east-1'): ResourceState {
  return {
    physicalId: 'db-1',
    resourceType: 'AWS::RDS::DBInstance',
    properties: props,
    attributes: {},
    dependencies: [],
    ...(versions !== undefined && {
      referenceProvenance: { [REF]: { region, versions } },
    }),
  };
}

async function replay(record: ResourceState) {
  const secrets = new Map<string, string>();
  const resolved = await resolveReplayProps(
    record.properties,
    new ReplayResolvers('us-east-1'),
    secrets,
    { region: 'us-east-1' } as never,
    'Db',
    record
  );
  return { resolved, secrets };
}

describe('rollback replay pinning (go-to-k/cdkd#4852)', () => {
  it('restores the recorded version, and the restored record persists only the token', async () => {
    const record = recordWith([V1]);
    const { resolved, secrets } = await replay(record);
    expect(resolved).toEqual({
      Password: 'previous-password',
      Url: 'https://x/previous-password/y',
    });
    expect(secret.lookups).toContain(`pw@${V1}`);
    const persisted = redactRollbackRecord(
      { ...record, properties: resolved! },
      secrets,
      record.properties
    );
    expect(persisted.properties).toEqual(props);
    expect(JSON.stringify(persisted)).not.toContain('previous-password');
  });

  it('a record with no field, or two versions, restores the current value (today)', async () => {
    for (const versions of [undefined, [V1, V2]]) {
      secret.lookups = [];
      const { resolved } = await replay(recordWith(versions));
      expect(resolved?.['Password']).toBe('current-password');
      expect(secret.lookups.some((l) => l.endsWith(`@${V1}`))).toBe(false);
    }
  });

  it('a version that cannot be read restores the current value, with a warning', async () => {
    delete secret.history[V1];
    const { resolved } = await replay(recordWith([V1]));
    expect(resolved?.['Password']).toBe('current-password');
    // Once, though two leaves hold the token: the verdict is kept per token.
    expect(log.warn.filter((m) => m.includes('could not read a secret at the version'))).toHaveLength(
      1
    );
    expect(log.warn.join('\n')).not.toContain('password');
  });

  it('a pinned plaintext under the needle floor is not restored (it could not be redacted)', async () => {
    secret.history[V1] = 'abc';
    const { resolved } = await replay(recordWith([V1]));
    expect(resolved?.['Password']).toBe('current-password');
    expect(log.warn.some((m) => m.includes('shorter than four characters'))).toBe(true);
  });

  it('reads the pin once per token, in the region the record names', async () => {
    const { resolved } = await replay(recordWith([V1], 'us-west-2'));
    expect(resolved?.['Password']).toBe('previous-password');
    // Two leaves hold the token: one pinned lookup, through us-west-2.
    expect(secret.lookups.filter((l) => l === `pw@${V1}`)).toEqual([`pw@${V1}`]);
    const pinnedAt = secret.lookups.indexOf(`pw@${V1}`);
    expect(secret.regions[pinnedAt]).toBe('us-west-2');
  });

  it('a pin equal to the current version keeps the token\'s resolved pair', async () => {
    // The pair positions an embedded leaf in the restored record; a value read
    // at another version never gets one.
    const { secrets } = await replay(recordWith([V2]));
    expect(resolvedPlaintextOf(secrets, REF)).toBe('current-password');
  });
});
