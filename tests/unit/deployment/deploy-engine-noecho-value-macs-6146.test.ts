/**
 * go-to-k/cdkd#6146, through the real `DeployEngine` / `DiffCalculator` /
 * resolver: a write-only property a `NoEcho` parameter feeds is re-sent only
 * when the value changed, decided by a KMS MAC of the value it was last sent.
 * KMS is a local HMAC double, so the MACs are real MACs of what the engine
 * asks for.
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logs = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
    };
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(record('debug')),
    info: vi.fn(record('info')),
    warn: vi.fn(record('warn')),
    error: vi.fn(record('error')),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** The KMS double: HMAC-SHA256 under a local key, or a scripted failure. */
const kms = vi.hoisted(() => ({
  constructed: 0,
  calls: [] as Array<{ KeyId: string; Message: Uint8Array }>,
  keyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
  secret: 'local-hmac-key-6146',
  fail: undefined as undefined | { name: string; message: string },
  /** Fail every call from this 0-based index on, not the ones before it. */
  failFrom: undefined as number | undefined,
  delayMs: 0,
}));
vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { createHmac: hmac } = await import('node:crypto');
  class FakeKMSClient {
    constructor(_config?: unknown) {
      kms.constructed++;
    }
    async send(command: { input: { KeyId: string; Message: Uint8Array } }): Promise<unknown> {
      kms.calls.push(command.input);
      if (kms.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, kms.delayMs));
      if (kms.failFrom !== undefined && kms.calls.length > kms.failFrom) {
        throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      }
      if (kms.fail !== undefined) {
        throw Object.assign(new Error(kms.fail.message), { name: kms.fail.name });
      }
      return {
        KeyId: kms.keyArn,
        Mac: new Uint8Array(hmac('sha256', kms.secret).update(command.input.Message).digest()),
      };
    }
    destroy(): void {}
  }
  return { ...actual, KMSClient: FakeKMSClient };
});
const secretVersion = vi.hoisted(() => ({ id: 'a1b2c3d4-0000-1111-2222-333333333333' }));
const secretAnswer = vi.hoisted(
  () => async (): Promise<unknown> => ({
    SecretString: JSON.stringify({ queue: 'q-6146' }),
    VersionId: secretVersion.id,
  })
);
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    send(): Promise<unknown> {
      return secretAnswer();
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: () => secretAnswer(),
      config: { region: () => Promise.resolve(region) },
    },
    credentialConfig: {},
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1') };
});
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));
// The REST API's schema declares `Body` write-only; every other type's lookup
// fails (DescribeType is unavailable here), which reads as unknown.
vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/write-only-properties.js')>();
  return {
    ...actual,
    tryGetTopLevelWriteOnlyProperties: async (type: string) =>
      type === 'AWS::ApiGateway::RestApi' ? new Set(['Body', 'BodyS3Location']) : undefined,
  };
});

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
import {
  formatNoEchoMac,
  noEchoMacBinding,
  noEchoMacMessage,
} from '../../../src/deployment/noecho-value-macs.js';
import { previewNoEchoMacChanges } from '../../../src/cli/commands/diff-recursive/noecho-macs.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

const OLD = 'old-noecho-value-6146';
const NEW = 'new-noecho-value-6146';

beforeEach(() => {
  logs.length = 0;
  kms.constructed = 0;
  kms.calls.length = 0;
  kms.fail = undefined;
  kms.failFrom = undefined;
  kms.delayMs = 0;
  secretVersion.id = 'a1b2c3d4-0000-1111-2222-333333333333';
  kms.keyArn = 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555';
});

/** The MAC the engine stamps for `value` of parameter `Token` in stack `s`. */
function macOf(value: string, keyArn = kms.keyArn): string {
  const message = noEchoMacMessage(noEchoMacBinding(undefined, 's', 'us-east-1'), 'Token', value)!;
  return formatNoEchoMac({ keyArn, mac: createHmac('sha256', kms.secret).update(message).digest() });
}

interface Run {
  thrown: unknown;
  updated: string[];
  changed: Record<string, string[] | undefined>;
  noEchoOnly: Record<string, string[] | undefined>;
  saved: StackState | undefined;
}

