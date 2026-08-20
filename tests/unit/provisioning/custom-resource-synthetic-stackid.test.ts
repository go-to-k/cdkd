import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Issue #1866: the synthetic `StackId` handed to every custom-resource handler
// was `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkd-<id>/cdkd`
// REGARDLESS of where the deploy ran — a coherent-looking ARN addressing
// nothing. CloudFormation-authored handlers read `event.StackId` to re-derive
// the account / region they are running in, so the value has to come from the
// real deploy context or it is worse than useless.
//
// What every case here asserts is the DISCRIMINATOR — the real account and the
// real region — never merely that a StackId is present, which the defect
// satisfied too.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn();

/**
 * The region the mocked client bag reports as EXPLICITLY configured, which is
 * what `cdkd deploy` pins per stack. `undefined` is the no-region-anywhere
 * case, where `getAccountInfo` falls back to `AWS_REGION`.
 */
let configuredRegion: string | undefined;

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
    get configuredRegion(): string | undefined {
      return configuredRegion;
    },
  }),
}));

const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Stack-CrHandler';

/** The value the OLD, fully fabricated builder produced, for every logical id. */
const FABRICATED_STACK_ID_PREFIX = 'arn:aws:cloudformation:us-east-1:000000000000:stack/cdkd-';

function wire(): void {
  mockS3Send.mockImplementation(() => Promise.resolve({}));
  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'InvokeCommand') {
      return Promise.resolve({
        Payload: Buffer.from(
          JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'phys-123', Data: {} })
        ),
      });
    }
    return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
  });
}

/** Every CFn request body the provider handed to `lambda:Invoke`, in order. */
function sentRequests(): Record<string, unknown>[] {
  return mockLambdaSend.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input?: { Payload?: string } })
    .filter((cmd) => cmd.constructor.name === 'InvokeCommand')
    .map((cmd) => JSON.parse(String(cmd.input?.Payload)) as Record<string, unknown>);
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({ responseBucket: 'test-bucket' });
}

