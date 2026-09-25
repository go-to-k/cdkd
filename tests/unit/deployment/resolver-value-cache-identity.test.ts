import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * The resolver's VALUE caches are keyed by the credential identity as well
 * (issue [#3660](https://github.com/go-to-k/cdkd/issues/3660), the residual of
 * [#3588](https://github.com/go-to-k/cdkd/issues/3588)).
 *
 * A LIBRARY caller can install `AwsClients` for account A, resolve, then
 * install `AwsClients` for account B in the same process. Keyed by region or
 * expression alone, the process-wide account identity behind `getAccountInfo`,
 * the per-resolver `cachedDynamicReferences` and the process-wide
 * `cachedAvailabilityZones` served B the answer A's credentials had read.
 *
 * The real `AwsClients` is used, so the credentials a lookup client is BUILT
 * with are the real ones; only the leaf SDK classes are faked, and each fake
 * answers FROM the access key id it was constructed with. A value therefore
 * names the identity that read it, and a cache hit that crosses identities
 * shows up as the wrong value rather than as a call count alone.
 */

interface FakeCtorConfig {
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

const { sends, answers, makeFakeClientClass } = vi.hoisted(() => {
  /** Every `send`, with the access key id of the client that sent it. */
  const sends: Array<{ service: string; command: string; keyId: string | undefined }> = [];
  /**
   * Per (service, access key id) answer. A function so a test can hold a
   * response open (in-flight cases) or throw (fabricated-account cases).
   */
  const answers = new Map<string, (input: unknown) => Promise<unknown>>();
  const makeFakeClientClass = (service: string): unknown =>
    class {
      readonly ctorConfig: FakeCtorConfig;
      readonly config: { region: () => Promise<string> };
      constructor(ctorConfig: FakeCtorConfig = {}) {
        this.ctorConfig = ctorConfig;
        this.config = { region: () => Promise.resolve(ctorConfig.region ?? 'us-east-1') };
      }
      async send(command: { input?: unknown; constructor: { name: string } }): Promise<unknown> {
        const keyId = this.ctorConfig.credentials?.accessKeyId;
        sends.push({ service, command: command.constructor.name, keyId });
        const answer = answers.get(`${service}|${String(keyId)}`);
        if (!answer) throw new Error(`no ${service} answer primed for ${String(keyId)}`);
        return answer(command.input);
      }
      destroy(): void {}
    };
  return { sends, answers, makeFakeClientClass };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass('sts') };
});
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass('ssm') };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SecretsManagerClient: makeFakeClientClass('secretsmanager') };
});
vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, EC2Client: makeFakeClientClass('ec2') };
});