async function deploy(opts: {
  state: StackState;
  template: CloudFormationTemplate;
  readBack?: Record<string, unknown>;
  /** The provider leaves these keys unsent (the #6140 stop-gap). */
  keep?: string[];
  levels?: string[][];
  /** The provider's update throws after sending (a later call of it failed). */
  updateFails?: boolean;
  /** The provider's update refuses as unsupported (the engine replaces). */
  updateUnsupported?: boolean;
  noRollback?: boolean;
}): Promise<Run> {
  const levels = opts.levels ?? [['R']];
  const changed: Record<string, string[] | undefined> = {};
  const noEchoOnly: Record<string, string[] | undefined> = {};
  const updated: string[] = [];
  let saved: StackState | undefined;
  const provider = {
    create: vi.fn(async () => ({ physicalId: 'created', attributes: {} })),
    update: vi.fn(
      async (
        id: string,
        pid: string,
        _t: string,
        _p: Record<string, unknown>,
        _prev: Record<string, unknown>,
        context?: UpdateContext
      ) => {
        updated.push(id);
        changed[id] = context?.changedProperties && [...context.changedProperties].sort();
        noEchoOnly[id] =
          context?.noEchoOnlyChangedProperties && [...context.noEchoOnlyChangedProperties].sort();
        for (const key of opts.keep ?? []) context?.keptNoEchoOnlyProperty?.(key);
        if (opts.updateUnsupported === true) {
          throw Object.assign(new Error('no update handler'), { name: 'UnsupportedActionException' });
        }
        if (opts.updateFails === true) {
          throw Object.assign(new Error('UpdateRestApi failed after the put'), { name: 'BadRequestException' });
        }
        return { physicalId: pid, attributes: {} };
      }
    ),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn(async () => opts.readBack),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn(async () => ({ state: structuredClone(opts.state), etag: 'e0' })),
      saveState: vi.fn(async (_n: string, _r: string, state: StackState) => {
        saved = structuredClone(state);
        return 'etag';
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue(levels),
      getDirectDependencies: vi.fn((_g: unknown, id: string) =>
        levels.findIndex((l) => l.includes(id)) > 0 ? levels[0]! : []
      ),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      forceStatefulRecreation: true,
      captureObservedState: false,
      ...(opts.noRollback === true && { noRollback: true }),
    },
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('s', opts.template).catch((e: unknown) => {
    thrown = e;
  });
  return { thrown, updated, changed, noEchoOnly, saved };
}

const stateOf = (resources: Record<string, ResourceState>): StackState =>
  ({ version: 16, stackName: 's', region: 'us-east-1', resources, outputs: {}, lastModified: 0 }) as StackState;

const VALUE_TEMPLATE = { Ref: 'Token' };
const template = (value: string, description = 'd', extra: Record<string, unknown> = {}): CloudFormationTemplate =>
  ({
    Parameters: { Token: { Type: 'String', NoEcho: true, Default: value } },
    Resources: {
      R: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/p/r', Type: 'String', Value: VALUE_TEMPLATE, Description: description, ...extra },
      },
    },
  }) as CloudFormationTemplate;

/** A record whose Value was last sent `sent` (its MAC), `undefined` for none. */
const record = (macs?: Record<string, string>, extra: Partial<ResourceState> = {}): ResourceState =>
  ({
    physicalId: '/p/r',
    resourceType: 'AWS::SSM::Parameter',
    properties: { Name: '/p/r', Type: 'String', Value: '***', Description: 'd' },
    attributes: {},
    dependencies: [],
    noEchoLeaves: [['Value']],
    maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(VALUE_TEMPLATE) },
    ...(macs !== undefined && { noEchoValueMacs: { Value: macs } }),
    ...extra,
  }) as ResourceState;

/** No log line carries a value or a MAC, whatever the verdict. */
function expectNoValueOrMacLogged(...macs: string[]): void {
  const text = logs.join('\n');
  for (const needle of [OLD, NEW, ...macs.map((mac) => mac.slice(mac.lastIndexOf(':') + 1))]) {
    expect(text).not.toContain(needle);
  }
}

