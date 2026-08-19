import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #1997: `waitForTargetGroupArnsConvergence`'s timeout warning
// interpolates the EXPECTED `TargetGroupARNs` set — a RESOLVED property value —
// straight into `logger.warn`. cdkd's secret masking lives at the deploy engine
// (error / reason text) and the resolver's debug line only, so a
// `{{resolve:secretsmanager:...}}` scalar reaching it printed in plaintext. The
// provider now masks through the `maskSecrets` capability its caller puts on
// `UpdateContext` (the contract issue #1932 item 3 added).
//
// The ASG create path deliberately takes NO masker: it forwards
// `TargetGroupARNs` straight to `CreateAutoScalingGroup` and every line it logs
// names only the logical id and the generated group name, so there is no site
// to mask. That is asserted below rather than left implicit, so a create-path
// warning added later without threading the capability is visible.

const mockSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
      '@aws-sdk/client-auto-scaling'
    );
  return {
    ...actual,
    AutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const warned: string[] = [];
const debugged: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn((message: string) => {
      debugged.push(message);
    }),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
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

import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Grepped against the whole tree before being invented, so it cannot coincide
// with another suite's assertion needle.
const SECRET_TG_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/issue1997-asg-tg-plaintext/abc';
const SECRET_EXPR = '{{resolve:secretsmanager:asg/tg:SecretString:v::}}';

function secretBag(): RecordedSecretValues {
  return new Map([[SECRET_TG_ARN, SECRET_EXPR]]);
}

const log = (): string => warned.join('\n');

/**
 * Drive the update path to the convergence TIMEOUT, which is the only arm that
 * warns. `DescribeAutoScalingGroups` is answered with an EMPTY `TargetGroupARNs`
 * list, so the expected set never matches the observed one and the poll runs to
 * its 30s deadline — collapsed here by a fake clock, since the real one would
 * make this suite a 30-second test.
 */
function primeNonConvergingUpdate(): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
      return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: [] }] });
    }
    return Promise.resolve({});
  });
}

