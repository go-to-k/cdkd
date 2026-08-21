import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Re-resolution of a REDACTED cross-stack value (issue
 * [#1934](https://github.com/go-to-k/cdkd/issues/1934)).
 *
 * Since PR #1899 a secret-bearing output is persisted as its
 * `{{resolve:secretsmanager:...}}` EXPRESSION, so a consumer resolving
 * `Fn::ImportValue` / `Fn::GetStackOutput` used to get that string back
 * verbatim and ship the literal token to AWS as a property value.
 *
 * WHY THIS FILE MOCKS THE SDK RATHER THAN `getAwsClients()`, same as its
 * sibling `dynamic-reference-region-scoped-clients.test.ts`: half of what this
 * change decides is WHICH REGION resolves the producer's expression, and a
 * plain-object `getAwsClients()` fake has no region, so that is not a question
 * it can be asked. The real `AwsClients` is used and only the leaf SDK client
 * classes are faked, with the constructor config as the assertion target.
 *
 * Responses are primed per (REGION, COMMAND) rather than with
 * `mockResolvedValueOnce`, so there is no `*Once` queue a test could leave
 * undrained.
 */

interface FakeClientConfig {
  region?: string;
  profile?: string;
}

interface FakeSend {
  /** The region the sending client was CONSTRUCTED with — the discriminator. */
  ctorRegion: string | undefined;
  region: string | undefined;
  command: string;
  input: unknown;
}

const { responses, secretsInstances, secretSends, ssmSends, cfnSends, makeFakeClientClass } =
  vi.hoisted(() => {
    const responses = new Map<string, unknown>();

    const makeFakeClientClass = (
      instances: { ctorConfig: FakeClientConfig }[],
      sends: FakeSend[],
      serviceLabel: string
    ): unknown =>
      class {
        readonly ctorConfig: FakeClientConfig;
        readonly config: { region: () => Promise<string> };
        private resolved?: Promise<string>;

        constructor(ctorConfig: FakeClientConfig = {}) {
          this.ctorConfig = ctorConfig;
          this.config = { region: () => this.resolveRegion() };
          instances.push(this);
        }

        private resolveRegion(): Promise<string> {
          if (!this.resolved) {
            const region = this.ctorConfig.region || process.env['AWS_REGION'];
            this.resolved = region
              ? Promise.resolve(region)
              : Promise.reject(new Error('Region is missing'));
          }
          return this.resolved;
        }

        async send(command: { input?: unknown; constructor: { name: string } }): Promise<unknown> {
          let region: string | undefined;
          try {
            region = await this.resolveRegion();
          } catch {
            region = undefined;
          }
          const name = command.constructor.name;
          sends.push({ ctorRegion: this.ctorConfig.region, region, command: name, input: command.input });
          const response = responses.get(`${String(region)}|${name}`);
          if (response === undefined) {
            throw new Error(`no ${serviceLabel} response primed for ${String(region)}|${name}`);
          }
          return response;
        }
        destroy(): void {}
      };

    return {
      responses,
      secretsInstances: [] as { ctorConfig: FakeClientConfig }[],
      secretSends: [] as FakeSend[],
      ssmSends: [] as FakeSend[],
      cfnSends: [] as FakeSend[],
      makeFakeClientClass,
    };
  });

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretsInstances, secretSends, 'secretsmanager'),
  };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    CloudFormationClient: makeFakeClientClass([], cfnSends, 'cloudformation'),
  };
});

// Captures what the resolver LOGS. The ordering of the log line against the
// re-resolution is what keeps this fix from becoming a disclosure, and it was
// carried by a code comment alone ("Never move it after the call below").
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logLines.push(`${level} ${args.map(String).join(' ')}`);
    };
  const child = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (): unknown => child,
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass([], ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], [], 'sts') };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StateImportEntry } from '../../../src/types/state.js';

const CONSUMER_REGION = 'ap-northeast-1';
const PRODUCER_REGION = 'eu-west-1';
const PROFILE = 'cdkd-lane-1934';