describe('NoEcho value MACs on the UPDATE arm (go-to-k/cdkd#6146)', () => {
  it('a write-only value whose MAC matches is not re-sent, and nothing moved', async () => {
    const run = await deploy({ state: stateOf({ R: record({ Token: macOf(OLD) }) }), template: template(OLD) });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual([]);
    expect(logs.some((l) => l.includes('re-sending'))).toBe(false);
    // One GenerateMac for the one NoEcho parameter, by alias.
    expect(kms.calls.map((c) => c.KeyId)).toEqual(['alias/cdkd-noecho-mac']);
    expectNoValueOrMacLogged(macOf(OLD));
  });

  it('a value whose MAC differs is sent as a change, never a NoEcho-only one, and the new MAC is stamped', async () => {
    const run = await deploy({ state: stateOf({ R: record({ Token: macOf(OLD) }) }), template: template(NEW) });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['R']);
    expect(run.changed['R']).toEqual(['Value']);
    expect(run.noEchoOnly['R']).toEqual([]);
    expect(run.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: macOf(NEW) } });
    expect(logs.some((l) => l.includes('changed since the last deploy'))).toBe(true);
    // The proven change replaces the "cannot tell" re-send line (both polarities:
    // the no-MAC case below prints it).
    expect(logs.some((l) => l.includes('re-sending Value, fed by a NoEcho parameter'))).toBe(false);
    expectNoValueOrMacLogged(macOf(OLD), macOf(NEW));
  });

  it('beside another change, a type that reads nothing back re-sends the key as before (the MAC needs a readback saying AWS does not report it)', async () => {
    const run = await deploy({
      state: stateOf({ R: record({ Token: macOf(OLD) }) }),
      template: template(OLD, 'd2'),
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['R']);
    expect(run.changed['R']).toEqual(['Description', 'Value']);
    expect(run.noEchoOnly['R']).toEqual(['Value']);
    // Re-sent with today's value: the MAC is restamped, equal to the old one.
    expect(run.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: macOf(OLD) } });
  });

  it('no MAC on the record: re-sent once, then stamped, and the next deploy skips it', async () => {
    const first = await deploy({ state: stateOf({ R: record() }), template: template(OLD) });
    expect(first.updated).toEqual(['R']);
    expect(logs.some((l) => l.includes('re-sending Value, fed by a NoEcho parameter'))).toBe(true);
    expect(first.noEchoOnly['R']).toEqual(['Value']);
    expect(first.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: macOf(OLD) } });
    const second = await deploy({ state: first.saved!, template: template(OLD) });
    expect(second.thrown).toBeUndefined();
    expect(second.updated).toEqual([]);
  });

  it('a MAC from another key (a re-created key) is no MAC: re-sent once', async () => {
    const stale = macOf(OLD, 'arn:aws:kms:us-east-1:123456789012:key/99999999-0000-0000-0000-000000000000');
    const run = await deploy({ state: stateOf({ R: record({ Token: stale }) }), template: template(OLD) });
    expect(run.updated).toEqual(['R']);
    expect(run.noEchoOnly['R']).toEqual(['Value']);
    expect(run.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: macOf(OLD) } });
  });

  it('a template edit inside the masked leaf is sent whatever the MAC says (fingerprint bound)', async () => {
    const run = await deploy({
      state: stateOf({ R: record({ Token: macOf(OLD) }) }),
      template: {
        ...template(OLD),
        Resources: {
          R: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Name: '/p/r',
              Type: 'String',
              Value: { 'Fn::Join': ['', ['x-', { Ref: 'Token' }]] },
              Description: 'd',
            },
          },
        },
      } as CloudFormationTemplate,
    });
    expect(run.updated).toEqual(['R']);
    expect(run.changed['R']).toEqual(['Value']);
  });

  it.each([
    ['the key is missing', 'NotFoundException', 'debug'],
    ['the permission is missing', 'AccessDeniedException', 'info'],
    ['KMS throttles', 'ThrottlingException', 'info'],
  ])('%s: behaves as before, logs only the error name, stamps nothing', async (_l, name, level) => {
    // The error MESSAGE carries the plaintext: it must never be logged.
    kms.fail = { name, message: `kms said ${OLD}` };
    const run = await deploy({ state: stateOf({ R: record({ Token: macOf(OLD) }) }), template: template(OLD) });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['R']);
    expect(run.noEchoOnly['R']).toEqual(['Value']);
    expect(run.saved?.resources['R']?.noEchoValueMacs).toBeUndefined();
    const line = logs.find((l) => l.includes('NoEcho value MACs'));
    expect(line?.startsWith(level)).toBe(true);
    expect(line).toContain(name === 'NotFoundException' ? 'no KMS key' : name);
    // One failed call, never one per parameter or resource.
    expect(kms.calls).toHaveLength(1);
    expectNoValueOrMacLogged(macOf(OLD));
    expect(logs.some((l) => l.includes('kms said'))).toBe(false);
  });

  it('a key the provider left unsent keeps its previous MAC entry', async () => {
    // No verdict (a MAC from another key), so Value is NoEcho-only and the
    // provider keeps it unsent: the entry describing what AWS holds stays.
    const stale = macOf(OLD, 'arn:aws:kms:us-east-1:123456789012:key/99999999-0000-0000-0000-000000000000');
    const kept = await deploy({
      state: stateOf({ R: record({ Token: stale }) }),
      template: template(NEW),
      keep: ['Value'],
    });
    expect(kept.noEchoOnly['R']).toEqual(['Value']);
    expect(kept.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: stale } });
    // A differing MAC makes Value a change, not NoEcho-only: the keep is ignored.
    const sent = await deploy({
      state: stateOf({ R: record({ Token: macOf(OLD) }) }),
      template: template(NEW),
      keep: ['Value'],
    });
    expect(sent.noEchoOnly['R']).toEqual([]);
    expect(sent.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: macOf(NEW) } });
  });

  it('an update that fails after sending the new value drops its MAC, so the next deploy re-sends', async () => {
    // AWS may now hold NEW, the record's MAC says OLD: a later deploy of OLD
    // must not match it and skip (the failed update left the value unknown).
    const failed = await deploy({
      state: stateOf({ R: record({ Token: macOf(OLD) }) }),
      template: template(NEW),
      updateFails: true,
      noRollback: true,
    });
    expect(failed.thrown).toBeDefined();
    expect(failed.updated).toEqual(['R']);
    expect(failed.saved?.resources['R']?.noEchoValueMacs?.['Value']).toBeUndefined();
    const next = await deploy({ state: failed.saved!, template: template(OLD) });
    expect(next.thrown).toBeUndefined();
    expect(next.updated).toEqual(['R']);
    expect(next.changed['R']).toContain('Value');
  });

  it('another parameter whose GenerateMac failed leaves a property reading only Token its verdict', async () => {
    kms.failFrom = 1; // Token is MAC'd first (sorted), Zed's call throttles
    const t = template(OLD);
    (t.Parameters as Record<string, unknown>)['Zed'] = { Type: 'String', NoEcho: true, Default: 'zed-6146' };
    const run = await deploy({ state: stateOf({ R: record({ Token: macOf(OLD) }) }), template: t });
    expect(run.thrown).toBeUndefined();
    expect(kms.calls).toHaveLength(2);
    expect(run.updated).toEqual([]);
    expect(logs.some((l) => l.includes('1 of 2 unavailable (ThrottlingException'))).toBe(true);
  });

  it('a run whose MACs failed still keeps an unsent key at its previous entry', async () => {
    kms.fail = { name: 'ThrottlingException', message: 'slow down' };
    const run = await deploy({
      state: stateOf({ R: record({ Token: macOf(OLD) }) }),
      template: template(OLD, 'd2'),
      keep: ['Value'],
    });
    expect(run.noEchoOnly['R']).toEqual(['Value']);
    expect(run.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: macOf(OLD) } });
  });

  it.each([
    ['a plain parameter', { 'Fn::Sub': '${Token}-${Plain}' }],
    ['a resource attribute', { 'Fn::Join': ['-', [{ Ref: 'Token' }, { 'Fn::GetAtt': ['Other', 'Arn'] }]] }],
    ['a condition', { 'Fn::If': ['Always', { Ref: 'Token' }, 'x'] }],
    [
      'a {{resolve:}} token joined into the same leaf',
      { 'Fn::Join': ['-', [{ Ref: 'Token' }, '{{resolve:secretsmanager:s6146:SecretString:queue::}}']] },
    ],
  ])('a matching MAC does not settle a key that also reads %s: re-sent as before', async (_l, value) => {
    const run = await deploy({
      levels: [['Other'], ['R']],
      state: stateOf({
        Other: { physicalId: 'o-1', resourceType: 'AWS::Test::Other', properties: {}, attributes: { Arn: 'arn:o' }, dependencies: [] } as ResourceState,
        R: record({ Token: macOf(OLD) }, { maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(value) } }),
      }),
      template: {
        Parameters: {
          Token: { Type: 'String', NoEcho: true, Default: OLD },
          Plain: { Type: 'String', Default: 'plain-6146' },
        },
        Conditions: { Always: { 'Fn::Equals': ['a', 'a'] } },
        Resources: {
          Other: { Type: 'AWS::Test::Other', Properties: {} },
          R: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/p/r', Type: 'String', Value: value, Description: 'd' } },
        },
      } as CloudFormationTemplate,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toContain('R');
    expect(run.changed['R']).toContain('Value');
  });

  it('a create-only key fed by a NoEcho value is never sent in place, so it keeps its previous MAC', async () => {
    const NAME_TEMPLATE = { Ref: 'Token' };
    const run = await deploy({
      state: stateOf({
        R: {
          physicalId: 'p-1',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '***', Type: 'String', Value: 'v', Description: 'd' },
          attributes: {},
          dependencies: [],
          noEchoLeaves: [['Name']],
          maskedPropertyFingerprints: { Name: maskedPropertyFingerprint(NAME_TEMPLATE) },
          noEchoValueMacs: { Name: { Token: macOf(OLD) } },
        } as ResourceState,
      }),
      template: {
        Parameters: { Token: { Type: 'String', NoEcho: true, Default: NEW } },
        Resources: {
          R: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: NAME_TEMPLATE, Type: 'String', Value: 'v', Description: 'd2' },
          },
        },
      } as CloudFormationTemplate,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['R']);
    expect(run.saved?.resources['R']?.physicalId).toBe('p-1');
    expect(run.saved?.resources['R']?.noEchoValueMacs).toEqual({ Name: { Token: macOf(OLD) } });
  });

  it('a CREATE stamps a MAC bound to the stack instance id, and the next deploy compares it', async () => {
    const empty = { ...stateOf({}), stackInstanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } as StackState;
    const created = await deploy({ state: empty, template: template(OLD) });
    expect(created.thrown).toBeUndefined();
    const message = noEchoMacMessage(noEchoMacBinding('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 's', 'us-east-1'), 'Token', OLD)!;
    const expected = formatNoEchoMac({ keyArn: kms.keyArn, mac: createHmac('sha256', kms.secret).update(message).digest() });
    expect(created.saved?.stackInstanceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(created.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: expected } });
    // The legacy binding is a different MAC: the instance id is what binds it.
    expect(expected).not.toBe(macOf(OLD));
    const again = await deploy({ state: created.saved!, template: template(OLD) });
    expect(again.thrown).toBeUndefined();
    expect(again.updated).toEqual([]);
  });

  it('a slow KMS is waited for: the comparison and the save still see the MACs', async () => {
    kms.delayMs = 40;
    const run = await deploy({ state: stateOf({ R: record() }), template: template(OLD) });
    expect(run.saved?.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: macOf(OLD) } });
    const second = await deploy({ state: run.saved!, template: template(OLD) });
    expect(second.thrown).toBeUndefined();
    expect(second.updated).toEqual([]);
  });

  it('a NoEcho value reaching the property by another route than its own Ref is no verdict: re-sent', async () => {
    // `b` reads another resource's attribute holding the value in the clear
    // (a record no v11 binary rewrote): the MAC of Token says nothing about it.
    const CONFIG = { a: { Ref: 'Token' }, b: { 'Fn::GetAtt': ['Other', 'Echo'] } };
    const run = await deploy({
      levels: [['Other'], ['R']],
      state: stateOf({
        Other: {
          physicalId: 'o-1',
          resourceType: 'AWS::Test::Other',
          properties: { Seed: 's' },
          attributes: { Echo: OLD },
          dependencies: [],
        } as ResourceState,
        R: {
          physicalId: 'r-1',
          resourceType: 'AWS::Test::Thing',
          properties: { Config: { a: '***', b: '***' } },
          attributes: {},
          dependencies: ['Other'],
          noEchoLeaves: [['Config', 'a']],
          maskedPropertyFingerprints: { Config: maskedPropertyFingerprint(CONFIG) },
          noEchoValueMacs: { Config: { Token: macOf(OLD) } },
        } as ResourceState,
      }),
      template: {
        Parameters: { Token: { Type: 'String', NoEcho: true, Default: OLD } },
        Resources: {
          Other: { Type: 'AWS::Test::Other', Properties: { Seed: 's' } },
          R: { Type: 'AWS::Test::Thing', Properties: { Config: CONFIG } },
        },
      } as CloudFormationTemplate,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['R']);
    expect(run.noEchoOnly['R']).toEqual(['Config']);
  });

  it('a value AWS reports differently is sent whatever the MAC says (the readback decides a readable key)', async () => {
    const run = await deploy({
      state: stateOf({ R: record({ Token: macOf(OLD) }) }),
      template: template(OLD),
      readBack: { Name: '/p/r', Type: 'String', Value: 'drifted-6146', Description: 'd' },
    });
    expect(run.updated).toEqual(['R']);
    expect(run.changed['R']).toEqual(['Value']);
  });
});

