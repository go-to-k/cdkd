import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2178 — the RUNTIME twin of `scripts/check-provider-secret-mask.ts` for
 * `KinesisStreamProvider`.
 *
 * Two readers quote the offending value back at the user —
 * `readShardLevelMetrics` and `readMaxRecordSize` — and each reason reaches
 * BOTH a refusal (the template-path create) and a warning (a state replay, and
 * every update, which may not refuse). `properties` arrives RESOLVED, so a
 * `{{resolve:secretsmanager:...}}` scalar in either position is already
 * plaintext by then.
 *
 * The critic is static: it proves the `maskDeep(...)` wrap exists. Only a run
 * proves the masker threaded from `CreateContext` / `UpdateContext` into those
 * two module-level readers is not the identity function, which is exactly what
 * `not.toContain(SECRET_PLAINTEXT)` measures.
 */

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kinesis', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kinesis')>(
    '@aws-sdk/client-kinesis'
  );
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::Kinesis::Stream';
const ACTIVE = {
  StreamDescription: { StreamName: 'mystream', StreamStatus: 'ACTIVE', StreamARN: 'arn:describe' },
};
const SUMMARY = { StreamDescriptionSummary: { StreamARN: 'arn:summary', OpenShardCount: 1 } };

/** Distinctive, >= 8 chars, and a substring of nothing else in the message. */
const SECRET_PLAINTEXT = 'kinesis2178-metrics-plaintext';

/**
 * A secret carrying a `"`, which `JSON.stringify` escapes out of existence.
 * The warn SINK (`logger.warn(mask(message))`) can no longer find it once the
 * message is assembled, so this is the case only the pre-stringify `maskDeep`
 * walk can reach — it is what separates the two layers.
 */
const ESCAPED_SECRET = 'a"b-kinesis2178-escaped';

function maskerFor(...values: string[]): (text: string) => string {
  const bag: RecordedSecretValues = new Map(
    values.map((v) => [v, `{{resolve:secretsmanager:kinesis/${v.length}:SecretString:v::}}`])
  );
  return createSecretMasker(bag);
}

const maskSecrets = (): ((text: string) => string) => maskerFor(SECRET_PLAINTEXT);

/** The secret at a NESTED string leaf, so the WALK is what has to find it. */
const NESTED_BAD = { nested: { bad: SECRET_PLAINTEXT } };
const MASKED_RENDERING = JSON.stringify({ nested: { bad: SECRET_MASK } });
const RAW_RENDERING = JSON.stringify({ nested: { bad: SECRET_PLAINTEXT } });

function warnings(): string {
  return warnSpy.mock.calls.map((c) => String(c[0])).join('\n---\n');
}

async function refusalMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal, but the call resolved');
}

