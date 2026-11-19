/**
 * go-to-k/cdkd#6591: a rollback whose secret revert REGENERATES the value
 * (`GenerateSecretString` changed) restores a reader of that secret with the
 * value the secret holds after its revert, as CloudFormation does. Reverse
 * completion order reverted the reader first, at the version its record
 * pinned (#4852), leaving it a password the secret no longer holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const secret = vi.hoisted(() => ({
  value: '',
  version: '',
  history: {} as Record<string, string>,
  lookups: [] as string[],
}));
const answer = vi.hoisted(() => async (command?: unknown): Promise<unknown> => {
  const input = (command as { input?: { SecretId?: string; VersionId?: string } } | undefined)
    ?.input;
  secret.lookups.push(`${String(input?.SecretId)}@${input?.VersionId ?? ''}`);
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
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: (command: unknown) => answer(command),
      config: { region: () => Promise.resolve(region) },
    },
    credentialConfig: {},
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1'), setAwsClients: vi.fn(), AwsClients: vi.fn() };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    send(command: unknown): Promise<unknown> {
      return answer(command);
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { planRollback } from '../../../src/deployment/rollback-executor/plan.js';
import { resolveReplayProps } from '../../../src/deployment/rollback-executor/replay-props.js';
import { ReplayResolvers } from '../../../src/deployment/rollback-executor/replay-secrets.js';
import {
  orderAfterRegeneratedSecrets,
  regeneratedSecretAddresses,
  revertRegeneratesSecret,
  secretsManagerTokenSecretId,
} from '../../../src/deployment/rollback-executor/regenerated-secrets.js';
import type { ResourceState } from '../../../src/types/state.js';

const SECRET = 'AWS::SecretsManager::Secret';
const FN = 'AWS::Lambda::Function';
const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hunt-sec-AbCdEf';
const REF = `{{resolve:secretsmanager:${ARN}:SecretString:password::}}`;
const PRE = 'a1b2c3d4-0000-1111-2222-000000000001'; // before the deploy
const FWD = 'a1b2c3d4-0000-1111-2222-000000000002'; // the failed deploy's
const RB = 'a1b2c3d4-0000-1111-2222-000000000003'; // the rollback's

const pw = (p: string): string => JSON.stringify({ username: 'u', password: p });

function rec(
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[] = [],
  extra: Partial<ResourceState> = {}
): ResourceState {
  return {
    physicalId,
    resourceType,
    properties,
    attributes: {},
    dependencies,
    provisionedBy: 'sdk',
    ...extra,
  };
}

const gen = (length: number): Record<string, unknown> => ({
  SecretStringTemplate: '{"username":"u"}',
  GenerateStringKey: 'password',
  PasswordLength: length,
});

const secretOp = (previousLength = 20): CompletedOperation => ({
  logicalId: 'Sec',
  changeType: 'UPDATE',
  resourceType: SECRET,
  provisionedBy: 'sdk',
  physicalId: ARN,
  previousState: rec(ARN, SECRET, { Name: 'hunt-sec', GenerateSecretString: gen(previousLength) }),
  oldResourceRetained: false,
});
const fnOp = (): CompletedOperation => ({
  logicalId: 'Fn',
  changeType: 'UPDATE',
  resourceType: FN,
  provisionedBy: 'sdk',
  physicalId: 'fn',
  previousState: rec('fn', FN, { Environment: { Variables: { PW: REF, PLAIN: 'one' } } }, ['Sec'], {
    referenceProvenance: { [REF]: { region: 'us-east-1', versions: [PRE] } },
  }),
  oldResourceRetained: false,
});
const state = (): Record<string, ResourceState> => ({
  Sec: rec(ARN, SECRET, { Name: 'hunt-sec', GenerateSecretString: gen(24) }),
  Fn: rec('fn', FN, { Environment: { Variables: { PW: REF, PLAIN: 'two' } } }, ['Sec'], {
    referenceProvenance: { [REF]: { region: 'us-east-1', versions: [FWD] } },
  }),
});

describe('rollback of a regenerated secret (#6591)', () => {
  let calls: string[];
  let sent: Record<string, unknown>;
  let ctx: RollbackExecutorContext;
  let failSecret: boolean;

  beforeEach(() => {
    calls = [];
    sent = {};
    failSecret = false;
    secret.history = { [PRE]: pw('pre-deploy-pw'), [FWD]: pw('forward-pw-24ch') };
    secret.value = pw('forward-pw-24ch');
    secret.version = FWD;
    secret.lookups = [];
    const provider = {
      create: vi.fn(),
      update: vi.fn(
        async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
          calls.push(`update ${logicalId}`);
          if (logicalId === 'Sec' && failSecret) throw new Error('AccessDeniedException');
          sent[logicalId] = props;
          // Reverting GenerateSecretString makes AWS generate a new value.
          if (logicalId === 'Sec') {
            secret.history[RB] = pw('rollback-pw');
            secret.value = pw('rollback-pw');
            secret.version = RB;
          }
          return { physicalId, wasReplaced: false, attributes: {} };
        }
      ),
      delete: vi.fn(),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    ctx = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
        getProvider: () => provider,
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
  });

  const fnPw = (): unknown =>
    (sent['Fn'] as { Environment: { Variables: { PW: unknown } } } | undefined)?.Environment
      .Variables.PW;

  it('reverts the secret first and restores the reader with the regenerated value', async () => {
    const s = state();
    // Completion order: the secret, then the function that reads it.
    const result = await replayRollback([secretOp(), fnOp()], s, 'S', ctx);
    expect(result.failures).toBe(0);
    expect(calls).toEqual(['update Sec', 'update Fn']);
    expect(fnPw()).toBe('rollback-pw');
    // The restored record keeps the token, never the plaintext.
    expect(JSON.stringify(s['Fn'])).not.toContain('rollback-pw');
    expect(s['Fn']!.properties['Environment']).toEqual({
      Variables: { PW: REF, PLAIN: 'one' },
    });
  });

  it('a token read before the secret reverted does not answer the reader from cache', async () => {
    const s = state();
    // A resource naming the secret by a literal ARN: no dependency, no pin, so
    // it reverts first (completed last) and reads the forward value.
    const paramOp: CompletedOperation = {
      logicalId: 'Param',
      changeType: 'UPDATE',
      resourceType: 'AWS::SSM::Parameter',
      provisionedBy: 'sdk',
      physicalId: '/p',
      previousState: rec('/p', 'AWS::SSM::Parameter', { Value: REF, Description: 'one' }),
      oldResourceRetained: false,
    };
    s['Param'] = rec('/p', 'AWS::SSM::Parameter', { Value: REF, Description: 'two' });
    const result = await replayRollback([secretOp(), fnOp(), paramOp], s, 'S', ctx);
    expect(result.failures).toBe(0);
    expect(calls).toEqual(['update Param', 'update Sec', 'update Fn']);
    expect((sent['Param'] as { Value: unknown }).Value).toBe('forward-pw-24ch');
    expect(fnPw()).toBe('rollback-pw');
  });

  it('keeps the pinned pre-deploy value when the secret revert does not regenerate', async () => {
    const s = state();
    // GenerateSecretString unchanged (a Description-only update): the record
    // pin is what the reader held.
    s['Sec'] = rec(ARN, SECRET, {
      Name: 'hunt-sec',
      Description: 'v2',
      GenerateSecretString: gen(20),
    });
    const op = secretOp(20);
    const result = await replayRollback([op, fnOp()], s, 'S', ctx);
    expect(result.failures).toBe(0);
    expect(calls).toEqual(['update Fn', 'update Sec']);
    expect(fnPw()).toBe('pre-deploy-pw');
  });

  it('a failed secret revert leaves the reader at its pinned value', async () => {
    const s = state();
    failSecret = true;
    const result = await replayRollback([secretOp(), fnOp()], s, 'S', ctx);
    expect(result.failures).toBe(1);
    expect(calls).toEqual(['update Sec', 'update Fn']);
    expect(fnPw()).toBe('pre-deploy-pw');
  });

  it('warns when an op depending on the reader keeps it before the secret', async () => {
    const s = state();
    const aliasOp: CompletedOperation = {
      logicalId: 'Alias',
      changeType: 'UPDATE',
      resourceType: 'AWS::Lambda::Alias',
      provisionedBy: 'sdk',
      physicalId: 'alias',
      previousState: rec('alias', 'AWS::Lambda::Alias', { Description: 'one' }, ['Fn']),
      oldResourceRetained: false,
    };
    s['Alias'] = rec('alias', 'AWS::Lambda::Alias', { Description: 'two' }, ['Fn']);
    // Completion order Sec, Alias, Fn: reversed, the alias sits between them.
    const result = await replayRollback([secretOp(), aliasOp, fnOp()], s, 'S', ctx);
    expect(result.failures).toBe(0);
    expect(calls).toEqual(['update Fn', 'update Alias', 'update Sec']);
    expect(fnPw()).toBe('pre-deploy-pw');
    const warned = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('before secret Sec') && m.includes("cdkd drift S --revert"))).toBe(true);
  });

  it('does not warn for a blocked op that names the secret without reading its value', async () => {
    const s = state();
    const mk = (id: string, props: Record<string, unknown>, deps: string[]): CompletedOperation => ({
      logicalId: id,
      changeType: 'UPDATE',
      resourceType: 'AWS::IAM::Policy',
      provisionedBy: 'sdk',
      physicalId: id,
      previousState: rec(id, 'AWS::IAM::Policy', props, deps),
      oldResourceRetained: false,
    });
    const policy = mk('Pol', { Resource: ARN, V: 1 }, ['Sec']);
    const dependent = mk('Dep', { V: 1 }, ['Pol']);
    s['Pol'] = rec('Pol', 'AWS::IAM::Policy', { Resource: ARN, V: 2 }, ['Sec']);
    s['Dep'] = rec('Dep', 'AWS::IAM::Policy', { V: 2 }, ['Pol']);
    await replayRollback([secretOp(), dependent, policy], s, 'S', ctx);
    expect(calls).toEqual(['update Pol', 'update Dep', 'update Sec']);
    const warned = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('before secret'))).toBe(false);
  });

  it('does not warn when the reader is moved after the secret', async () => {
    await replayRollback([secretOp(), fnOp()], state(), 'S', ctx);
    const warned = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('before secret'))).toBe(false);
  });

  it('a resumed rollback restores the reader at the current value after the secret already reverted (#6597)', async () => {
    const s = state();
    // An earlier replay already restored the secret (AWS regenerated it), then
    // stopped before the reader: the secret's record is its old one again.
    s['Sec'] = rec(ARN, SECRET, { Name: 'hunt-sec', GenerateSecretString: gen(20) });
    secret.history[RB] = pw('rollback-pw');
    secret.value = pw('rollback-pw');
    secret.version = RB;
    const op = secretOp();
    op.properties = { Name: 'hunt-sec', GenerateSecretString: gen(24) };
    const result = await replayRollback([op, fnOp()], s, 'S', ctx);
    expect(result.failures).toBe(0);
    // The secret's revert is a no-op now; the reader still follows it.
    expect(calls).not.toContain('update Sec');
    expect(fnPw()).toBe('rollback-pw');
  });

  it('the dry-run plan lists the same order', () => {
    const plan = planRollback([secretOp(), fnOp()], state());
    expect(plan.map((item) => item.op.logicalId)).toEqual(['Sec', 'Fn']);
  });
});

describe('orderAfterRegeneratedSecrets (#6591)', () => {
  it('moves a reader after the regenerated secret', () => {
    const ordered = orderAfterRegeneratedSecrets([fnOp(), secretOp()], state());
    expect(ordered.map((op) => op.logicalId)).toEqual(['Sec', 'Fn']);
  });

  it('leaves the order alone when nothing regenerates', () => {
    const s = state();
    s['Sec'] = rec(ARN, SECRET, { GenerateSecretString: gen(20) });
    const ordered = orderAfterRegeneratedSecrets([fnOp(), secretOp(20)], s);
    expect(ordered.map((op) => op.logicalId)).toEqual(['Fn', 'Sec']);
  });

  it('never moves a reader past an op that depends on it', () => {
    const dependent: CompletedOperation = {
      logicalId: 'Alias',
      changeType: 'UPDATE',
      resourceType: 'AWS::Lambda::Alias',
      provisionedBy: 'sdk',
      physicalId: 'alias',
      previousState: rec('alias', 'AWS::Lambda::Alias', {}, ['Fn']),
      oldResourceRetained: false,
    };
    const ordered = orderAfterRegeneratedSecrets([fnOp(), dependent, secretOp()], state());
    expect(ordered.map((op) => op.logicalId)).toEqual(['Fn', 'Alias', 'Sec']);
  });
});

describe('revertRegeneratesSecret (#6591)', () => {
  it('is true only for an in-place secret update whose GenerateSecretString changed', () => {
    expect(revertRegeneratesSecret(secretOp(), state())).toBe(true);
    expect(revertRegeneratesSecret(fnOp(), state())).toBe(false);
    const literal = secretOp();
    literal.previousState = rec(ARN, SECRET, { SecretString: 'x' });
    expect(revertRegeneratesSecret(literal, state())).toBe(false);
    const replaced = secretOp();
    replaced.previousState = rec(`${ARN}-old`, SECRET, { GenerateSecretString: gen(20) });
    expect(revertRegeneratesSecret(replaced, state())).toBe(false);
  });

  it('names the secret by its ARN and recorded Name', () => {
    expect([...regeneratedSecretAddresses(secretOp())]).toEqual([ARN, 'hunt-sec']);
  });
});

describe('secretsManagerTokenSecretId (#6591)', () => {
  it.each([
    [REF, ARN],
    ['{{resolve:secretsmanager:my-secret:SecretString:password::}}', 'my-secret'],
    ['{{resolve:secretsmanager:my-secret:SecretString}}', 'my-secret'],
    ['{{resolve:secretsmanager:my-secret}}', 'my-secret'],
    [`{{resolve:secretsmanager:${ARN}:SecretBinary}}`, ARN],
    ['{{resolve:ssm:/p}}', undefined],
  ])('%s -> %s', (token, id) => {
    expect(secretsManagerTokenSecretId(token)).toBe(id);
  });
});

describe('the pin skip by recorded Name (#6591)', () => {
  const NAMED = '{{resolve:secretsmanager:hunt-sec:SecretString:password::}}';
  beforeEach(() => {
    secret.history = { [PRE]: pw('pre-deploy-pw') };
    secret.value = pw('current-pw');
    secret.version = RB;
  });
  const replayNamed = async (region: string): Promise<unknown> => {
    const record = rec('fn', FN, { PW: NAMED }, [], {
      referenceProvenance: { [NAMED]: { region, versions: [PRE] } },
    });
    const resolved = await resolveReplayProps(
      record.properties,
      new ReplayResolvers('us-east-1', new Set(['hunt-sec'])),
      new Map(),
      { region: 'us-east-1' } as never,
      'Fn',
      record
    );
    return resolved?.['PW'];
  };

  it('resolves the current value for a name token recorded in the stack region', async () => {
    expect(await replayNamed('us-east-1')).toBe('current-pw');
  });

  it('keeps the pin for a name token recorded in another region', async () => {
    expect(await replayNamed('eu-west-1')).toBe('pre-deploy-pw');
  });
});