describe('a stack with no NoEcho parameter (go-to-k/cdkd#6146 regression)', () => {
  it('builds no KMS client, calls no GenerateMac, and writes no MAC field', async () => {
    const run = await deploy({
      state: stateOf({
        R: {
          physicalId: '/p/r',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/p/r', Type: 'String', Value: 'a' },
          attributes: {},
          dependencies: [],
        } as ResourceState,
      }),
      template: {
        Resources: {
          R: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/p/r', Type: 'String', Value: 'b' } },
        },
      } as CloudFormationTemplate,
    });
    expect(run.updated).toEqual(['R']);
    expect(kms.constructed).toBe(0);
    expect(kms.calls).toHaveLength(0);
    expect(JSON.stringify(run.saved)).not.toContain('noEchoValueMacs');
  });

  it('a NoEcho parameter no resource reads builds no KMS client either', async () => {
    const run = await deploy({
      state: stateOf({
        R: {
          physicalId: '/p/r',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/p/r', Type: 'String', Value: 'a' },
          attributes: {},
          dependencies: [],
        } as ResourceState,
      }),
      template: {
        Parameters: { Token: { Type: 'String', NoEcho: true, Default: OLD } },
        Resources: {
          R: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/p/r', Type: 'String', Value: 'b' } },
        },
      } as CloudFormationTemplate,
    });
    expect(run.updated).toEqual(['R']);
    expect(kms.constructed).toBe(0);
  });
});