import {
  AwsClients,
  setAwsClients,
  resetAwsClients,
  runWithStackAwsClients,
} from '../../../src/utils/aws-clients.js';
import {
  clearRecoverableMaskedOutputs,
  recordRecoverableMaskedOutput,
  recoverMaskedOutput,
} from '../../../src/deployment/secret-redaction.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../../src/utils/ambient-client-defaults.js';
import {
  IntrinsicFunctionResolver,
  getAccountInfo,
  resetAccountInfoCache,
  accountInfoClock,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';

const REGION = 'us-east-1';
const A = { accessKeyId: 'AKIDVALUECACHEA3660', secretAccessKey: 'secret-a' };
const B = { accessKeyId: 'AKIDVALUECACHEB3660', secretAccessKey: 'secret-b' };
const ACCOUNT = { [A.accessKeyId]: '111111111111', [B.accessKeyId]: '222222222222' } as const;

const clientsFor = (credentials: typeof A): AwsClients =>
  new AwsClients({ region: REGION, credentials });

const emptyContext: ResolverContext = { template: { Resources: {} }, resources: {} };

function answer(service: string, credentials: typeof A, fn: (input: unknown) => unknown): void {
  answers.set(`${service}|${credentials.accessKeyId}`, async (input) => fn(input));
}

function primeSts(credentials: typeof A): void {
  answer('sts', credentials, () => ({ Account: ACCOUNT[credentials.accessKeyId] }));
}

const stsCalls = (): Array<string | undefined> =>
  sends.filter((s) => s.command === 'GetCallerIdentityCommand').map((s) => s.keyId);

describe('resolver value caches are keyed by credential identity (#3660)', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalAccountId = process.env['AWS_ACCOUNT_ID'];
  const realNow = accountInfoClock.now;
  let now = 1_000_000;

  beforeEach(() => {
    sends.length = 0;
    answers.clear();
    resetAccountInfoCache();
    process.env['AWS_REGION'] = REGION;
    delete process.env['AWS_ACCOUNT_ID'];
    now = 1_000_000;
    accountInfoClock.now = () => now;
  });

  afterEach(() => {
    resetAwsClients();
    resetAccountInfoCache();
    accountInfoClock.now = realNow;
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalAccountId === undefined) delete process.env['AWS_ACCOUNT_ID'];
    else process.env['AWS_ACCOUNT_ID'] = originalAccountId;
  });

  describe('account identity behind getAccountInfo', () => {
    it('A -> B -> A answers each identity its own account, asking STS once per identity', async () => {
      primeSts(A);
      primeSts(B);

      setAwsClients(clientsFor(A));
      const first = await getAccountInfo();
      setAwsClients(clientsFor(B));
      const second = await getAccountInfo();
      setAwsClients(clientsFor(A));
      const third = await getAccountInfo();

      expect([first.accountId, second.accountId, third.accountId]).toEqual([
        ACCOUNT[A.accessKeyId],
        ACCOUNT[B.accessKeyId],
        ACCOUNT[A.accessKeyId],
      ]);
      expect(stsCalls()).toEqual([A.accessKeyId, B.accessKeyId]);
    });

    it('keys on the stack scope, not only on the process-global clients', async () => {
      primeSts(A);
      primeSts(B);
      setAwsClients(clientsFor(A));

      const scoped = await runWithStackAwsClients(clientsFor(B), () => getAccountInfo());
      const global = await getAccountInfo();

      expect(scoped.accountId).toBe(ACCOUNT[B.accessKeyId]);
      expect(global.accountId).toBe(ACCOUNT[A.accessKeyId]);
    });

    it('resolves AWS::AccountId per identity through one resolver', async () => {
      primeSts(A);
      primeSts(B);
      const resolver = new IntrinsicFunctionResolver(REGION);
      const accountId = { Ref: 'AWS::AccountId' };

      const underA = await runWithStackAwsClients(clientsFor(A), () =>
        resolver.resolve(accountId, emptyContext)
      );
      const underB = await runWithStackAwsClients(clientsFor(B), () =>
        resolver.resolve(accountId, emptyContext)
      );

      expect([underA, underB]).toEqual([ACCOUNT[A.accessKeyId], ACCOUNT[B.accessKeyId]]);
    });

    it('keeps the fabricated-answer window per identity, and still expires it (#1730)', async () => {
      answer('sts', A, () => {
        throw new Error('sts down for A');
      });
      primeSts(B);

      setAwsClients(clientsFor(A));
      const fabricatedA = await getAccountInfo();
      expect(fabricatedA.fabricated).toBe(true);

      // B is not answered from A's fabricated window: it asks STS and caches a real answer.
      setAwsClients(clientsFor(B));
      const realB = await getAccountInfo();
      expect(realB).toMatchObject({ accountId: ACCOUNT[B.accessKeyId] });
      expect(realB.fabricated).toBeUndefined();

      // A inside its window: still fabricated, no new STS call.
      setAwsClients(clientsFor(A));
      expect((await getAccountInfo()).fabricated).toBe(true);
      expect(stsCalls()).toEqual([A.accessKeyId, B.accessKeyId]);

      // B's real answer did not end A's window, and A's window did not
      // shadow B's cache: B is still served without a call.
      setAwsClients(clientsFor(B));
      expect((await getAccountInfo()).accountId).toBe(ACCOUNT[B.accessKeyId]);
      expect(stsCalls()).toEqual([A.accessKeyId, B.accessKeyId]);

      // Past the TTL A re-asks, heals, and caches its real answer.
      now += 10_001;
      primeSts(A);
      setAwsClients(clientsFor(A));
      const healedA = await getAccountInfo();
      expect(healedA).toMatchObject({ accountId: ACCOUNT[A.accessKeyId] });
      expect(healedA.fabricated).toBeUndefined();
      expect(stsCalls()).toEqual([A.accessKeyId, B.accessKeyId, A.accessKeyId]);
    });

    it('files an operator AWS_ACCOUNT_ID fallback under the identity whose STS call failed', async () => {
      // The catch arm's non-fabricated branch: STS failed for A, and the
      // operator-supplied id is cached as A's REAL answer. It must be A's
      // alone, or B would never ask STS for its own account.
      process.env['AWS_ACCOUNT_ID'] = '333333333333';
      answer('sts', A, () => {
        throw new Error('sts down for A');
      });
      primeSts(B);

      setAwsClients(clientsFor(A));
      const fallbackA = await getAccountInfo();
      expect(fallbackA.accountId).toBe('333333333333');
      expect(fallbackA.fabricated).toBeUndefined();

      setAwsClients(clientsFor(B));
      expect((await getAccountInfo()).accountId).toBe(ACCOUNT[B.accessKeyId]);

      // A is served its cached fallback without a second call.
      setAwsClients(clientsFor(A));
      expect((await getAccountInfo()).accountId).toBe('333333333333');
      expect(stsCalls()).toEqual([A.accessKeyId, B.accessKeyId]);
    });

    it("opens A's fabricated window even while B holds a real cached answer", async () => {
      // The catch arm refuses to open a window over a real answer, and that
      // check is per identity: B's cached account must not stop A's window,
      // or every A caller re-issues GetCallerIdentity for the whole outage.
      primeSts(B);
      answer('sts', A, () => {
        throw new Error('sts down for A');
      });

      setAwsClients(clientsFor(B));
      await getAccountInfo();
      setAwsClients(clientsFor(A));
      expect((await getAccountInfo()).fabricated).toBe(true);
      expect((await getAccountInfo()).fabricated).toBe(true);

      expect(stsCalls()).toEqual([B.accessKeyId, A.accessKeyId]);
    });

    it('shares one in-flight lookup within an identity, never across identities', async () => {
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => {
        releaseA = r;
      });
      answer('sts', A, async () => {
        await gateA;
        return { Account: ACCOUNT[A.accessKeyId] };
      });
      primeSts(B);

      const a1 = runWithStackAwsClients(clientsFor(A), () => getAccountInfo());
      const a2 = runWithStackAwsClients(clientsFor(A), () => getAccountInfo());
      // B's lookup must not join A's pending promise.
      const b = await runWithStackAwsClients(clientsFor(B), () => getAccountInfo());
      expect(b.accountId).toBe(ACCOUNT[B.accessKeyId]);

      releaseA();
      const [ra1, ra2] = await Promise.all([a1, a2]);
      expect([ra1.accountId, ra2.accountId]).toEqual([
        ACCOUNT[A.accessKeyId],
        ACCOUNT[A.accessKeyId],
      ]);
      expect(stsCalls()).toEqual([A.accessKeyId, B.accessKeyId]);
    });

    it('a reset while a lookup is in flight still keeps that lookup out of the cache', async () => {
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => {
        releaseA = r;
      });
      let call = 0;
      answer('sts', A, async () => {
        call += 1;
        if (call === 1) {
          await gateA;
          return { Account: '999999999999' };
        }
        return { Account: ACCOUNT[A.accessKeyId] };
      });
      setAwsClients(clientsFor(A));

      const pending = getAccountInfo();
      resetAccountInfoCache();
      releaseA();
      expect((await pending).accountId).toBe('999999999999');

      // The pre-reset answer was not written: the next call asks again.
      expect((await getAccountInfo()).accountId).toBe(ACCOUNT[A.accessKeyId]);
      expect(call).toBe(2);
    });
  });

  describe('cachedDynamicReferences', () => {
    it('one resolver never serves one identity a value another identity read (A -> B -> A)', async () => {
      primeSts(A);
      primeSts(B);
      answer('ssm', A, () => ({ Parameter: { Value: 'value-read-by-a', Type: 'String' } }));
      answer('ssm', B, () => ({ Parameter: { Value: 'value-read-by-b', Type: 'String' } }));
      const resolver = new IntrinsicFunctionResolver(REGION);
      const expression = '{{resolve:ssm:/shared/config}}';
      const lookup = (credentials: typeof A): Promise<unknown> =>
        runWithStackAwsClients(clientsFor(credentials), () =>
          resolver.resolveDynamicReferences(expression, emptyContext)
        );

      const results = [await lookup(A), await lookup(B), await lookup(A)];

      expect(results).toEqual(['value-read-by-a', 'value-read-by-b', 'value-read-by-a']);
      // A's second lookup is a cache hit: two GetParameter calls, one per identity.
      expect(sends.filter((s) => s.service === 'ssm').map((s) => s.keyId)).toEqual([
        A.accessKeyId,
        B.accessKeyId,
      ]);
    });

    it('keys a secretsmanager value by identity too', async () => {
      answer('secretsmanager', A, () => ({ SecretString: 'secret-read-by-a' }));
      answer('secretsmanager', B, () => ({ SecretString: 'secret-read-by-b' }));
      const resolver = new IntrinsicFunctionResolver(REGION);
      const expression = '{{resolve:secretsmanager:shared/db:SecretString}}';
      const lookup = (credentials: typeof A): Promise<unknown> =>
        runWithStackAwsClients(clientsFor(credentials), () =>
          resolver.resolveDynamicReferences(expression, emptyContext)
        );

      const results = [await lookup(A), await lookup(B), await lookup(A)];

      expect(results).toEqual(['secret-read-by-a', 'secret-read-by-b', 'secret-read-by-a']);
      expect(sends.filter((s) => s.service === 'secretsmanager').map((s) => s.keyId)).toEqual([
        A.accessKeyId,
        B.accessKeyId,
      ]);
    });
  });

  describe('cachedAvailabilityZones', () => {
    it('answers each identity the zone list its own credentials read', async () => {
      primeSts(A);
      primeSts(B);
      answer('ec2', A, () => ({
        AvailabilityZones: [{ ZoneName: 'us-east-1a' }, { ZoneName: 'us-east-1b' }],
      }));
      answer('ec2', B, () => ({
        AvailabilityZones: [{ ZoneName: 'us-east-1a' }, { ZoneName: 'us-east-1f' }],
      }));
      const resolver = new IntrinsicFunctionResolver(REGION);
      const getAzs = (credentials: typeof A): Promise<unknown> =>
        runWithStackAwsClients(clientsFor(credentials), () =>
          resolver.resolve({ 'Fn::GetAZs': REGION }, emptyContext)
        );

      const results = [await getAzs(A), await getAzs(B), await getAzs(A)];

      expect(results).toEqual([
        ['us-east-1a', 'us-east-1b'],
        ['us-east-1a', 'us-east-1f'],
        ['us-east-1a', 'us-east-1b'],
      ]);
      expect(sends.filter((s) => s.service === 'ec2').map((s) => s.keyId)).toEqual([
        A.accessKeyId,
        B.accessKeyId,
      ]);
    });
  });

  describe('the masked-output recovery store (#3691)', () => {
    // Its writer and readers key it by `credentialFingerprint(ambientCredentialConfig())`.
    // This pins the part the unit files with MOCKED clients cannot: that the
    // fingerprint read from REAL `AwsClients` tells A from B, including inside a
    // per-stack scope, so B's same-named producer misses A's plaintext.
    afterEach(() => clearRecoverableMaskedOutputs());
    const ambient = (): string => credentialFingerprint(ambientCredentialConfig());

    it('A records, B misses, A (and a stack scoped to A) recovers', async () => {
      setAwsClients(clientsFor(A));
      recordRecoverableMaskedOutput(ambient(), 'Producer', REGION, 'Token', 'plaintext-of-a');
      expect(recoverMaskedOutput(ambient(), 'Producer', REGION, 'Token')).toBe('plaintext-of-a');

      setAwsClients(clientsFor(B));
      expect(recoverMaskedOutput(ambient(), 'Producer', REGION, 'Token')).toBeUndefined();

      const scoped = await runWithStackAwsClients(clientsFor(A), () =>
        Promise.resolve(recoverMaskedOutput(ambient(), 'Producer', REGION, 'Token'))
      );
      expect(scoped).toBe('plaintext-of-a');
    });
  });
});