/**
 * The producer's OWN spelling of the reference, i.e. exactly what PR #1899
 * persists into `state.outputs` / the exports index for a secret-bearing
 * output.
 */
const SECRET_EXPRESSION = '{{resolve:secretsmanager:prod/db/cred:SecretString:password}}';
const PRODUCER_REGION_PASSWORD = 'ireland-password-1934';
const CONSUMER_REGION_PASSWORD = 'tokyo-password-1934';

function prime(region: string, command: string, response: unknown): void {
  responses.set(`${region}|${command}`, response);
}

/** Exports-index double carrying the surface the resolver consults. */
function mockIndex(
  hits: Record<string, { value: unknown; producerStack: string; producerRegion: string }>
): ExportIndexStore {
  return {
    lookup: vi.fn(async (name: string) => hits[name]),
    patchEntry: vi.fn(async () => undefined),
  } as unknown as ExportIndexStore;
}

/** State-backend double for the index-miss scan and for Fn::GetStackOutput. */
function mockBackend(
  stacks: Array<{ stackName: string; region: string; outputs: Record<string, unknown> }>
): S3StateBackend {
  return {
    listStacks: vi.fn(async () => stacks.map((s) => ({ stackName: s.stackName, region: s.region }))),
    getState: vi.fn(async (stackName: string, region: string) => {
      const found = stacks.find((s) => s.stackName === stackName && s.region === region);
      if (!found) return null;
      return {
        state: {
          version: 8,
          stackName: found.stackName,
          region: found.region,
          resources: {},
          outputs: found.outputs,
          lastModified: 1,
        },
        etag: 'e',
      };
    }),
  } as unknown as S3StateBackend;
}

function buildContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    template: { Resources: {} },
    resources: {},
    stackName: 'Consumer',
    ...overrides,
  };
}