describe('a definition-bodied REST API fed by a NoEcho value (go-to-k/cdkd#6146 decision 2)', () => {
  const REF = '{{resolve:secretsmanager:s6146:SecretString:queue::}}';
  const BODY_TEMPLATE = { openapi: '3.0.1', info: { title: 't', version: '1' }, 'x-token': { Ref: 'Token' } };
  const apiTemplate = (value: string): CloudFormationTemplate =>
    ({
      Parameters: { Token: { Type: 'String', NoEcho: true, Default: value } },
      Resources: { R: { Type: 'AWS::ApiGateway::RestApi', Properties: { Body: BODY_TEMPLATE } } },
    }) as CloudFormationTemplate;
  const apiRecord = (macs?: Record<string, string>): ResourceState =>
    ({
      physicalId: 'api1',
      resourceType: 'AWS::ApiGateway::RestApi',
      properties: { Body: { openapi: '3.0.1', info: { title: 't', version: '1' }, 'x-token': '***' } },
      attributes: { RootResourceId: 'root1' },
      dependencies: [],
      noEchoLeaves: [['Body', 'x-token']],
      maskedPropertyFingerprints: { Body: maskedPropertyFingerprint(BODY_TEMPLATE) },
      provisionedBy: 'sdk',
      ...(macs !== undefined && { noEchoValueMacs: { Body: macs } }),
    }) as ResourceState;

  it('no MAC: the Body is NoEcho-only, so the provider keeps the stop-gap', async () => {
    const run = await deploy({ state: stateOf({ R: apiRecord() }), template: apiTemplate(OLD), keep: ['Body'] });
    expect(run.noEchoOnly['R']).toEqual(['Body']);
    // Kept unsent: no MAC is stamped, so the stop-gap stands until a Body put.
    expect(run.saved?.resources['R']?.noEchoValueMacs).toBeUndefined();
  });

  it('a matching MAC: no update at all, so no put', async () => {
    const run = await deploy({
      state: stateOf({ R: apiRecord({ Token: macOf(OLD) }) }),
      template: apiTemplate(OLD),
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual([]);
  });

  it('a Body kept unsent and then replaced by the update-failure fallback is stamped: the create sent it', async () => {
    const run = await deploy({
      state: stateOf({ R: apiRecord() }),
      template: apiTemplate(OLD),
      keep: ['Body'],
      updateUnsupported: true,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.saved?.resources['R']?.physicalId).toBe('created');
    expect(run.saved?.resources['R']?.noEchoValueMacs).toEqual({ Body: { Token: macOf(OLD) } });
  });

  it('beside another change (no readback), the schema-write-only Body is decided by its MAC', async () => {
    const withDescription = (value: string): CloudFormationTemplate => {
      const t = apiTemplate(value);
      (t.Resources['R']!.Properties as Record<string, unknown>)['Description'] = 'phase-2';
      return t;
    };
    const same = await deploy({ state: stateOf({ R: apiRecord({ Token: macOf(OLD) }) }), template: withDescription(OLD) });
    expect(same.thrown).toBeUndefined();
    expect(same.changed['R']).toEqual(['Description']);
    expect(same.noEchoOnly['R']).toEqual([]);
    const moved = await deploy({ state: stateOf({ R: apiRecord({ Token: macOf(OLD) }) }), template: withDescription(NEW) });
    expect(moved.thrown).toBeUndefined();
    expect(moved.changed['R']).toEqual(['Body', 'Description']);
    expect(moved.noEchoOnly['R']).toEqual([]);
  });

  it('a differing MAC: Body is a change, not NoEcho-only, so it is put', async () => {
    const run = await deploy({
      state: stateOf({ R: apiRecord({ Token: macOf(OLD) }) }),
      template: apiTemplate(NEW),
    });
    expect(run.changed['R']).toEqual(['Body']);
    expect(run.noEchoOnly['R']).toEqual([]);
  });

  it('a Body also holding an unchanged {{resolve:}} reference takes the same verdicts (the reference is compared as its token)', async () => {
    const withRef = { ...BODY_TEMPLATE, 'x-ref': REF };
    const t = (value: string): CloudFormationTemplate =>
      ({
        Parameters: { Token: { Type: 'String', NoEcho: true, Default: value } },
        Resources: { R: { Type: 'AWS::ApiGateway::RestApi', Properties: { Body: withRef } } },
      }) as CloudFormationTemplate;
    const r = (): ResourceState => {
      const base = apiRecord({ Token: macOf(OLD) });
      (base.properties['Body'] as Record<string, unknown>)['x-ref'] = REF;
      base.maskedPropertyFingerprints = { Body: maskedPropertyFingerprint(withRef) };
      return base;
    };
    const same = await deploy({ state: stateOf({ R: r() }), template: t(OLD) });
    expect(same.thrown).toBeUndefined();
    expect(same.updated).toEqual([]);
    const moved = await deploy({ state: stateOf({ R: r() }), template: t(NEW) });
    expect(moved.changed['R']).toEqual(['Body']);
    expect(moved.noEchoOnly['R']).toEqual([]);
    // A literal reference whose secret got a new version is still compared as
    // its token (CloudFormation does not re-send on a rotation): no update.
    secretVersion.id = 'ffffffff-0000-1111-2222-333333333333';
    const rotated = await deploy({ state: stateOf({ R: r() }), template: t(OLD) });
    expect(rotated.thrown).toBeUndefined();
    expect(rotated.updated).toEqual([]);
  });
});

describe('cdkd diff agrees with the deploy (go-to-k/cdkd#6146 parity)', () => {
  const sources = { parameters: new Set(['Token']) };
  const BODY = { openapi: '3.0.1', info: { title: 't', version: '1' }, 'x-token': { Ref: 'Token' } };
  const restTemplate = (value: string): CloudFormationTemplate =>
    ({
      Parameters: { Token: { Type: 'String', NoEcho: true, Default: value } },
      Resources: { R: { Type: 'AWS::ApiGateway::RestApi', Properties: { Body: BODY } } },
    }) as CloudFormationTemplate;
  const restRecord = (): ResourceState =>
    ({
      physicalId: 'api1',
      resourceType: 'AWS::ApiGateway::RestApi',
      properties: { Body: { openapi: '3.0.1', info: { title: 't', version: '1' }, 'x-token': '***' } },
      attributes: { RootResourceId: 'root1' },
      dependencies: [],
      noEchoLeaves: [['Body', 'x-token']],
      maskedPropertyFingerprints: { Body: maskedPropertyFingerprint(BODY) },
      provisionedBy: 'sdk',
    }) as ResourceState;
  const change = (type: string, key: string): ResourceChange =>
    ({
      logicalId: 'R',
      resourceType: type,
      changeType: 'NO_CHANGE',
      currentProperties: { [key]: '***' },
      desiredProperties: { [key]: '***' },
    }) as ResourceChange;
  const preview = async (
    state: StackState,
    value: string,
    tpl: CloudFormationTemplate,
    type: string,
    key: string,
    nestedChild = false
  ) => {
    const changes = new Map([['R', change(type, key)]]);
    const moved = await previewNoEchoMacChanges({
      changes,
      template: tpl,
      resources: state.resources,
      parameterValues: { Token: value },
      sources,
      nestedChild,
      stackName: 's',
      region: 'us-east-1',
      stackInstanceId: state.stackInstanceId,
      logger: { debug: () => undefined, info: () => undefined },
    });
    return { moved, change: changes.get('R')! };
  };

  it('what the deploy stamped, the diff compares: unchanged shows nothing, changed shows the property', async () => {
    const deployed = await deploy({ state: stateOf({ R: restRecord() }), template: restTemplate(OLD), keep: [] });
    expect(deployed.saved?.resources['R']?.noEchoValueMacs).toEqual({ Body: { Token: macOf(OLD) } });
    const unchanged = await preview(deployed.saved!, OLD, restTemplate(OLD), 'AWS::ApiGateway::RestApi', 'Body');
    expect(unchanged.moved).toEqual([]);
    expect(unchanged.change.changeType).toBe('NO_CHANGE');
    const changed = await preview(deployed.saved!, NEW, restTemplate(NEW), 'AWS::ApiGateway::RestApi', 'Body');
    expect(changed.moved).toEqual(['R.Body']);
    expect(changed.change.changeType).toBe('UPDATE');
    // And the deploy over the same state sends exactly that property.
    const redeploy = await deploy({ state: deployed.saved!, template: restTemplate(NEW) });
    expect(redeploy.thrown).toBeUndefined();
    expect(redeploy.changed['R']).toEqual(['Body']);
    expect(redeploy.noEchoOnly['R']).toEqual([]);
  });

  it('a readable key whose MAC differs: the diff claims nothing, as the deploy lets AWS decide it', async () => {
    // AWS already holds NEW (the readback says so): the deploy skips, so the
    // diff must not say "the deploy sends it".
    const state = stateOf({ R: record({ Token: macOf(OLD) }) });
    const shown = await preview(state, NEW, template(NEW), 'AWS::SSM::Parameter', 'Value');
    expect(shown.moved).toEqual([]);
    const run = await deploy({
      state,
      template: template(NEW),
      readBack: { Name: '/p/r', Type: 'String', Value: NEW, Description: 'd' },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual([]);
  });

  it('makes no KMS call when no record carries MACs, nor for a nested child', async () => {
    await preview(stateOf({ R: restRecord() }), NEW, restTemplate(NEW), 'AWS::ApiGateway::RestApi', 'Body');
    expect(kms.constructed).toBe(0);
    const withMacs = { ...restRecord(), noEchoValueMacs: { Body: { Token: macOf(OLD) } } } as ResourceState;
    await preview(stateOf({ R: withMacs }), NEW, restTemplate(NEW), 'AWS::ApiGateway::RestApi', 'Body', true);
    expect(kms.constructed).toBe(0);
  });
});