describe('KinesisStreamProvider masks the values it quotes back (issue #2178)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    warnSpy.mockReset();
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });
    provider = new KinesisStreamProvider();
  });

  describe('DesiredShardLevelMetrics', () => {
    it('masks the resolved secret in the create() REFUSAL', async () => {
      const message = await refusalMessage(
        provider.create(
          'L',
          TYPE,
          { Name: 'mystream', DesiredShardLevelMetrics: NESTED_BAD },
          { maskSecrets: maskSecrets() }
        )
      );

      // Non-vacuity first: the refusal fired and still quotes the value.
      expect(message).toContain('must be an array of metric-name');
      expect(message).toContain(MASKED_RENDERING);
      expect(message).toContain(SECRET_MASK);
      expect(message).not.toContain(SECRET_PLAINTEXT);
    });

    it('masks the resolved secret in the create() state-replay WARNING', async () => {
      await provider.create(
        'L',
        TYPE,
        { Name: 'mystream', DesiredShardLevelMetrics: NESTED_BAD },
        { replayingState: true, maskSecrets: maskSecrets() }
      );

      const warned = warnings();
      expect(warned).toContain('Replaying a state record');
      expect(warned).toContain(MASKED_RENDERING);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
    });

    it('masks the resolved secret in the update() WARNING', async () => {
      await provider.update(
        'L',
        'mystream',
        TYPE,
        { Name: 'mystream', DesiredShardLevelMetrics: NESTED_BAD },
        { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] },
        { maskSecrets: maskSecrets() }
      );

      const warned = warnings();
      expect(warned).toContain('Leaving the shard-level metrics');
      expect(warned).toContain(MASKED_RENDERING);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
    });

    // The layer separation. Once assembled, the message no longer CONTAINS this
    // secret (the `"` is escaped), so the warn sink cannot find it and only the
    // pre-stringify walk can. Deleting the `maskDeep` wrap while keeping the
    // sink leaves this the failing case.
    it('masks a secret that JSON escaping would otherwise hide from the sink', async () => {
      await provider.update(
        'L',
        'mystream',
        TYPE,
        { Name: 'mystream', DesiredShardLevelMetrics: { nested: { bad: ESCAPED_SECRET } } },
        { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] },
        { maskSecrets: maskerFor(ESCAPED_SECRET) }
      );

      const warned = warnings();
      expect(warned).toContain('Leaving the shard-level metrics');
      expect(warned).not.toContain(ESCAPED_SECRET);
      // The ESCAPED rendering is what actually leaked, so asserting only the
      // raw form would pass on the broken code.
      expect(warned).not.toContain(JSON.stringify(ESCAPED_SECRET).slice(1, -1));
      expect(warned).toContain(SECRET_MASK);
    });

    // THE CONTROL: absent context means unmasked, by contract.
    it('leaves the plaintext INTACT when no context is supplied — the control', async () => {
      const message = await refusalMessage(
        provider.create('L', TYPE, { Name: 'mystream', DesiredShardLevelMetrics: NESTED_BAD })
      );

      expect(message).toContain('must be an array of metric-name');
      expect(message).toContain(RAW_RENDERING);
      expect(message).toContain(SECRET_PLAINTEXT);
      expect(message).not.toContain(SECRET_MASK);
    });

    it('leaves the update() warning unmasked when no context is supplied', async () => {
      await provider.update(
        'L',
        'mystream',
        TYPE,
        { Name: 'mystream', DesiredShardLevelMetrics: NESTED_BAD },
        { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] }
      );

      expect(warnings()).toContain(SECRET_PLAINTEXT);
    });
  });

  describe('MaxRecordSizeInKiB', () => {
    it('masks the resolved secret in the create() REFUSAL', async () => {
      const message = await refusalMessage(
        provider.create(
          'L',
          TYPE,
          { Name: 'mystream', MaxRecordSizeInKiB: NESTED_BAD },
          { maskSecrets: maskSecrets() }
        )
      );

      expect(message).toContain('MaxRecordSizeInKiB must be a number');
      expect(message).toContain(MASKED_RENDERING);
      expect(message).not.toContain(SECRET_PLAINTEXT);
    });

    it('masks the resolved secret in the create() state-replay WARNING', async () => {
      await provider.create(
        'L',
        TYPE,
        { Name: 'mystream', MaxRecordSizeInKiB: NESTED_BAD },
        { replayingState: true, maskSecrets: maskSecrets() }
      );

      const warned = warnings();
      expect(warned).toContain("AWS's default maximum record size");
      expect(warned).toContain(MASKED_RENDERING);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
    });

    it('masks the resolved secret in the update() WARNING', async () => {
      await provider.update(
        'L',
        'mystream',
        TYPE,
        { Name: 'mystream', MaxRecordSizeInKiB: NESTED_BAD },
        { Name: 'mystream', MaxRecordSizeInKiB: 2048 },
        { maskSecrets: maskSecrets() }
      );

      const warned = warnings();
      expect(warned).toContain('Leaving the maximum record size');
      expect(warned).toContain(MASKED_RENDERING);
      expect(warned).not.toContain(SECRET_PLAINTEXT);
    });

    it('leaves the plaintext INTACT when no context is supplied — the control', async () => {
      const message = await refusalMessage(
        provider.create('L', TYPE, { Name: 'mystream', MaxRecordSizeInKiB: NESTED_BAD })
      );

      expect(message).toContain('MaxRecordSizeInKiB must be a number');
      expect(message).toContain(RAW_RENDERING);
      expect(message).toContain(SECRET_PLAINTEXT);
      expect(message).not.toContain(SECRET_MASK);
    });
  });

  it('does not mangle a non-secret value when a masker IS supplied', async () => {
    const message = await refusalMessage(
      provider.create(
        'L',
        TYPE,
        { Name: 'mystream', MaxRecordSizeInKiB: { nested: { bad: 'not-a-size' } } },
        { maskSecrets: maskSecrets() }
      )
    );

    expect(message).toContain('not-a-size');
    expect(message).not.toContain(SECRET_MASK);
  });
});
