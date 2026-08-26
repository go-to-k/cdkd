import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2178 — the RUNTIME twin of `scripts/check-provider-secret-mask.ts` for
 * `CloudWatchAnomalyDetectorProvider`.
 *
 * `toDate` quotes the offending `Configuration.ExcludedTimeRanges` member back
 * at the user, and `properties` arrives RESOLVED. The critic proves the
 * `maskDeep(...)` wrap is there; only a run proves the masker threaded through
 * `buildPutParams` into `toDate` is not the identity function.
 * `not.toContain(SECRET_PLAINTEXT)` is what an identity masker fails.
 */

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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

import { CloudWatchAnomalyDetectorProvider } from '../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::CloudWatch::AnomalyDetector';

/** Distinctive, >= 8 chars, and a substring of nothing else in the refusal. */
const SECRET_PLAINTEXT = 'cwanomaly2178-timerange-plaintext';

function maskSecrets(): (text: string) => string {
  const bag: RecordedSecretValues = new Map([
    [SECRET_PLAINTEXT, '{{resolve:secretsmanager:cw/range:SecretString:v::}}'],
  ]);
  return createSecretMasker(bag);
}

/** The secret at a NESTED string leaf, so the WALK is what has to find it. */
const NESTED_BAD = { nested: { bad: SECRET_PLAINTEXT } };
const MASKED_RENDERING = JSON.stringify({ nested: { bad: SECRET_MASK } });
const RAW_RENDERING = JSON.stringify({ nested: { bad: SECRET_PLAINTEXT } });

function detectorProps(startTime: unknown): Record<string, unknown> {
  return {
    Namespace: 'AWS/SQS',
    MetricName: 'NumberOfMessagesSent',
    Stat: 'Sum',
    Configuration: {
      ExcludedTimeRanges: [{ StartTime: startTime, EndTime: '2026-01-02T00:00:00Z' }],
    },
  };
}

async function refusalMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the ExcludedTimeRanges refusal, but the call resolved');
}

describe('CloudWatchAnomalyDetectorProvider masks the unparsable time value (issue #2178)', () => {
  let provider: CloudWatchAnomalyDetectorProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    provider = new CloudWatchAnomalyDetectorProvider();
  });

  it('masks the resolved secret in the create() refusal', async () => {
    const message = await refusalMessage(
      provider.create('Detector', TYPE, detectorProps(NESTED_BAD), { maskSecrets: maskSecrets() })
    );

    // Non-vacuity first: the refusal fired and still quotes the value.
    expect(message).toContain('unparsable time value');
    expect(message).toContain(MASKED_RENDERING);
    expect(message).toContain(SECRET_MASK);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks the resolved secret in the update() refusal', async () => {
    const message = await refusalMessage(
      provider.update('Detector', 'AWS/SQS:NumberOfMessagesSent:Sum', TYPE, detectorProps(NESTED_BAD), {}, {
        maskSecrets: maskSecrets(),
      })
    );

    expect(message).toContain('unparsable time value');
    expect(message).toContain(MASKED_RENDERING);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  // The EndTime arm reaches the same refusal through the second `toDate` call,
  // so a masker threaded to one of the pair only would still be caught.
  it('masks the resolved secret in the EndTime arm', async () => {
    const props = detectorProps('2026-01-01T00:00:00Z');
    (
      (props['Configuration'] as Record<string, unknown>)['ExcludedTimeRanges'] as Array<
        Record<string, unknown>
      >
    )[0]!['EndTime'] = NESTED_BAD;

    const message = await refusalMessage(
      provider.create('Detector', TYPE, props, { maskSecrets: maskSecrets() })
    );

    expect(message).toContain('unparsable time value');
    expect(message).toContain(MASKED_RENDERING);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  // THE CONTROL: absent context means unmasked, by contract — and without this
  // case a refusal that dropped the value would satisfy everything above.
  it('leaves the plaintext INTACT when no context is supplied — the control', async () => {
    const message = await refusalMessage(provider.create('Detector', TYPE, detectorProps(NESTED_BAD)));

    expect(message).toContain('unparsable time value');
    expect(message).toContain(RAW_RENDERING);
    expect(message).toContain(SECRET_PLAINTEXT);
    expect(message).not.toContain(SECRET_MASK);
  });

  it('leaves the plaintext INTACT for a context that carries no masker', async () => {
    const message = await refusalMessage(
      provider.create('Detector', TYPE, detectorProps(NESTED_BAD), { replayingState: true })
    );

    expect(message).toContain(SECRET_PLAINTEXT);
  });

  it('does not mangle a non-secret value when a masker IS supplied', async () => {
    const message = await refusalMessage(
      provider.create('Detector', TYPE, detectorProps({ nested: { bad: 'not-a-timestamp' } }), {
        maskSecrets: maskSecrets(),
      })
    );

    expect(message).toContain('not-a-timestamp');
    expect(message).not.toContain(SECRET_MASK);
  });
});
