import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * A rollback replay must not re-resolve a REGION-AMBIGUOUS secret reference
 * against the consumer's own region (issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057)).
 *
 * Since issue #1934 a cross-stack consumer re-resolves a redacted producer
 * value in the PRODUCER's region and records the PRODUCER's spelling of the
 * `{{resolve:...}}` expression into its own state. That spelling carries no
 * region, and `replayRollback` rebuilds its resolver from `ctx.region` alone —
 * so the replay used to resolve the producer's reference against the consumer's
 * region and write whatever a same-named secret holds THERE onto a live
 * resource.
 *
 * WHY THIS FILE FAKES THE SDK CLIENT CLASSES rather than `getAwsClients()`
 * (same choice as `cross-stack-secret-reresolve.test.ts`): the whole question is
 * WHICH REGION was asked, and a plain-object `getAwsClients()` double has no
 * region, so it cannot be asked it. The real `AwsClients` is used and only the
 * leaf `SecretsManagerClient` is faked, with the constructor region as the
 * discriminator.
 *
 * Responses are primed per (REGION, COMMAND) — no `*Once` queue to leak.
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

const { responses, secretSends, ssmSends, makeFakeClientClass } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();

  const makeFakeClientClass = (sends: FakeSend[], serviceLabel: string): unknown =>
    class {
      readonly ctorConfig: FakeClientConfig;
      readonly config: { region: () => Promise<string> };
      private resolved?: Promise<string>;

      constructor(ctorConfig: FakeClientConfig = {}) {
        this.ctorConfig = ctorConfig;
        this.config = { region: () => this.resolveRegion() };
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
        sends.push({
          ctorRegion: this.ctorConfig.region,
          region,
          command: name,
          input: command.input,
        });
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
    secretSends: [] as FakeSend[],
    ssmSends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager'),
  };
});

// An `ssm` reference can name an ARN too, so the ssm client needs the same
// region-observable fake as the secretsmanager one.
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], 'sts') };
});

// Pass-through retry: the revert arm wraps `provider.update` in `withRetry`,
// and a refusal must not sleep through a real backoff schedule.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  replayRollback,
  replayFailedOperations,
  classifyReplaySecretRegion,
  producerRegionsFromState,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

const CONSUMER_REGION = 'ap-northeast-1';
const PRODUCER_REGION = 'eu-west-1';
const PROFILE = 'cdkd-lane-2057';