describe('cross-stack reads re-resolve a REDACTED value (issue #1934)', () => {
  let savedRegion: string | undefined;

  beforeEach(() => {
    savedRegion = process.env['AWS_REGION'];
    delete process.env['AWS_REGION'];
    responses.clear();
    secretsInstances.length = 0;
    secretSends.length = 0;
    cfnSends.length = 0;
    ssmSends.length = 0;
    logLines.length = 0;
    resetAccountInfoCache();
    setAwsClients(new AwsClients({ region: CONSUMER_REGION, profile: PROFILE }));
    // Two regions holding DIFFERENT values behind the SAME reference — the
    // ordinary Secrets Manager reality (a secret NAME is regional), and what
    // makes "which region answered" observable.
    prime(PRODUCER_REGION, 'GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: PRODUCER_REGION_PASSWORD }),
    });
    prime(CONSUMER_REGION, 'GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: CONSUMER_REGION_PASSWORD }),
    });
  });

  afterEach(() => {
    resetAwsClients();
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  describe('Fn::ImportValue', () => {
    it('hands the consumer the RESOLVED secret, not the stored {{resolve:...}} token', async () => {
      // THE bug: `entry.value` was returned verbatim, so the consumer stack
      // shipped the literal expression to AWS as the property value.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbPassword' },
        buildContext({
          exportIndex: mockIndex({
            DbPassword: {
              value: SECRET_EXPRESSION,
              producerStack: 'Producer',
              producerRegion: CONSUMER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
          recordedSecretValues,
          recordedImports: [] as StateImportEntry[],
        })
      );

      expect(result).toBe(CONSUMER_REGION_PASSWORD);
      // ...and the consumer's OWN state stays redacted: the plaintext is
      // recorded against its expression, which is what the deploy engine's save
      // choke point rewrites it back to.
      expect(recordedSecretValues.get(CONSUMER_REGION_PASSWORD)).toBe(SECRET_EXPRESSION);
    });

    it('resolves it in the PRODUCER region, not the consumer region', async () => {
      // A secret NAME is regional, so the only region whose answer reproduces
      // what the producer exported is the producer's own — recorded on the
      // index entry. A fix that reached for the consumer's region instead
      // would return the tokyo value here and still look green on the test
      // above.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbPassword' },
        buildContext({
          exportIndex: mockIndex({
            DbPassword: {
              value: SECRET_EXPRESSION,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
        })
      );

      expect(result).toBe(PRODUCER_REGION_PASSWORD);
      // The DISCRIMINATOR: which client was constructed, and with what region.
      expect(secretSends).toHaveLength(1);
      expect(secretSends[0]?.ctorRegion).toBe(PRODUCER_REGION);
      expect(secretsInstances).toHaveLength(1);
      expect(secretsInstances[0]?.ctorConfig).toEqual({
        region: PRODUCER_REGION,
        profile: PROFILE,
      });
    });

    it('re-resolves on the index-MISS state.json scan path too', async () => {
      // The two arms return through different statements, so one being fixed
      // says nothing about the other.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbPassword' },
        buildContext({
          stateBackend: mockBackend([
            {
              stackName: 'Producer',
              region: PRODUCER_REGION,
              outputs: { DbPassword: SECRET_EXPRESSION },
            },
          ]),
        })
      );

      expect(result).toBe(PRODUCER_REGION_PASSWORD);
      expect(secretSends[0]?.ctorRegion).toBe(PRODUCER_REGION);
    });

    it('returns an ORDINARY imported value BY IDENTITY, with no lookup at all', async () => {
      // The identity fast path: an import carrying no `{{resolve:` must behave
      // exactly as it did before this change.
      //
      // Asserted with `toBe` on a LIST value, deliberately. "The value is
      // equal" and "no secret was fetched" are both satisfied by a walk that
      // rebuilds the whole structure — which is what the fast path exists to
      // avoid, and which would also DETACH the returned array from the exports
      // index entry it was read out of. Reference identity is the observable
      // that separates the two, so this is what reds when the fast path goes.
      const exported = ['arn:aws:s3:::producer-shared-bucket', 'us-east-1'];
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'BucketRef' },
        buildContext({
          exportIndex: mockIndex({
            BucketRef: {
              value: exported,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
        })
      );

      expect(result).toBe(exported);
      expect(secretSends).toHaveLength(0);
      expect(secretsInstances).toHaveLength(0);
    });

    it('keeps the expression on the DIFF path, fetching nothing', async () => {
      // `skipDynamicReferences` is what keeps a comparison expression-vs-
      // expression: the consumer's own state holds the expression, so
      // resolving here would report a spurious change on every run AND make
      // `cdkd diff` fetch a secret it then prints.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbPassword' },
        buildContext({
          exportIndex: mockIndex({
            DbPassword: {
              value: SECRET_EXPRESSION,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
          skipDynamicReferences: true,
        })
      );

      expect(result).toBe(SECRET_EXPRESSION);
      expect(secretSends).toHaveLength(0);
    });

    it('returns a CloudFormation ListExports value VERBATIM', async () => {
      // The fallback's value never passed through cdkd's redaction — it is
      // whatever CloudFormation holds — so a token there is a literal the
      // producer chose to publish, and resolving it would diverge from what a
      // CloudFormation consumer of the same export receives.
      prime(CONSUMER_REGION, 'ListExportsCommand', {
        Exports: [{ Name: 'DbPassword', Value: SECRET_EXPRESSION, ExportingStackId: 'cfn-stack' }],
      });
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbPassword' },
        buildContext({ stateBackend: mockBackend([]) })
      );

      expect(result).toBe(SECRET_EXPRESSION);
      expect(cfnSends.map((s) => s.command)).toEqual(['ListExportsCommand']);
      expect(secretSends).toHaveLength(0);
    });

    it('SURFACES a failed re-resolution on the index arm instead of reporting the export missing', async () => {
      // The re-resolution has to sit OUTSIDE the arm's own catch. Inside it, a
      // real failure — `AccessDenied` on `GetSecretValue`, a producer region
      // that is not client-safe — read as "index lookup failed", fell through
      // to the scan, and the caller was finally told `export ... not found in
      // any stack`: an error naming neither the cause nor the export that WAS
      // found. Modelled by priming NO response for the producer region.
      responses.delete(`${PRODUCER_REGION}|GetSecretValueCommand`);
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });

      await expect(
        resolver.resolve(
          { 'Fn::ImportValue': 'DbPassword' },
          buildContext({
            exportIndex: mockIndex({
              DbPassword: {
                value: SECRET_EXPRESSION,
                producerStack: 'Producer',
                producerRegion: PRODUCER_REGION,
              },
            }),
            stateBackend: mockBackend([]),
          })
        )
      ).rejects.toThrow(/no secretsmanager response primed/);
    });

    it('SURFACES a failed re-resolution on the scan arm too', async () => {
      // Same defect one arm over, with a worse disguise: the per-stack catch
      // logs `Failed to read state for stack X` and CONTINUES past the record
      // it had just matched.
      responses.delete(`${PRODUCER_REGION}|GetSecretValueCommand`);
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });

      await expect(
        resolver.resolve(
          { 'Fn::ImportValue': 'DbPassword' },
          buildContext({
            stateBackend: mockBackend([
              {
                stackName: 'Producer',
                region: PRODUCER_REGION,
                outputs: { DbPassword: SECRET_EXPRESSION },
              },
            ]),
          })
        )
      ).rejects.toThrow(/no secretsmanager response primed/);
    });

    it('builds ONE producer-region resolver per foreign region', async () => {
      // The pinned sibling is cached, so a stack importing N secret-bearing
      // exports from one producer region pays one client, not N — and its
      // value cache is shared across them. TWO DIFFERENT expressions, so the
      // per-resolver value cache cannot be what collapses the second lookup.
      const other = '{{resolve:secretsmanager:prod/api/cred:SecretString:password}}';
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const index = mockIndex({
        DbPassword: {
          value: SECRET_EXPRESSION,
          producerStack: 'Producer',
          producerRegion: PRODUCER_REGION,
        },
        ApiKey: { value: other, producerStack: 'Producer', producerRegion: PRODUCER_REGION },
      });
      const context = buildContext({ exportIndex: index, stateBackend: mockBackend([]) });

      await resolver.resolve({ 'Fn::ImportValue': 'DbPassword' }, context);
      await resolver.resolve({ 'Fn::ImportValue': 'ApiKey' }, context);

      expect(secretSends).toHaveLength(2);
      expect(secretsInstances).toHaveLength(1);
    });
  });

  describe('Fn::GetStackOutput (the sibling read path)', () => {
    it('re-resolves the producer output in the region the reference names', async () => {
      // Same persisted `state.outputs` bag as `Fn::ImportValue`, so it carries
      // the same redacted expressions — issue #1934 Direction item 2.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'DbPassword',
            Region: PRODUCER_REGION,
          },
        },
        buildContext({
          stateBackend: mockBackend([
            {
              stackName: 'Producer',
              region: PRODUCER_REGION,
              outputs: { DbPassword: SECRET_EXPRESSION },
            },
          ]),
          recordedSecretValues,
        })
      );

      expect(result).toBe(PRODUCER_REGION_PASSWORD);
      expect(recordedSecretValues.get(PRODUCER_REGION_PASSWORD)).toBe(SECRET_EXPRESSION);
      expect(secretSends[0]?.ctorRegion).toBe(PRODUCER_REGION);
    });

    it('leaves an ORDINARY output untouched, with no lookup', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });

      const result = await resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'ApiUrl',
            Region: PRODUCER_REGION,
          },
        },
        buildContext({
          stateBackend: mockBackend([
            {
              stackName: 'Producer',
              region: PRODUCER_REGION,
              outputs: { ApiUrl: 'https://api.example.com' },
            },
          ]),
        })
      );

      expect(result).toBe('https://api.example.com');
      expect(secretSends).toHaveLength(0);
    });

    it('returns a CloudFormation DescribeStacks output VERBATIM', async () => {
      // The twin of the `Fn::ImportValue` ListExports case, and a separate
      // return statement: the two fallbacks are carved out independently, so
      // one being right says nothing about the other. A CFn-managed producer's
      // output never passed through cdkd's redaction, so a token there is a
      // literal the producer published.
      prime(PRODUCER_REGION, 'DescribeStacksCommand', {
        Stacks: [{ Outputs: [{ OutputKey: 'DbPassword', OutputValue: SECRET_EXPRESSION }] }],
      });
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'CfnProducer',
            OutputName: 'DbPassword',
            Region: PRODUCER_REGION,
          },
        },
        // No cdkd state record for it, so the CFn fallback is what answers.
        buildContext({ stateBackend: mockBackend([]) })
      );

      expect(result).toBe(SECRET_EXPRESSION);
      expect(cfnSends.map((s) => s.command)).toEqual(['DescribeStacksCommand']);
      expect(secretSends).toHaveLength(0);
    });
  });

  describe('the value walk', () => {
    it('descends a LIST-valued output, which state.outputs deliberately keeps as an array', async () => {
      // `state.outputs` is `Record<string, unknown>` and is NOT coerced to
      // string, so a secret-bearing output is not always a bare string. A walk
      // that only handled strings would ship the token inside the array.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'Creds' },
        buildContext({
          exportIndex: mockIndex({
            Creds: {
              value: ['static-user', SECRET_EXPRESSION],
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
        })
      );

      expect(result).toEqual(['static-user', PRODUCER_REGION_PASSWORD]);
    });

    it('resolves a token EMBEDDED in surrounding text', async () => {
      // The CDK-typical shape: a connection string built around the secret.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbUrl' },
        buildContext({
          exportIndex: mockIndex({
            DbUrl: {
              value: `postgres://admin:${SECRET_EXPRESSION}@db.example.com:5432/app`,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
        })
      );

      expect(result).toBe(
        `postgres://admin:${PRODUCER_REGION_PASSWORD}@db.example.com:5432/app`
      );
    });

    it('descends an OBJECT-valued output', async () => {
      // The sibling of the list case, and structurally invisible to it: making
      // EITHER the detector's object arm or the walk's object arm stop
      // descending left every other case in this file green, so a map-valued
      // output would have shipped the literal token — #1934 unfixed through a
      // shape `state.outputs` permits exactly as much as a list.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbCreds' },
        buildContext({
          exportIndex: mockIndex({
            DbCreds: {
              value: { user: 'admin', password: SECRET_EXPRESSION },
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
        })
      );

      expect(result).toEqual({ user: 'admin', password: PRODUCER_REGION_PASSWORD });
    });

    it('keeps an own `__proto__` key as DATA, without touching the prototype', async () => {
      // `state.outputs` is JSON-parsed, and `JSON.parse` creates `__proto__` as
      // an ORDINARY own property. Rebuilding onto a `{}` literal then assigns
      // through the prototype SETTER: the key vanishes from the rebuilt bag AND
      // the object's prototype changes with it. `Object.create(null)` has no
      // such setter — the same answer `secret-redaction.ts` uses (#1943).
      const exported = JSON.parse(
        `{"__proto__": ${JSON.stringify(SECRET_EXPRESSION)}, "user": "admin"}`
      ) as Record<string, unknown>;
      // The fixture itself must carry the hazard, or the case is vacuous.
      expect(Object.getOwnPropertyNames(exported)).toContain('__proto__');

      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const result = (await resolver.resolve(
        { 'Fn::ImportValue': 'Weird' },
        buildContext({
          exportIndex: mockIndex({
            Weird: { value: exported, producerStack: 'Producer', producerRegion: PRODUCER_REGION },
          }),
          stateBackend: mockBackend([]),
        })
      )) as Record<string, unknown>;

      // The key SURVIVED, as data, carrying the re-resolved value...
      expect(Object.getOwnPropertyNames(result)).toContain('__proto__');
      expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe(
        PRODUCER_REGION_PASSWORD
      );
      // ...and it did not become the object's prototype.
      expect(Object.getPrototypeOf(result)).not.toBe(String.prototype);
      expect(result['user']).toBe('admin');
    });
  });

  describe('the log lines stay non-disclosing', () => {
    // These lines used to print the STORED value, defended by "what a producer
    // stores for a secret-bearing export is the `{{resolve:...}}` EXPRESSION".
    // That premise is a property of POST-#1934 state only, and it is false by
    // construction for `cdkd scrub`'s population — state an OLDER binary wrote,
    // holding the PLAINTEXT — which reaches these lines at DEFAULT verbosity
    // since scrub gained a `stateBackend` (issue
    // [#2133](https://github.com/go-to-k/cdkd/issues/2133)). Masking could not
    // save them either: the needle for the value is recorded by the
    // re-resolution these lines deliberately precede. So the line now carries
    // NO value at any verbosity — only the reference, the producer, and a
    // non-disclosing SHAPE note, which is what these tests assert positively so
    // that "no plaintext appears" cannot be satisfied by an empty log.
    it('prints the EXPRESSION, never the plaintext, for Fn::ImportValue', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbPassword' },
        buildContext({
          exportIndex: mockIndex({
            DbPassword: {
              value: SECRET_EXPRESSION,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
        })
      );

      // The resolution really did happen (else "no plaintext logged" is
      // satisfied by nothing having been resolved at all).
      expect(result).toBe(PRODUCER_REGION_PASSWORD);
      const line = logLines.find((l) => l.includes('Resolved Fn::ImportValue: DbPassword'));
      expect(line).toBeDefined();
      // POSITIVE marker: the producer is named and the value's SHAPE is stated,
      // which is the whole reason the value used to be interpolated.
      expect(line).toContain('from index: Producer');
      expect(line).toContain('redacted dynamic reference');
      // NEITHER the plaintext NOR the expression reaches the log now.
      expect(logLines.join('\n')).not.toContain(PRODUCER_REGION_PASSWORD);
      expect(logLines.join('\n')).not.toContain(SECRET_EXPRESSION);
    });

    it('prints the EXPRESSION, never the plaintext, for Fn::GetStackOutput', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });

      const result = await resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'DbPassword',
            Region: PRODUCER_REGION,
          },
        },
        buildContext({
          stateBackend: mockBackend([
            {
              stackName: 'Producer',
              region: PRODUCER_REGION,
              outputs: { DbPassword: SECRET_EXPRESSION },
            },
          ]),
        })
      );

      expect(result).toBe(PRODUCER_REGION_PASSWORD);
      const line = logLines.find((l) => l.includes('Resolved Fn::GetStackOutput'));
      expect(line).toBeDefined();
      expect(line).toContain('OutputName=DbPassword');
      expect(line).toContain('redacted dynamic reference');
      expect(logLines.join('\n')).not.toContain(PRODUCER_REGION_PASSWORD);
      expect(logLines.join('\n')).not.toContain(SECRET_EXPRESSION);
    });

    it("masks the re-resolution's own ORIGIN line, which embeds the resolved export name", async () => {
      // `reresolveCrossStackValue` logs `Re-resolving dynamic reference(s) in
      // <origin>`, and `origin` is assembled from the RESOLVED `exportName` —
      // a `resolveValue` result, so an export name built from a
      // `{{resolve:...}}` reference IS a resolved secret. Every sibling line
      // naming that identifier masks it; this one did not (issue #2133 review).
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });
      const recordedSecretValues = new Map<string, string>();

      // The ARGUMENT is a secret reference, so resolving it both PRODUCES the
      // export name and RECORDS the needle for it.
      const result = await resolver.resolve(
        { 'Fn::ImportValue': SECRET_EXPRESSION },
        buildContext({
          recordedSecretValues,
          stateBackend: mockBackend([
            {
              stackName: 'Producer',
              region: PRODUCER_REGION,
              outputs: { [CONSUMER_REGION_PASSWORD]: SECRET_EXPRESSION },
            },
          ]),
        })
      );

      // The read really happened and really re-resolved (else "no plaintext
      // logged" is satisfied by nothing having run).
      expect(result).toBe(PRODUCER_REGION_PASSWORD);
      expect(recordedSecretValues.get(CONSUMER_REGION_PASSWORD)).toBe(SECRET_EXPRESSION);
      const line = logLines.find((l) => l.includes('Re-resolving dynamic reference(s) in'));
      expect(line).toBeDefined();
      // POSITIVE: it still NAMES the reference and its producer...
      expect(line).toContain("Fn::ImportValue '");
      expect(line).toContain('producer Producer');
      expect(line).toContain('***');
      // ...and the export name's plaintext reaches no log line anywhere.
      expect(logLines.join('\n')).not.toContain(CONSUMER_REGION_PASSWORD);
    });

    it('masks the DescribeStacks-fallback failure, which names the resolved stack name', async () => {
      // The exact twin of `lookupCfnExport`'s own warn, and it prints at
      // DEFAULT verbosity too. `lookupCfnStackOutputs` was never given a
      // `context`, so it was the one sibling with nothing to mask against —
      // while `stackName` reaches it straight from `resolveValue` (issue #2133
      // review).
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const recordedSecretValues = new Map<string, string>();

      // Nothing is primed for CloudFormation, so `DescribeStacks` rejects with
      // a non-ValidationError — the lookup-FAILED arm, which warns.
      const err = await resolver
        .resolve(
          {
            'Fn::GetStackOutput': { StackName: SECRET_EXPRESSION, OutputName: 'DbPassword' },
          },
          buildContext({ recordedSecretValues, stateBackend: mockBackend([]) })
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(recordedSecretValues.get(CONSUMER_REGION_PASSWORD)).toBe(SECRET_EXPRESSION);
      const warned = logLines.filter((l) => l.startsWith('warn')).join('\n');
      // POSITIVE: the warning really did fire and still names the region and
      // the remedy...
      expect(warned).toContain('DescribeStacks fallback failed for stack');
      expect(warned).toContain('***');
      expect(warned).toContain('cloudformation:DescribeStacks');
      // ...without the resolved stack name's plaintext.
      expect(logLines.join('\n')).not.toContain(CONSUMER_REGION_PASSWORD);
    });
  });

  describe("the `Available outputs` enumeration is bounded (issue #2133 review)", () => {
    // These are the PRODUCER's output KEYS, and a key can itself hold plaintext
    // (the `secretBearingStateKeyWarning` class, issue #1919, which `cdkd
    // scrub` counts and deliberately never prints). They land in a top-level
    // ERROR, i.e. the one thing on this path that reaches a CI log at default
    // verbosity.
    const LEAKED_KEY = 'leaked-export-key-plaintext-2133';

    it('masks a key the caller recorded as a secret, and still names the others', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });

      const err = (await resolver
        .resolve(
          {
            'Fn::GetStackOutput': {
              StackName: 'Producer',
              OutputName: 'Missing',
              Region: PRODUCER_REGION,
            },
          },
          buildContext({
            recordedSecretValues: new Map([[LEAKED_KEY, SECRET_EXPRESSION]]),
            stateBackend: mockBackend([
              {
                stackName: 'Producer',
                region: PRODUCER_REGION,
                outputs: { [LEAKED_KEY]: 'v', Other: 'y' },
              },
            ]),
          })
        )
        .catch((e: unknown) => e)) as Error;

      // POSITIVE: the enumeration still happened and is still actionable...
      expect(err.message).toContain('Available outputs:');
      expect(err.message).toContain('Other');
      expect(err.message).toContain('***');
      // ...and the recorded plaintext is not in it.
      expect(err.message).not.toContain(LEAKED_KEY);
    });

    it('caps the list, so one error cannot dump a producer key space', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION, { cfnFallback: false });
      const outputs: Record<string, unknown> = {};
      for (let i = 0; i < 14; i++) outputs[`Out${i}`] = 'v';

      const err = (await resolver
        .resolve(
          {
            'Fn::GetStackOutput': {
              StackName: 'Producer',
              OutputName: 'Missing',
              Region: PRODUCER_REGION,
            },
          },
          buildContext({
            stateBackend: mockBackend([
              { stackName: 'Producer', region: PRODUCER_REGION, outputs },
            ]),
          })
        )
        .catch((e: unknown) => e)) as Error;

      expect(err.message).toContain('Out0');
      expect(err.message).toContain('Out9');
      expect(err.message).not.toContain('Out10');
      expect(err.message).toContain('(+4 more)');
    });
  });

  describe('the producer-region resolver', () => {
    it('binds a producer region even when the consumer resolver was given NONE', async () => {
      // Fences `explicitRegion` vs `resolverRegion` at
      // `resolverForProducerRegion`. Every other case here constructs the
      // resolver WITH a consumer region, where the two agree — so swapping the
      // comparison to `resolverRegion`, or short-circuiting on a missing
      // `explicitRegion`, left the whole file green and the "unknown means
      // SCOPE, not skip" rationale had nothing behind it.
      //
      // THE FIXTURE'S SHAPE IS THE WHOLE DISCRIMINATION, and the first cut got
      // it wrong: with `AWS_REGION` set to the CONSUMER's region both the right
      // and the `resolverRegion` version still bind (neither equals the
      // producer's), so that probe stayed green. Pointing `AWS_REGION` at the
      // PRODUCER's region is what separates them — `resolverRegion` then EQUALS
      // the target and the wrong version returns `this`, whose lookups follow
      // the ambient clients (configured for the consumer's region) and answer
      // with the consumer-region secret. Both wrong versions therefore fail on
      // the VALUE, not merely on a client count.
      process.env['AWS_REGION'] = PRODUCER_REGION;
      const resolver = new IntrinsicFunctionResolver();

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'DbPassword' },
        buildContext({
          exportIndex: mockIndex({
            DbPassword: {
              value: SECRET_EXPRESSION,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend([]),
        })
      );

      expect(result).toBe(PRODUCER_REGION_PASSWORD);
      expect(secretsInstances).toHaveLength(1);
      expect(secretsInstances[0]?.ctorConfig.region).toBe(PRODUCER_REGION);
    });

    it('does NOT pin the producer region verdict into the process-global store', async () => {
      // The correction the #1934 review forced. The verdict store lives in
      // `secret-redaction.ts`, is process-global and is keyed by the expression
      // STRING, so a guest pinning a producer-region `SecureString` verdict
      // would seed `isKnownSecret` for the CONSUMER's own next pass — and on
      // the diff path that SKIPS the lookup, leaving a consumer-region plain
      // `String` (which state holds RESOLVED) compared as an expression, i.e.
      // a spurious change on every run.
      //
      // Same expression name in both regions, different TYPES — the ordinary
      // SSM reality, and the discriminator: with the guest suppression removed
      // the second resolution returns the expression instead of the value.
      const ssmExpression = '{{resolve:ssm:/shared/db/password}}';
      prime(PRODUCER_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'ireland-secret', Type: 'SecureString' },
      });
      prime(CONSUMER_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-public-config', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const context = buildContext({
        exportIndex: mockIndex({
          Shared: {
            value: ssmExpression,
            producerStack: 'Producer',
            producerRegion: PRODUCER_REGION,
          },
        }),
        stateBackend: mockBackend([]),
      });

      // 1. The import re-resolves through the producer-region GUEST.
      await expect(
        resolver.resolve({ 'Fn::ImportValue': 'Shared' }, context)
      ).resolves.toBe('ireland-secret');

      // 2. The consumer's OWN pass, on the comparison path, must still ask AWS
      //    and resolve ITS region's public value.
      const diffResult = await resolver.resolveDynamicReferences(ssmExpression, {
        ...context,
        skipDynamicReferences: true,
      });

      expect(diffResult).toBe('tokyo-public-config');
      expect(ssmSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION, CONSUMER_REGION]);
    });
  });
});
