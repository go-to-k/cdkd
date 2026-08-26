import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2178 — the RUNTIME twin of `scripts/check-provider-secret-mask.ts` for
 * `S3BucketProvider`'s destination-shape refusals.
 *
 * `describeValue` names the offending value inside the analytics / inventory
 * `Destination` refusals, and one of its branches renders it with
 * `JSON.stringify`. A provider's `properties` bag arrives RESOLVED, so a
 * `{{resolve:secretsmanager:...}}` scalar sitting where an object was expected
 * is already PLAINTEXT by the time the refusal quotes it — and masking the
 * FINISHED message cannot recover it, because `JSON.stringify` escapes `"`,
 * `\` and newlines out of the line the mask would search.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE STATIC CRITIC. The critic goes green the
 * moment the stringified expression is wrapped in something typed as a masker
 * — it cannot tell a REAL masker threaded from `context?.maskSecrets` from a
 * decorative parameter nothing ever passes. These cases drive the provider's
 * public `create()` / `update()` with a real `SecretMasker` on the context and
 * assert over the text that actually comes out, so a masker that stops being
 * threaded fails here even while the critic still passes.
 *
 * The UNMASKED control is load-bearing in the other direction: without it, a
 * refusal that stopped naming the value at all would pass the masked case
 * vacuously.
 */

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'analytics-source-bucket';

/**
 * Distinctive and comfortably over `MIN_NEEDLE_LENGTH`, so the substring arm of
 * `maskSecretsInText` cannot decline it for being too short — the failure this
 * whole contract exists to avoid is a needle that survives BECAUSE the finished
 * message was longer than it.
 */
const SECRET_PLAINTEXT = 's3-2178-destination-plaintext';

/**
 * The ORDER probe. This value carries a `"` and a newline, so `JSON.stringify`
 * escapes it into a form that no longer CONTAINS the needle — a mask applied to
 * the finished message therefore cannot find it, while `maskDeep` run on the
 * value first replaces the whole leaf. Without a case like this, masking after
 * the stringify passes every assertion above, because an alphanumeric secret
 * survives `JSON.stringify` unchanged and the substring arm still matches it.
 */
const SECRET_WITH_ESCAPES = 's3-2178 "quoted" and\nnewlined plaintext';

function masker(): (text: string) => string {
  const bag: RecordedSecretValues = new Map([
    [SECRET_PLAINTEXT, '{{resolve:secretsmanager:s3/dest:SecretString:arn::}}'],
    [SECRET_WITH_ESCAPES, '{{resolve:secretsmanager:s3/dest:SecretString:note::}}'],
  ]);
  return createSecretMasker(bag);
}

/** An inventory configuration whose `Destination` is whatever the case supplies. */
function inventoryProps(destination: unknown): Record<string, unknown> {
  return {
    BucketName: BUCKET,
    InventoryConfigurations: [
      { Id: 'daily', Enabled: true, ScheduleFrequency: 'Daily', Destination: destination },
    ],
  };
}

/** An analytics configuration whose `Destination` is whatever the case supplies. */
function analyticsProps(destination: unknown): Record<string, unknown> {
  return {
    BucketName: BUCKET,
    AnalyticsConfigurations: [
      {
        Id: 'daily',
        StorageClassAnalysis: {
          DataExport: { OutputSchemaVersion: 'V_1', Destination: destination },
        },
      },
    ],
  };
}

async function refusalFrom(drive: () => Promise<unknown>): Promise<string> {
  try {
    await drive();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the destination-shape guard to refuse, but it did not');
}

/** Every warning the drive emitted, joined so a case can search across them. */
function warnings(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n---\n');
}

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

describe('create(): the destination refusal masks a resolved secret (issue #2178)', () => {
  it('masks the STRING branch, which is the one that goes through JSON.stringify', async () => {
    const message = await refusalFrom(() =>
      provider.create('B', RESOURCE_TYPE, inventoryProps(SECRET_PLAINTEXT), {
        maskSecrets: masker(),
      })
    );

    expect(message).toContain('must be an object');
    expect(message).toContain(`a string "${SECRET_MASK}"`);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks the same branch on the ANALYTICS applier, not only the inventory one', async () => {
    // The two appliers are separate methods that each thread the masker into
    // `resolveS3BucketDestination` on their own; a fix applied to one leaves
    // the other leaking, which is exactly how this class of gap survives.
    const message = await refusalFrom(() =>
      provider.create('B', RESOURCE_TYPE, analyticsProps(SECRET_PLAINTEXT), {
        maskSecrets: masker(),
      })
    );

    expect(message).toContain(`a string "${SECRET_MASK}"`);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks BEFORE the stringify, so an escapable secret is still caught', async () => {
    // The whole reason `.claude/rules/provider-masking.md` says PRE-stringify:
    // move the mask to the finished message and this case leaks while every
    // other one in this file still passes.
    const message = await refusalFrom(() =>
      provider.create('B', RESOURCE_TYPE, inventoryProps(SECRET_WITH_ESCAPES), {
        maskSecrets: masker(),
      })
    );

    expect(message).toContain(`a string "${SECRET_MASK}"`);
    expect(message).not.toContain('quoted');
  });

  it('masks KEY names, which the static critic cannot see (no JSON.stringify there)', async () => {
    const message = await refusalFrom(() =>
      provider.create('B', RESOURCE_TYPE, inventoryProps({ [SECRET_PLAINTEXT]: 'x' }), {
        maskSecrets: masker(),
      })
    );

    expect(message).toContain('carries neither a bucket');
    expect(message).toContain(`an object with keys [${SECRET_MASK}]`);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  it('CONTROL: with no masker on the context the value is still named verbatim', async () => {
    // Proves the masked cases above are not passing because the refusal
    // stopped quoting the value, and pins the back-compatible contract of the
    // identity default: absent masker means unmasked, not silently changed.
    const message = await refusalFrom(() =>
      provider.create('B', RESOURCE_TYPE, inventoryProps(SECRET_PLAINTEXT))
    );

    expect(message).toContain(`a string "${SECRET_PLAINTEXT}"`);
  });
});

describe('update(): the WARN-only twin of the same refusal is masked too', () => {
  it('masks the value in the warning the update path logs', async () => {
    // The update path never throws here — `rollback-executor.ts` and
    // `drift --revert` replay `update()` with a historical state record — so
    // the leak surface is the LOGGED line, a different sink reached through a
    // different call site of the same helper.
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      inventoryProps(SECRET_PLAINTEXT),
      { BucketName: BUCKET },
      { maskSecrets: masker() }
    );

    const logged = warnings();
    expect(logged).toContain('must be an object');
    expect(logged).toContain(`a string "${SECRET_MASK}"`);
    expect(logged).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks the ANALYTICS update warning as well', async () => {
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      analyticsProps(SECRET_PLAINTEXT),
      { BucketName: BUCKET },
      { maskSecrets: masker() }
    );

    const logged = warnings();
    expect(logged).toContain(`a string "${SECRET_MASK}"`);
    expect(logged).not.toContain(SECRET_PLAINTEXT);
  });

  it('CONTROL: with no masker on the context the warning still names the value', async () => {
    await provider.update('B', BUCKET, RESOURCE_TYPE, inventoryProps(SECRET_PLAINTEXT), {
      BucketName: BUCKET,
    });

    expect(warnings()).toContain(`a string "${SECRET_PLAINTEXT}"`);
  });
});