const SECRET_NAME = 'prod/db/cred';
/** The producer's own, region-less spelling — what #1934 persists downstream. */
const NAME_EXPR = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}`;
const CONSUMER_ARN = `arn:aws:secretsmanager:${CONSUMER_REGION}:111122223333:secret:${SECRET_NAME}-AbCdEf`;
const PRODUCER_ARN = `arn:aws:secretsmanager:${PRODUCER_REGION}:111122223333:secret:${SECRET_NAME}-AbCdEf`;
const CONSUMER_ARN_EXPR = `{{resolve:secretsmanager:${CONSUMER_ARN}:SecretString:password}}`;
const PRODUCER_ARN_EXPR = `{{resolve:secretsmanager:${PRODUCER_ARN}:SecretString:password}}`;
/**
 * An `ssm` reference CAN name a full ARN — `resolveSSMReference` rebuilds the
 * parameter name as `parts.slice(1).join(':')`, so the colon-split tail
 * survives. A classifier that took `split(':')[1]` would read `'arn'` here.
 */
const SSM_PRODUCER_ARN = `arn:aws:ssm:${PRODUCER_REGION}:111122223333:parameter/db/pw`;
const SSM_ARN_EXPR = `{{resolve:ssm:${SSM_PRODUCER_ARN}}}`;

/**
 * Two regions holding DIFFERENT values behind the SAME reference — the ordinary
 * Secrets Manager reality, and the only thing that makes "which region
 * answered" observable at all. A fixture that primed one value could not tell
 * the fixed path from the broken one.
 */
const TOKYO_PASSWORD = 'tokyo-password-2057';
const IRELAND_PASSWORD = 'ireland-password-2057';

const IDP_TYPE = 'AWS::Cognito::UserPoolIdentityProvider';

const logLines: string[] = [];
const recordingLogger = {
  debug: (...a: unknown[]): void => void logLines.push(`debug ${a.map(String).join(' ')}`),
  info: (...a: unknown[]): void => void logLines.push(`info ${a.map(String).join(' ')}`),
  warn: (...a: unknown[]): void => void logLines.push(`warn ${a.map(String).join(' ')}`),
  error: (...a: unknown[]): void => void logLines.push(`error ${a.map(String).join(' ')}`),
  setLevel: (): void => {},
  child: (): unknown => recordingLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-B',
    resourceType: IDP_TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(
  provider: { update?: unknown; create?: unknown; delete?: unknown },
  importedProducerRegions?: readonly string[]
): RollbackExecutorContext {
  return {
    region: CONSUMER_REGION,
    logger: recordingLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
    ...(importedProducerRegions !== undefined && { importedProducerRegions }),
  };
}

/**
 * A single UPDATE op whose journaled previous properties carry `expr`, and
 * whose CURRENT state differs at a public leaf so the op classifies as a real
 * `revert` rather than `skip-already-done`.
 */
function revertScenario(expr: string): {
  ops: CompletedOperation[];
  state: Record<string, ResourceState>;
} {
  const prev = res({
    properties: { ProviderDetails: { client_id: 'pub', client_secret: expr } },
  });
  return {
    ops: [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: prev,
      },
    ],
    state: {
      Idp: res({
        properties: { ProviderDetails: { client_id: 'pub-CHANGED', client_secret: expr } },
      }),
    },
  };
}

function prime(region: string, command: string, response: unknown): void {
  responses.set(`${region}|${command}`, response);
}

let savedRegion: string | undefined;

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  delete process.env['AWS_REGION'];
  responses.clear();
  secretSends.length = 0;
  ssmSends.length = 0;
  logLines.length = 0;
  resetAccountInfoCache();
  setAwsClients(new AwsClients({ region: CONSUMER_REGION, profile: PROFILE }));
  prime(CONSUMER_REGION, 'GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: TOKYO_PASSWORD }),
  });
  prime(PRODUCER_REGION, 'GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: IRELAND_PASSWORD }),
  });
  prime(PRODUCER_REGION, 'GetParameterCommand', {
    Parameter: { Value: IRELAND_PASSWORD, Type: 'SecureString' },
  });
  prime(CONSUMER_REGION, 'GetParameterCommand', {
    Parameter: { Value: TOKYO_PASSWORD, Type: 'SecureString' },
  });
});

afterEach(() => {
  resetAwsClients();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

describe('rollback replay refuses a region-ambiguous secret reference (issue #2057)', () => {
  it('cross-region import on record: refuses the region-less reference instead of asking the CONSUMER region', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const { ops, state } = revertScenario(NAME_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    // THE discriminator: the fixed path asks NOBODY. The broken path asks the
    // consumer's region and hands `provider.update` the Tokyo password — a
    // different credential from the Ireland one the deploy applied.
    expect(update).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);
    expect(result.failures).toBe(1);

    const refusal = logLines.find((l) => l.includes('Rollback failed for Idp'));
    expect(refusal).toBeDefined();
    // Names the logical id, the property PATH, the secret, both regions, and a remedy.
    expect(refusal).toContain('Idp');
    expect(refusal).toContain("property 'ProviderDetails.client_secret'");
    expect(refusal).toContain(SECRET_NAME);
    expect(refusal).toContain(CONSUMER_REGION);
    expect(refusal).toContain(PRODUCER_REGION);
    expect(refusal).toContain("re-run 'cdkd rollback'");
    // Never leaks either region's value.
    expect(logLines.join('\n')).not.toContain(TOKYO_PASSWORD);
    expect(logLines.join('\n')).not.toContain(IRELAND_PASSWORD);
  });

  it('same-region imports only: resolves in the consumer region exactly as before', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [CONSUMER_REGION]);
    const { ops, state } = revertScenario(NAME_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(0);
    // Asked, and asked the CONSUMER's region — behaviour unchanged.
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION]);
    const desired = update.mock.calls[0]![3] as {
      ProviderDetails: { client_secret: string };
    };
    expect(desired.ProviderDetails.client_secret).toBe(TOKYO_PASSWORD);
  });

  it('no cross-stack reads on record at all: resolves in the consumer region exactly as before', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    // `importedProducerRegions` absent — the shape every caller builds today.
    const ctx = makeCtx({ update });
    const { ops, state } = revertScenario(NAME_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(0);
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION]);
    const desired = update.mock.calls[0]![3] as {
      ProviderDetails: { client_secret: string };
    };
    expect(desired.ProviderDetails.client_secret).toBe(TOKYO_PASSWORD);
  });

  it('ARN naming a FOREIGN region: resolved by a client CONSTRUCTED in the ARN region', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    // No imports recorded — the ARN arm stands on the expression alone.
    const ctx = makeCtx({ update });
    const { ops, state } = revertScenario(PRODUCER_ARN_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    // A named region BINDS (issue #1957): the ARN says eu-west-1, so eu-west-1
    // answers — NOT the stack's ap-northeast-1. The constructor region of the
    // client that sent the call is the discriminator; asserting only "it
    // resolved" would pass on the broken path too, because the fixture's Tokyo
    // secret resolves just as happily.
    expect(result.failures).toBe(0);
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect((secretSends[0]!.input as { SecretId: string }).SecretId).toBe(PRODUCER_ARN);
    const desired = update.mock.calls[0]![3] as {
      ProviderDetails: { client_secret: string };
    };
    expect(desired.ProviderDetails.client_secret).toBe(IRELAND_PASSWORD);
    expect(desired.ProviderDetails.client_secret).not.toBe(TOKYO_PASSWORD);
  });

  it('a leaf mixing a local name-form reference with a foreign ARN sends each to its OWN region', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    // No foreign producer region on record, so the name-form half is `local`
    // and only the ARN half is redirected.
    const ctx = makeCtx({ update });
    const mixed = `local=${NAME_EXPR};foreign=${PRODUCER_ARN_EXPR}`;
    const { ops, state } = revertScenario(mixed);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(0);
    // One call per region, in leaf order — a single whole-leaf resolve would
    // have sent BOTH tokens to whichever region the one resolver was pinned to.
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION, PRODUCER_REGION]);
    const desired = update.mock.calls[0]![3] as {
      ProviderDetails: { client_secret: string };
    };
    expect(desired.ProviderDetails.client_secret).toBe(
      `local=${TOKYO_PASSWORD};foreign=${IRELAND_PASSWORD}`
    );
  });

  it('ARN naming the stack OWN region: waved through and resolved locally', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const { ops, state } = revertScenario(CONSUMER_ARN_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    // A foreign producer region IS on record, but the expression settles the
    // question itself — so the name-form arm must not fire here.
    expect(result.failures).toBe(0);
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION]);
    expect((secretSends[0]!.input as { SecretId: string }).SecretId).toBe(CONSUMER_ARN);
    const desired = update.mock.calls[0]![3] as {
      ProviderDetails: { client_secret: string };
    };
    expect(desired.ProviderDetails.client_secret).toBe(TOKYO_PASSWORD);
  });
});

describe('the refusal fires BEFORE any credential is fetched (issue #2057)', () => {
  it('a leaf mixing local, foreign-ARN and AMBIGUOUS references fetches NOTHING', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    // Three verdicts in ONE leaf: `local` (same-region ARN), `named-region`
    // (foreign ARN) and `ambiguous` (region-less, with a foreign producer
    // region on record). The named-region token is what selects the
    // segment-rebuild path, so moving the refusal into that loop — the exact
    // mutation review probed — would fetch the first two before throwing.
    // A fetched credential is cached on the resolver AND recorded as a
    // redaction needle for an op that is about to be refused anyway.
    const mixed = `a=${CONSUMER_ARN_EXPR};b=${PRODUCER_ARN_EXPR};c=${NAME_EXPR}`;
    const { ops, state } = revertScenario(mixed);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(secretSends).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const refusal = logLines.find((l) => l.includes('Rollback failed for Idp'));
    expect(refusal).toContain(SECRET_NAME);
  });
});

describe('every resolveReplayProps call site is region-checked (issue #2057)', () => {
  /**
   * Five call sites resolve a replayed bag; only the two `revert` ones were
   * covered when review probed this. Each test below re-introduces the defect
   * at exactly one of the other three by asserting the refusal reaches it.
   */
  it('reverse-replacement: the re-CREATE bag is checked, so create() is never called', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-OLD', attributes: {} });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del }, [PRODUCER_REGION]);
    // previousState.physicalId !== op.physicalId, and state points at the NEW
    // id, which is what `isReplacementOp` + `classifyRollbackOp` read as a
    // reverse-replacement rather than an in-place revert.
    const prev = res({
      physicalId: 'phys-OLD',
      properties: { ProviderDetails: { client_secret: NAME_EXPR } },
    });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-NEW',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({
        physicalId: 'phys-NEW',
        properties: { ProviderDetails: { client_secret: 'unrelated' } },
      }),
    };

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);
    expect(result.failures).toBe(1);
    expect(logLines.find((l) => l.includes('Rollback failed for Idp'))).toContain(
      'cannot re-resolve the secret reference'
    );
  });

  it('--revert-failed: the DESIRED bag is checked', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        // Only the desired side carries the ambiguous reference.
        previousState: res({ properties: { ProviderDetails: { client_secret: NAME_EXPR } } }),
        attemptedProperties: { ProviderDetails: { client_secret: 'literal-attempted' } },
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({ properties: { ProviderDetails: { client_secret: 'literal-current' } } }),
    };

    const result = await replayFailedOperations(failedOps, state, 'Consumer', ctx);

    expect(update).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);
    expect(result.failures).toBe(1);
  });

  it('--revert-failed: the ATTEMPTED bag is checked', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: res({ properties: { ProviderDetails: { client_secret: 'literal-prev' } } }),
        // Only the attempted side carries it — the bag that becomes the
        // provider's `previousProperties`, which a patch-based provider diffs.
        attemptedProperties: { ProviderDetails: { client_secret: NAME_EXPR } },
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({ properties: { ProviderDetails: { client_secret: 'literal-current' } } }),
    };

    const result = await replayFailedOperations(failedOps, state, 'Consumer', ctx);

    expect(update).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);
    expect(result.failures).toBe(1);
  });
});

describe('segment rebuild keeps every byte of the leaf (issue #2057)', () => {
  async function resolvedValue(
    leaf: string,
    importedProducerRegions?: readonly string[]
  ): Promise<{ value: string; regions: (string | undefined)[]; failures: number }> {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, importedProducerRegions);
    const { ops, state } = revertScenario(leaf);
    const result = await replayRollback(ops, state, 'Consumer', ctx);
    const desired = update.mock.calls[0]?.[3] as
      | { ProviderDetails: { client_secret: string } }
      | undefined;
    return {
      value: desired?.ProviderDetails.client_secret ?? '',
      regions: secretSends.map((x) => x.ctorRegion),
      failures: result.failures,
    };
  }

  it('resolves a DUPLICATED foreign token at both positions, fetching once', async () => {
    const out = await resolvedValue(`${PRODUCER_ARN_EXPR}|${PRODUCER_ARN_EXPR}`);
    expect(out.failures).toBe(0);
    expect(out.value).toBe(`${IRELAND_PASSWORD}|${IRELAND_PASSWORD}`);
    // One send: the second occurrence hits the pinned resolver's instance cache.
    expect(out.regions).toEqual([PRODUCER_REGION]);
  });

  it('resolves ADJACENT tokens with no separator, each in its own region', async () => {
    const out = await resolvedValue(`${CONSUMER_ARN_EXPR}${PRODUCER_ARN_EXPR}`);
    expect(out.failures).toBe(0);
    expect(out.value).toBe(`${TOKYO_PASSWORD}${IRELAND_PASSWORD}`);
    expect(out.regions).toEqual([CONSUMER_REGION, PRODUCER_REGION]);
  });

  it('keeps the literal text before, between and AFTER the last token', async () => {
    const out = await resolvedValue(`pre[${PRODUCER_ARN_EXPR}]mid[${CONSUMER_ARN_EXPR}]post`);
    expect(out.failures).toBe(0);
    expect(out.value).toBe(`pre[${IRELAND_PASSWORD}]mid[${TOKYO_PASSWORD}]post`);
  });

  it('leaves an UNTERMINATED `{{resolve:` untouched and fetches nothing', async () => {
    // `includes('{{resolve:')` is true so the leaf reaches the region logic,
    // but the shared scanner matches no token — the whole-leaf path must be
    // taken and must be an identity.
    const out = await resolvedValue('{{resolve:secretsmanager:never-closed', [PRODUCER_REGION]);
    expect(out.failures).toBe(0);
    expect(out.value).toBe('{{resolve:secretsmanager:never-closed');
    expect(out.regions).toEqual([]);
  });
});

describe('an ssm reference that NAMES an ARN region (issue #2057 round 2)', () => {
  it('is resolved by a client CONSTRUCTED in the ARN region, not refused', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    // A foreign producer region IS on record, so a mis-parse that read the
    // parameter name as `'arn'` would classify this as ambiguous and refuse.
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const { ops, state } = revertScenario(SSM_ARN_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(0);
    expect(ssmSends.map((x) => x.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect((ssmSends[0]!.input as { Name: string }).Name).toBe(SSM_PRODUCER_ARN);
    const desired = update.mock.calls[0]![3] as { ProviderDetails: { client_secret: string } };
    expect(desired.ProviderDetails.client_secret).toBe(IRELAND_PASSWORD);
  });
});

/**
 * Issue #2501 item 2: the classifier's `ssm-secure` arm was pinned by DIRECT
 * calls only, so nothing drove a replay end to end through that spelling. The
 * three verdicts are exercised here through `replayRollback` itself, which is
 * what proves the resolver reached for the spelling at all — a classifier that
 * verdicts correctly buys nothing if `resolveReplayProps` never routes an
 * `ssm-secure` token past it.
 */
describe('a replayed ssm-secure expression, driven end to end (issue #2482)', () => {
  const SECURE_PARAM = '/prod/idp/client-secret';
  const SECURE_EXPR = `{{resolve:ssm-secure:${SECURE_PARAM}}}`;
  const SECURE_ARN_EXPR = `{{resolve:ssm-secure:${SSM_PRODUCER_ARN}}}`;

  it('ambiguous: refuses the region-less reference BEFORE any GetParameter', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const { ops, state } = revertScenario(SECURE_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    // THE discriminator: nothing was decrypted. The broken path asks the
    // consumer's region with `WithDecryption: true` and writes whatever the
    // same-named SecureString holds THERE onto a live resource.
    expect(ssmSends).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);

    const refusal = logLines.find((l) => l.includes('Rollback failed for Idp'));
    expect(refusal).toBeDefined();
    // The PARAMETER NAME, not the service string — the shape item 4's
    // colon-less guard protects at the degenerate end of the same parser.
    expect(refusal).toContain(SECURE_PARAM);
    expect(refusal).toContain(CONSUMER_REGION);
    expect(refusal).toContain(PRODUCER_REGION);
    // INERT on today's broken path and kept deliberately: with `ssmSends` empty
    // no plaintext is in scope, so these cannot fail while the line above
    // passes. They are the standing leak fence for a future arm that resolves
    // BEFORE refusing -- which is exactly what the #2057 twin's own copy of
    // these two lines does discriminate, because that broken path fetches.
    expect(logLines.join('\n')).not.toContain(TOKYO_PASSWORD);
    expect(logLines.join('\n')).not.toContain(IRELAND_PASSWORD);
  });

  it('local: no foreign producer on record, so the consumer region decrypts it', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update });
    const { ops, state } = revertScenario(SECURE_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(0);
    // Asked, asked the CONSUMER's region, and asked for the DECRYPTED value —
    // the whole point of the spelling. Asserting only "it resolved" would pass
    // on a path that fetched the ciphertext.
    expect(ssmSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION]);
    expect((ssmSends[0]!.input as { Name: string }).Name).toBe(SECURE_PARAM);
    expect((ssmSends[0]!.input as { WithDecryption?: unknown }).WithDecryption).toBe(true);
    const desired = update.mock.calls[0]![3] as { ProviderDetails: { client_secret: string } };
    expect(desired.ProviderDetails.client_secret).toBe(TOKYO_PASSWORD);
  });

  it('named-region: an ARN under the ssm-secure spelling binds the ARN region', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    // A foreign producer IS on record, so a parser that lost the ARN would
    // classify this ambiguous and refuse instead of redirecting.
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const { ops, state } = revertScenario(SECURE_ARN_EXPR);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(0);
    expect(ssmSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect((ssmSends[0]!.input as { Name: string }).Name).toBe(SSM_PRODUCER_ARN);
    const desired = update.mock.calls[0]![3] as { ProviderDetails: { client_secret: string } };
    // The two regions hold DIFFERENT values, which is what makes "which region
    // answered" observable at all.
    expect(desired.ProviderDetails.client_secret).toBe(IRELAND_PASSWORD);
    expect(desired.ProviderDetails.client_secret).not.toBe(TOKYO_PASSWORD);
  });

  it('--revert-failed reaches the ssm-secure arm too, on its OWN resolveReplayProps sites', async () => {
    // `replayFailedOperations` resolves through call sites distinct from
    // `replayRollback`'s, and the existing --revert-failed cases are
    // `secretsmanager` only. Without this, the ssm-secure arm is proven on ONE
    // of the two replay entry points.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: res({ properties: { ProviderDetails: { client_secret: 'literal-prev' } } }),
        attemptedProperties: { ProviderDetails: { client_secret: SECURE_EXPR } },
      },
    ];
    const state: Record<string, ResourceState> = {
      Idp: res({ properties: { ProviderDetails: { client_secret: 'literal-current' } } }),
    };

    const result = await replayFailedOperations(failedOps, state, 'Consumer', ctx);

    expect(update).not.toHaveBeenCalled();
    expect(ssmSends).toHaveLength(0);
    expect(result.failures).toBe(1);
  });

  it('refuses the whole leaf when an ssm-secure token is EMBEDDED beside a local one', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx = makeCtx({ update }, [PRODUCER_REGION]);
    // The ambiguous token is embedded in a larger string, beside a same-region
    // ARN that is `local`. The refusal must still fire before the local half is
    // fetched — a fetched SecureString is cached on the resolver and recorded
    // as a redaction needle for an op that is about to be refused anyway.
    const mixed = `local=${CONSUMER_ARN_EXPR};secure=${SECURE_EXPR}`;
    const { ops, state } = revertScenario(mixed);

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(1);
    expect(ssmSends).toHaveLength(0);
    expect(secretSends).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(logLines.find((l) => l.includes('Rollback failed for Idp'))).toContain(SECURE_PARAM);
  });
});

describe('classifyReplaySecretRegion (issue #2057)', () => {
  it('refuses a region-less secretsmanager reference when a foreign producer region is on record', () => {
    expect(classifyReplaySecretRegion(NAME_EXPR, CONSUMER_REGION, [PRODUCER_REGION])).toEqual({
      kind: 'ambiguous',
      secretName: SECRET_NAME,
      foreignProducerRegions: [PRODUCER_REGION],
    });
  });

  it('binds the region an ssm ARN names, keeping the WHOLE ARN as the name', () => {
    // `resolveSSMReference` joins the colon-split tail back together, so the
    // parameter name is the full ARN. A `split(':')[1]` parse yields `'arn'`.
    expect(classifyReplaySecretRegion(SSM_ARN_EXPR, CONSUMER_REGION, [PRODUCER_REGION])).toEqual({
      kind: 'named-region',
      secretName: SSM_PRODUCER_ARN,
      region: PRODUCER_REGION,
    });
  });

  it('keeps a trailing :<version> in the ssm parameter name, as SSM itself parses it', () => {
    expect(
      classifyReplaySecretRegion('{{resolve:ssm:/db/pw:3}}', CONSUMER_REGION, [PRODUCER_REGION])
    ).toEqual({
      kind: 'ambiguous',
      secretName: '/db/pw:3',
      foreignProducerRegions: [PRODUCER_REGION],
    });
  });

  it('refuses a region-less ssm SecureString reference the same way', () => {
    expect(
      classifyReplaySecretRegion('{{resolve:ssm:/prod/idp/client-secret}}', CONSUMER_REGION, [
        PRODUCER_REGION,
      ])
    ).toEqual({
      kind: 'ambiguous',
      secretName: '/prod/idp/client-secret',
      foreignProducerRegions: [PRODUCER_REGION],
    });
  });

  // Issue #2482: `ssm-secure` is classified like `ssm`, and the name parser
  // must strip the WHOLE service — a fixed `'ssm:'.length` turned
  // `ssm-secure:/pw` into `secure:/pw`.
  it('refuses a region-less ssm-secure reference the same way, with the name intact', () => {
    expect(
      classifyReplaySecretRegion('{{resolve:ssm-secure:/prod/db/pw}}', CONSUMER_REGION, [
        PRODUCER_REGION,
      ])
    ).toEqual({
      kind: 'ambiguous',
      secretName: '/prod/db/pw',
      foreignProducerRegions: [PRODUCER_REGION],
    });
  });

  it('keeps a trailing :<version> in the ssm-secure parameter name', () => {
    expect(
      classifyReplaySecretRegion('{{resolve:ssm-secure:/db/pw:3}}', CONSUMER_REGION, [
        PRODUCER_REGION,
      ])
    ).toEqual({
      kind: 'ambiguous',
      secretName: '/db/pw:3',
      foreignProducerRegions: [PRODUCER_REGION],
    });
  });

  it('binds the region an ssm-secure ARN names (a cdkd-only extension of the spelling)', () => {
    // CloudFormation's `ssm-secure` grammar takes a name and a numeric version
    // only; the ARN form is accepted because `resolveSSMReference` hands the
    // tail to GetParameter as-is, which SSM accepts.
    expect(
      classifyReplaySecretRegion(`{{resolve:ssm-secure:${SSM_PRODUCER_ARN}}}`, CONSUMER_REGION, [
        PRODUCER_REGION,
      ])
    ).toEqual({
      kind: 'named-region',
      secretName: SSM_PRODUCER_ARN,
      region: PRODUCER_REGION,
    });
  });

  it('waves through a region-less ssm-secure reference with no foreign producer on record', () => {
    expect(
      classifyReplaySecretRegion('{{resolve:ssm-secure:/prod/db/pw}}', CONSUMER_REGION, undefined)
    ).toEqual({ kind: 'local' });
  });

  // Issue #2501 item 4: a COLON-LESS body names no parameter at all. The name
  // parser must answer `''` so the classifier's falsy-name arm sends it on to
  // the resolver's `PARAMETER_NAME is required`. Before the guard,
  // `indexOf(':')` was `-1` and `substring(0)` handed back the SERVICE STRING,
  // so with a foreign producer region on record the verdict was `ambiguous`
  // naming `'ssm-secure'` (or `'ssm'`) as the secret — a refusal message about
  // a secret that does not exist, in place of the resolver's clear one.
  it.each([['{{resolve:ssm-secure}}'], ['{{resolve:ssm}}']])(
    'waves through the colon-less body %s instead of naming the service as the secret',
    (expr) => {
      // `toEqual` on the WHOLE verdict is the assertion: it pins that `kind` is
      // `local` AND that no `secretName` field exists at all, which is the half
      // about the service string. A separate `not.toContain(service)` line was
      // dropped after review -- it cannot fail while this passes.
      expect(classifyReplaySecretRegion(expr, CONSUMER_REGION, [PRODUCER_REGION])).toEqual({
        kind: 'local',
      });
    }
  );

  // The CONTROL for the case above: the guard cannot have been implemented as
  // "any ssm-family reference is local".
  //
  // Only the SECOND assertion discriminates, and saying so is the point. The
  // empty-tail form was `local` before this change too (`indexOf(':')` is 10,
  // `substring(11)` is `''` under both spellings), so it is a parity pin, not a
  // fence. The `:x` form is the one the unguarded parser answered `ambiguous`
  // for and must still answer `ambiguous` for.
  it('still refuses the same reference the moment it names a parameter', () => {
    expect(
      classifyReplaySecretRegion('{{resolve:ssm-secure:}}', CONSUMER_REGION, [PRODUCER_REGION])
    ).toEqual({ kind: 'local' }); // parity pin: an EMPTY name is still no name
    expect(
      classifyReplaySecretRegion('{{resolve:ssm-secure:x}}', CONSUMER_REGION, [PRODUCER_REGION])
    ).toEqual({
      kind: 'ambiguous',
      secretName: 'x',
      foreignProducerRegions: [PRODUCER_REGION],
    });
  });

  // Parity with the `secretsmanager` twin, which has had this case since
  // issue #2057. Shared branch, so this is a pin rather than a fence.
  it('binds a same-region ssm-secure ARN as local even with a foreign producer on record', () => {
    expect(
      classifyReplaySecretRegion(
        `{{resolve:ssm-secure:arn:aws:ssm:${CONSUMER_REGION}:111122223333:parameter/db/pw}}`,
        CONSUMER_REGION,
        [PRODUCER_REGION]
      )
    ).toEqual({ kind: 'local' });
  });

  // The sibling extraction already answered `''` for its own degenerate body
  // (`secretsManagerSecretId` substrings past the end of the string), and this
  // pins that the two now agree rather than leaving it to coincidence.
  it('answers the colon-less secretsmanager body the same way', () => {
    expect(
      classifyReplaySecretRegion('{{resolve:secretsmanager}}', CONSUMER_REGION, [PRODUCER_REGION])
    ).toEqual({ kind: 'local' });
  });

  it('deduplicates producer regions case-insensitively and drops the consumer own', () => {
    const verdict = classifyReplaySecretRegion(NAME_EXPR, CONSUMER_REGION, [
      CONSUMER_REGION,
      'AP-NORTHEAST-1',
      PRODUCER_REGION,
      'EU-WEST-1',
      'us-east-2',
    ]);
    expect(verdict).toEqual({
      kind: 'ambiguous',
      secretName: SECRET_NAME,
      foreignProducerRegions: [PRODUCER_REGION, 'us-east-2'],
    });
  });

  it('waves through a region-less reference when every producer region is the consumer own', () => {
    expect(
      classifyReplaySecretRegion(NAME_EXPR, CONSUMER_REGION, [CONSUMER_REGION, 'AP-NORTHEAST-1'])
    ).toEqual({ kind: 'local' });
  });

  it('binds a FOREIGN ARN region and keeps the ARN intact as the secret name', () => {
    expect(classifyReplaySecretRegion(PRODUCER_ARN_EXPR, CONSUMER_REGION, undefined)).toEqual({
      kind: 'named-region',
      secretName: PRODUCER_ARN,
      region: PRODUCER_REGION,
    });
  });

  it('a same-region ARN is local even when a foreign producer region IS on record', () => {
    expect(
      classifyReplaySecretRegion(CONSUMER_ARN_EXPR, CONSUMER_REGION, [PRODUCER_REGION])
    ).toEqual({ kind: 'local' });
  });

  it('handles the whole-secret ARN form with no JSON key', () => {
    expect(
      classifyReplaySecretRegion(
        `{{resolve:secretsmanager:${PRODUCER_ARN}:SecretString}}`,
        CONSUMER_REGION,
        undefined
      )
    ).toEqual({ kind: 'named-region', secretName: PRODUCER_ARN, region: PRODUCER_REGION });
  });

  it('compares the ARN region case-insensitively', () => {
    expect(
      classifyReplaySecretRegion(
        `{{resolve:secretsmanager:arn:aws:secretsmanager:AP-NORTHEAST-1:111122223333:secret:x-AbCdEf:SecretString:password}}`,
        CONSUMER_REGION,
        undefined
      )
    ).toEqual({ kind: 'local' });
  });

  it('waves through a non-secret dynamic reference regardless of producer regions', () => {
    expect(classifyReplaySecretRegion('{{resolve:foo:bar}}', CONSUMER_REGION, [PRODUCER_REGION])).toEqual(
      { kind: 'local' }
    );
  });

  it('waves through a string that is not a dynamic reference at all', () => {
    expect(classifyReplaySecretRegion('plain-value', CONSUMER_REGION, [PRODUCER_REGION])).toEqual({
      kind: 'local',
    });
  });
});

describe('producerRegionsFromState (issue #2057)', () => {
  it('unions imports and outputReads, deduplicating case-insensitively', () => {
    expect(
      producerRegionsFromState({
        imports: [
          { sourceStack: 'P', sourceRegion: PRODUCER_REGION, exportName: 'E' },
          { sourceStack: 'P2', sourceRegion: 'EU-WEST-1', exportName: 'E2' },
        ],
        outputReads: [
          { sourceStack: 'P3', sourceRegion: 'us-east-2', outputName: 'O' },
          { sourceStack: 'P4', sourceRegion: PRODUCER_REGION, outputName: 'O2' },
        ],
      })
    ).toEqual([PRODUCER_REGION, 'us-east-2']);
  });

  it('keeps the consumer own region — filtering that is the classifier job', () => {
    expect(
      producerRegionsFromState({
        imports: [{ sourceStack: 'P', sourceRegion: CONSUMER_REGION, exportName: 'E' }],
      })
    ).toEqual([CONSUMER_REGION]);
  });

  it('is empty for a stack with no cross-stack reads on record', () => {
    expect(producerRegionsFromState({})).toEqual([]);
  });
});

describe('the cdkd rollback command wires importedProducerRegions (issue #2057)', () => {
  /**
   * A source fence, not a behavioural test, and it is here because the field is
   * inert without its caller: `classifyReplaySecretRegion`'s region-LESS arm can
   * only ever fire if something passes the list, and the only caller that does
   * is `cdkd rollback`. Deleting that one expression would leave every unit test
   * above passing while the arm went dark in production.
   *
   * Deliberately does NOT assert that `deploy-engine.ts` is still UNwired — that
   * site should be wired, and a fence forbidding it would fail the person doing
   * the right thing. See `RollbackExecutorContext.importedProducerRegions`.
   */
  it('passes producerRegionsFromState(baseState) into the executor context', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/cli/commands/rollback.ts', import.meta.url)),
      'utf8'
    );
    expect(source).toContain('importedProducerRegions: producerRegionsFromState(baseState)');
    expect(source).toContain('producerRegionsFromState,');
  });
});