describe('CustomResourceProvider synthetic StackId (issue #1866)', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalAccountEnv = process.env['AWS_ACCOUNT_ID'];

  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    mockStsSend.mockReset();
    warnSpy.mockReset();
    resetAccountInfoCache();
    configuredRegion = undefined;
    delete process.env['AWS_ACCOUNT_ID'];
    process.env['AWS_REGION'] = 'us-east-1';
    mockStsSend.mockImplementation(() => Promise.resolve({ Account: '111122223333' }));
    wire();
  });

  afterEach(() => {
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalAccountEnv === undefined) delete process.env['AWS_ACCOUNT_ID'];
    else process.env['AWS_ACCOUNT_ID'] = originalAccountEnv;
  });

  it('carries the REAL account and the stack region, not the fabricated pair', async () => {
    // THE discriminator, in both fields at once: the defect produced a
    // syntactically identical ARN, so only the VALUES tell the two apart.
    configuredRegion = 'ap-northeast-1';
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    expect(sentRequests()[0]?.['StackId']).toBe(
      'arn:aws:cloudformation:ap-northeast-1:111122223333:stack/cdkd-CrResource/cdkd'
    );
  });

  it('prefers the stack region the client bag was pinned to over the ambient one', async () => {
    // `cdkd deploy` builds a region-configured `AwsClients` per stack and, at
    // `--stack-concurrency > 1`, mutates AWS_REGION while siblings are in
    // flight — so the ambient value is the one that can belong to another
    // stack. The two are set to DIFFERENT regions here precisely so the
    // assertion can tell which was read.
    configuredRegion = 'eu-west-2';
    process.env['AWS_REGION'] = 'us-west-1';
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    expect(String(sentRequests()[0]?.['StackId'])).toContain(':eu-west-2:');
    expect(String(sentRequests()[0]?.['StackId'])).not.toContain('us-west-1');
  });

  it('falls back to the ambient region when nothing pinned one', async () => {
    process.env['AWS_REGION'] = 'sa-east-1';
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    expect(String(sentRequests()[0]?.['StackId'])).toContain(':sa-east-1:');
  });

  it('derives the PARTITION from the same region, never a mixed ARN', async () => {
    // Deriving one segment in isolation is worse than deriving none — an
    // `arn:aws-cn:...:us-east-1` is strictly less coherent than the uniform
    // fabrication it replaced. So the partition is asserted TOGETHER with the
    // region it was derived from.
    configuredRegion = 'cn-north-1';
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    expect(sentRequests()[0]?.['StackId']).toBe(
      'arn:aws-cn:cloudformation:cn-north-1:111122223333:stack/cdkd-CrResource/cdkd'
    );
  });

  it('hands the same real StackId to the update and delete requests', async () => {
    // All three request builders used to call the same fabricating helper, so
    // a fix wired into `create` alone would leave two handlers unchanged.
    configuredRegion = 'ap-northeast-1';
    const provider = makeProvider();

    await provider.update(
      'CrResource',
      'phys-123',
      'Custom::CrResource',
      { ServiceToken: SERVICE_TOKEN },
      { ServiceToken: SERVICE_TOKEN }
    );
    await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    const expected = 'arn:aws:cloudformation:ap-northeast-1:111122223333:stack/cdkd-CrResource/cdkd';
    const requests = sentRequests();
    expect(requests.map((r) => r['RequestType'])).toEqual(['Update', 'Delete']);
    expect(requests.map((r) => r['StackId'])).toEqual([expected, expected]);
  });

  it('never emits the old fabricated account/region pair', async () => {
    // Stated as its own case because the pair is exactly what a partial
    // revert re-introduces, and a per-field assertion elsewhere could still
    // pass while one half regressed.
    configuredRegion = 'ap-northeast-1';
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    const stackId = String(sentRequests()[0]?.['StackId']);
    expect(stackId.startsWith(FABRICATED_STACK_ID_PREFIX)).toBe(false);
    expect(stackId).not.toContain('000000000000');
  });

  it('falls back to the ALL-ZERO placeholder — not 123456789012 — when STS cannot answer', async () => {
    // `StackId` is a REQUIRED member of the request, so omission (the Cloud
    // Control enrichment answer) is unavailable. Between two wrong strings the
    // honest one is the one a handler cannot mistake for a live account:
    // `getAccountInfo`'s own fallback id is shaped exactly like a real one.
    mockStsSend.mockImplementation(() => Promise.reject(new Error('STS is unreachable')));
    configuredRegion = 'ap-northeast-1';
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    const stackId = String(sentRequests()[0]?.['StackId']);
    expect(stackId).toBe(
      'arn:aws:cloudformation:ap-northeast-1:000000000000:stack/cdkd-CrResource/cdkd'
    );
    expect(stackId).not.toContain('123456789012');
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'STS did not report this deploy'
    );
  });

  it('does not warn about a placeholder account when STS answered', async () => {
    // Polarity for the case above — a warning on every ordinary deploy would
    // train users to ignore the one that matters.
    configuredRegion = 'ap-northeast-1';
    const provider = makeProvider();

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'STS did not report this deploy'
    );
  });

  it('pins the region at CONSTRUCTION, so a mid-flight bag swap cannot leak in', async () => {
    // The stated rationale for capturing `configuredRegion` in the constructor
    // is `--stack-concurrency` (default 4): `cdkd deploy` swaps the
    // process-global `AwsClients` per stack while siblings are in flight, so a
    // CALL-TIME read can hand a sibling stack's region.
    //
    // Every other case here sets the region once, which makes the
    // constructor-captured and call-time readings IDENTICAL — so they all pass
    // against a call-time read and the rationale is unfenced (measured). This
    // case is the one that separates them: the bag's region CHANGES between
    // construction and the create.
    configuredRegion = 'eu-west-2';
    const provider = makeProvider();

    // ...another stack's deploy installs its own bag before this create runs.
    configuredRegion = 'us-west-1';

    await provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN });

    const stackId = String(sentRequests()[0]?.['StackId']);
    expect(stackId).toContain(':eu-west-2:');
    expect(stackId).not.toContain('us-west-1');
  });

  it('installs the SIGINT watch BEFORE the StackId resolution awaits', async () => {
    // Resolving the account needs an `await`, and every await that runs before
    // the invocation's SIGINT watch is installed is a window in which Ctrl-C is
    // dead — `docs/provider-development.md` requires a new wait site to be
    // interruptible, and the backoff this method guards is 47.75s long. Reading
    // the listener list SYNCHRONOUSLY is what pins the order: `create()` runs
    // to its FIRST await, so a resolution hoisted in front of the watch leaves
    // this empty.
    //
    // Deliberately NOT phrased as "resolve it once per call": `getAccountInfo`
    // memoizes, so a per-attempt resolution still issues one `GetCallerIdentity`
    // and a call-count assertion passes under the very edit this guards
    // against — measured, and it is why that case was replaced by this one.
    const baseline = process.listeners('SIGINT');
    configuredRegion = 'ap-northeast-1';
    const provider = makeProvider();

    const pending = provider.create('CrResource', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });
    const added = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
    await pending;

    expect(added).toHaveLength(1);
    expect(process.listeners('SIGINT')).toEqual(baseline);
  });
});