describe('ASGProvider - resolved secrets in the TargetGroupARNs convergence warning (issue #1997)', () => {
  let provider: ASGProvider;
  let now: number;

  beforeEach(() => {
    vi.clearAllMocks();
    warned.length = 0;
    debugged.length = 0;
    provider = new ASGProvider();
    // The convergence poll is deadline-driven (`Date.now()` vs a 30s budget)
    // and sleeps a second between attempts. Both are faked so the timeout arm
    // is reached immediately; without this the suite would take 30s per case
    // and would be the first thing a future author deletes.
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // Advance past the 30s budget on the SECOND read, so the loop body runs
      // exactly once (issuing one describe) and then times out. Advancing on
      // the first read would skip the body entirely and `lastObserved` would
      // stay empty for a different reason than the one under test.
      const t = now;
      now += 20_000;
      return t;
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  });

  async function runUpdate(context?: Parameters<ASGProvider['update']>[5]): Promise<void> {
    primeNonConvergingUpdate();
    await provider.update(
      'MyAsg',
      'issue1997-asg',
      'AWS::AutoScaling::AutoScalingGroup',
      { TargetGroupARNs: [SECRET_TG_ARN] },
      { TargetGroupARNs: [] },
      context
    );
  }

  it('masks a resolved secret in the expected TargetGroupARNs set', async () => {
    await runUpdate({ maskSecrets: createSecretMasker(secretBag()) });

    // Non-vacuity: the warning DID fire, so the assertions below are about
    // masking rather than about an absent message.
    expect(log()).toContain('did not converge');
    expect(log()).not.toContain(SECRET_TG_ARN);
    expect(log()).toContain(SECRET_MASK);
  });

  // THE realistic secret shape, and the case a message-only mask cannot reach
  // at any length: the ARNs go through `JSON.stringify`, which escapes `"` /
  // `\` / newlines, so the needle no longer OCCURS in the finished line and the
  // sink's SUBSTRING scan finds nothing. Removing the per-ARN `.map(maskSecrets)`
  // while keeping the sink leaves this the failing test.
  it('masks a secret that JSON escaping would otherwise hide', async () => {
    const ESCAPED = 'arn:aws:x:::tg/a"b-issue1997-asg-escaped';
    const bag: RecordedSecretValues = new Map([
      [ESCAPED, '{{resolve:secretsmanager:asg/doc:SecretString:v::}}'],
    ]);

    primeNonConvergingUpdate();
    await provider.update(
      'MyAsg',
      'issue1997-asg',
      'AWS::AutoScaling::AutoScalingGroup',
      { TargetGroupARNs: [ESCAPED] },
      { TargetGroupARNs: [] },
      { maskSecrets: createSecretMasker(bag) }
    );

    expect(log()).toContain('did not converge');
    // The ESCAPED rendering is what actually leaked, so asserting only the raw
    // form would pass on the broken code.
    expect(log()).not.toContain(ESCAPED);
    expect(log()).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
    expect(log()).toContain(SECRET_MASK);
  });

  // The needle floor: `maskSecretsInText` masks an exact WHOLE-VALUE match at
  // ANY length but only scans for SUBSTRING needles of >= 4 characters, and a
  // finished message is always longer than the value inside it.
  it('masks a SHORT secret, which only the value-level pass can reach', async () => {
    const SHORT = 'jd4';
    const bag: RecordedSecretValues = new Map([
      [SHORT, '{{resolve:secretsmanager:asg/pin:SecretString:v::}}'],
    ]);

    primeNonConvergingUpdate();
    await provider.update(
      'MyAsg',
      'issue1997-asg',
      'AWS::AutoScaling::AutoScalingGroup',
      { TargetGroupARNs: [SHORT] },
      { TargetGroupARNs: [] },
      { maskSecrets: createSecretMasker(bag) }
    );

    expect(log()).toContain('did not converge');
    // Asserted as the QUOTED form so three characters cannot match
    // incidentally inside another word in the message.
    expect(log()).not.toContain(`"${SHORT}"`);
    expect(log()).toContain(`"${SECRET_MASK}"`);
  });

  // Back-compat: absent means unmasked, which is what lets the contract be
  // optional. It also fences the opposite failure — a "fix" that swallowed the
  // value unconditionally.
  it('leaves the warning unmasked when the caller passes no context', async () => {
    await runUpdate();

    expect(log()).toContain('did not converge');
    expect(log()).toContain(SECRET_TG_ARN);
    expect(log()).not.toContain(SECRET_MASK);
  });

  it('does not mangle a non-secret ARN when a masker IS supplied', async () => {
    const PUBLIC_ARN = 'arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/plain-public-tg/abc';

    primeNonConvergingUpdate();
    await provider.update(
      'MyAsg',
      'issue1997-asg',
      'AWS::AutoScaling::AutoScalingGroup',
      { TargetGroupARNs: [PUBLIC_ARN] },
      { TargetGroupARNs: [] },
      { maskSecrets: createSecretMasker(secretBag()) }
    );

    expect(log()).toContain(PUBLIC_ARN);
    expect(log()).not.toContain(SECRET_MASK);
  });

  // A context WITHOUT `maskSecrets` must not throw.
  it('does not throw for a context that carries no masker', async () => {
    primeNonConvergingUpdate();
    await expect(
      provider.update(
        'MyAsg',
        'issue1997-asg',
        'AWS::AutoScaling::AutoScalingGroup',
        { TargetGroupARNs: [SECRET_TG_ARN] },
        { TargetGroupARNs: [] },
        { desiredFromAwsReadback: true }
      )
    ).resolves.toBeDefined();
    expect(log()).toContain('did not converge');
  });

  // The WARN sink's own arm. Found by a MUTATION PROBE, not by review: reverting
  // the warn sink to a bare `this.logger.warn(message)` left the whole suite
  // GREEN, because every other case here puts its secret in the ARN list, which
  // the per-ARN `.map(maskSecrets)` masks on its own. The line ALSO interpolates
  // `physicalId` — which for this type IS a resolved property value, since an
  // ASG's physical id is its `AutoScalingGroupName` — and nothing but the sink
  // covers that position.
  it('masks a resolved secret in the ASG name, which only the sink covers', async () => {
    const SECRET_NAME = 'issue1997-asg-name-plaintext';
    const bag: RecordedSecretValues = new Map([
      [SECRET_NAME, '{{resolve:secretsmanager:asg/name:SecretString:v::}}'],
    ]);

    primeNonConvergingUpdate();
    await provider.update(
      'MyAsg',
      SECRET_NAME,
      'AWS::AutoScaling::AutoScalingGroup',
      // A PUBLIC target-group ARN, deliberately: with a secret one the per-ARN
      // mask would also fire and the case would stop discriminating the sink.
      { TargetGroupARNs: ['arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/public/abc'] },
      { TargetGroupARNs: [] },
      { maskSecrets: createSecretMasker(bag) }
    );

    expect(log()).toContain('did not converge');
    expect(log()).not.toContain(SECRET_NAME);
    expect(log()).toContain(SECRET_MASK);
  });

  // The SINK's own arm, and the one place in this provider where the two
  // masking layers are NOT redundant. The per-ARN `.map(maskSecrets)` covers
  // the expected / observed lists, but the convergence poll ALSO logs the AWS
  // error text of a transient describe failure — text this provider never
  // walks, and which AWS routinely builds by quoting the offending value back.
  // Only the sink can reach it. Reverting the `debug` sink to a bare
  // `this.logger.debug(message)` leaves this the only failing test.
  it('masks a resolved secret quoted back inside a transient poll error', async () => {
    const SECRET_IN_ERROR = 'issue1997-asg-error-plaintext';
    const bag: RecordedSecretValues = new Map([
      [SECRET_IN_ERROR, '{{resolve:secretsmanager:asg/err:SecretString:v::}}'],
    ]);

    let describes = 0;
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
        describes += 1;
        // The FIRST poll fails transiently — that is the arm that logs the AWS
        // message — and every later one answers non-convergent so the loop
        // still reaches its timeout instead of returning early.
        if (describes === 1) {
          return Promise.reject(new Error(`Throttled while reading ${SECRET_IN_ERROR}`));
        }
        return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: [] }] });
      }
      return Promise.resolve({});
    });

    await provider.update(
      'MyAsg',
      'issue1997-asg',
      'AWS::AutoScaling::AutoScalingGroup',
      { TargetGroupARNs: [SECRET_TG_ARN] },
      { TargetGroupARNs: [] },
      { maskSecrets: createSecretMasker(bag) }
    );

    const debugLog = debugged.join('\n');
    // Non-vacuity: the transient arm DID fire.
    expect(debugLog).toContain('transient error, retrying');
    expect(debugLog).not.toContain(SECRET_IN_ERROR);
    expect(debugLog).toContain(SECRET_MASK);
  });

  // The create path. An earlier revision of this suite asserted only that
  // create() emits no WARNING, and read that as "there is no site to mask" —
  // which was wrong: `groupName` falls back to a generated name only when
  // `AutoScalingGroupName` is ABSENT, so a DECLARED name is a resolved property
  // value, and it is interpolated into a debug line. These two cases fence the
  // masker that now covers it.
  describe('create path', () => {
    const CREATE_PROPS = (name: string): Record<string, unknown> => ({
      AutoScalingGroupName: name,
      MinSize: '1',
      MaxSize: '1',
      LaunchTemplate: { LaunchTemplateId: 'lt-issue1997', Version: '1' },
      AvailabilityZones: ['us-east-1a'],
    });

    beforeEach(() => {
      mockSend.mockResolvedValue({});
      mockEc2Send.mockResolvedValue({});
    });

    it('masks a DECLARED AutoScalingGroupName in the create debug line', async () => {
      const SECRET_NAME = 'issue1997-asg-declared-name';
      const bag: RecordedSecretValues = new Map([
        [SECRET_NAME, '{{resolve:secretsmanager:asg/create:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyAsg',
        'AWS::AutoScaling::AutoScalingGroup',
        CREATE_PROPS(SECRET_NAME),
        { maskSecrets: createSecretMasker(bag) }
      );

      const debugLog = debugged.join('\n');
      // Non-vacuity: the line DID fire.
      expect(debugLog).toContain('Creating AutoScalingGroup');
      expect(debugLog).not.toContain(SECRET_NAME);
      expect(debugLog).toContain(SECRET_MASK);
    });

    // Below the 4-character needle floor, so only the whole-value mask on
    // `groupName` can reach it — the sink's substring scan cannot.
    it('masks a SHORT declared name, which only the value-level pass can reach', async () => {
      const SHORT = 'ag2';
      const bag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:asg/shortname:SecretString:v::}}'],
      ]);

      await provider.create('MyAsg', 'AWS::AutoScaling::AutoScalingGroup', CREATE_PROPS(SHORT), {
        maskSecrets: createSecretMasker(bag),
      });

      const debugLog = debugged.join('\n');
      expect(debugLog).toContain('Creating AutoScalingGroup');
      expect(debugLog).not.toContain(`: ${SHORT}`);
      expect(debugLog).toContain(`: ${SECRET_MASK}`);
    });

    it('leaves the create debug line unmasked when no context is passed', async () => {
      const NAME = 'issue1997-asg-declared-name';
      await provider.create('MyAsg', 'AWS::AutoScaling::AutoScalingGroup', CREATE_PROPS(NAME));

      const debugLog = debugged.join('\n');
      expect(debugLog).toContain('Creating AutoScalingGroup');
      expect(debugLog).toContain(NAME);
      expect(debugLog).not.toContain(SECRET_MASK);
    });

    // Still true and still worth pinning: the create path emits no WARNING, so
    // a create-side warning added later that names a property value shows up
    // here rather than shipping unmasked.
    it('emits no warning on the create path', async () => {
      await provider.create(
        'MyAsg',
        'AWS::AutoScaling::AutoScalingGroup',
        CREATE_PROPS('issue1997-asg')
      );

      expect(warned).toEqual([]);
    });
  });
});
