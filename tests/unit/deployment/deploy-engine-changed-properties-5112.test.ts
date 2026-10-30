/**
 * go-to-k/cdkd#5112, through the real `DeployEngine` / `DiffCalculator` /
 * resolver: an in-place UPDATE hands the provider
 * `UpdateContext.changedProperties`, the top-level keys that changed TEMPLATE
 * to TEMPLATE, as CloudFormation compares. The state record is redacted (a
 * secret reference stays its token, a `NoEcho` value is `***`), so a provider
 * comparing it with the resolved desired bag cannot tell an unchanged secret
 * from a changed one; the engine compares the as-written bags instead.
 *
 * The set must INCLUDE every key whose redacted form hides a real move (a
 * masked property whose template moved, a secret read at a newer version, a
 * fresh `NoEcho` value AWS did not confirm, a previous side the engine
 * rewrote for the provider to act on), and EXCLUDE an unchanged stand-in.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
/** The secret's current value / VersionId, and each version's value. */
const secret = vi.hoisted(() => ({
  queue: 'chg-q-1',
  version: 'a1b2c3d4-0000-1111-2222-333333333333',
  history: {} as Record<string, string>,
}));
const answer = vi.hoisted(() => async (command?: unknown): Promise<unknown> => {
  const input = (command as { input?: { VersionId?: string } } | undefined)?.input;
  if (input?.VersionId !== undefined) {
    const queue = secret.history[input.VersionId];
    if (queue === undefined) {
      throw Object.assign(new Error('no such version'), { name: 'ResourceNotFoundException' });
    }
    return { SecretString: JSON.stringify({ queue }), VersionId: input.VersionId };
  }
  return { SecretString: JSON.stringify({ queue: secret.queue }), VersionId: secret.version };
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
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    send(command: unknown): Promise<unknown> {
      return answer(command);
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ReferenceProvenance, ResourceState, StackState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:chg:SecretString:queue::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const URL_1 = 'https://sqs.us-east-1.amazonaws.com/123456789012/chg-q-1';
const URL_2 = URL_1.replace('chg-q-1', 'chg-q-2');
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;

beforeEach(() => {
  secret.queue = 'chg-q-1';
  secret.version = V1;
  secret.history = { [V1]: 'chg-q-1' };
});

interface Run {
  thrown: unknown;
  /** `UpdateContext.changedProperties` per updated logical id, sorted. */
  changed: Record<string, string[] | undefined>;
  updated: string[];
  /** The previous side each update was handed. */
  previous: Record<string, Record<string, unknown>>;
  /** Every `readCurrentState` call, by logical id. */
  reads: string[];
  created: string[];
}

async function deploy(opts: {
  state: StackState;
  template: CloudFormationTemplate;
  levels?: string[][];
  readBack?: Record<string, unknown>;
  /** A provider result per logical id (an update's or a create's). */
  results?: Record<string, Record<string, unknown>>;
  options?: Record<string, unknown>;
}): Promise<Run> {
  const levels = opts.levels ?? [['R']];
  const changed: Record<string, string[] | undefined> = {};
  const updated: string[] = [];
  const created: string[] = [];
  const reads: string[] = [];
  const previous: Record<string, Record<string, unknown>> = {};
  const provider = {
    create: vi.fn(async (id: string) => {
      created.push(id);
      return opts.results?.[id] ?? { physicalId: 'created', attributes: {} };
    }),
    update: vi.fn(
      async (
        id: string,
        pid: string,
        _type: string,
        _props: Record<string, unknown>,
        prev: Record<string, unknown>,
        context?: UpdateContext
      ) => {
        updated.push(id);
        previous[id] = prev;
        changed[id] =
          context?.changedProperties === undefined ? undefined : [...context.changedProperties].sort();
        return opts.results?.[id] ?? { physicalId: pid, attributes: {} };
      }
    ),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn(async (_pid: string, id: string) => {
      reads.push(id);
      return opts.readBack;
    }),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn(async () => ({ state: opts.state, etag: 'e0' })),
      saveState: vi.fn().mockResolvedValue('etag'),
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
    { dryRun: false, forceStatefulRecreation: true, ...opts.options },
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('s', opts.template).catch((e: unknown) => {
    thrown = e;
  });
  return { thrown, changed, updated, previous, reads, created };
}

function stateOf(resources: Record<string, ResourceState>): StackState {
  return {
    version: 12,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as StackState;
}

function ssmRecord(properties: Record<string, unknown>, extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: '/p/r',
    resourceType: 'AWS::SSM::Parameter',
    properties,
    attributes: {},
    dependencies: [],
    ...extra,
  } as ResourceState;
}

const ssmTemplate = (
  properties: Record<string, unknown>,
  parameters?: CloudFormationTemplate['Parameters']
): CloudFormationTemplate =>
  ({
    ...(parameters !== undefined && { Parameters: parameters }),
    Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: properties } },
  }) as CloudFormationTemplate;

describe('UpdateContext.changedProperties (go-to-k/cdkd#5112)', () => {
  it('names a key whose as-written value changed, and leaves out an unchanged secret reference', async () => {
    const run = await deploy({
      state: stateOf({
        R: ssmRecord({ Name: '/p/r', Type: 'String', Value: 'a', Tags: { Owner: REF } }),
      }),
      template: ssmTemplate({ Name: '/p/r', Type: 'String', Value: 'b', Tags: { Owner: REF } }),
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['R']);
    expect(run.changed['R']).toEqual(['Value']);
  });

  it('names a removed key', async () => {
    const run = await deploy({
      state: stateOf({
        R: ssmRecord({ Name: '/p/r', Type: 'String', Value: 'a', Description: 'gone' }),
      }),
      template: ssmTemplate({ Name: '/p/r', Type: 'String', Value: 'b' }),
    });
    expect(run.changed['R']).toEqual(['Description', 'Value']);
  });

  describe('a masked property (`***` on both sides)', () => {
    const encoded = (prefix: string): unknown => ({
      'Fn::Base64': { 'Fn::Join': ['', [prefix, REF]] },
    });
    const record = (): ResourceState =>
      ssmRecord(
        { Name: '/p/r', Type: 'String', Value: '***', Description: 'd' },
        { maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(encoded('pw=')) } } as never
      );

    it('whose template text moved is named (go-to-k/cdkd#4451)', async () => {
      const run = await deploy({
        state: stateOf({ R: record() }),
        template: ssmTemplate({ Name: '/p/r', Type: 'String', Value: encoded('pw2='), Description: 'd' }),
      });
      expect(run.thrown).toBeUndefined();
      expect(run.changed['R']).toEqual(['Value']);
    });

    it('whose template text did not move is left out beside another change', async () => {
      const run = await deploy({
        state: stateOf({ R: record() }),
        template: ssmTemplate({ Name: '/p/r', Type: 'String', Value: encoded('pw='), Description: 'd2' }),
      });
      expect(run.thrown).toBeUndefined();
      expect(run.changed['R']).toEqual(['Description']);
    });
  });

  it('names a key that read a secret at a newer version than recorded, though its token form is unchanged (state schema v12)', async () => {
    // The queue was replaced under the rotated name in an earlier run; the
    // reader still records V1.
    secret.queue = 'chg-q-2';
    secret.version = V2;
    secret.history[V2] = 'chg-q-2';
    const at = (versions: string[], read?: string[]): ReferenceProvenance => ({
      region: 'us-east-1',
      versions,
      ...(read !== undefined && { readVersions: read }),
    });
    const run = await deploy({
      levels: [['Q'], ['R']],
      state: stateOf({
        Q: {
          physicalId: URL_2,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: { Arn: RECORDED_ARN, QueueUrl: URL_2 },
          dependencies: [],
          referenceProvenance: { [REF]: at([V2]) },
        } as ResourceState,
        R: ssmRecord(
          { Name: '/p/r', Type: 'String', Value: RECORDED_ARN, Tags: { Owner: REF } },
          { dependencies: ['Q'], referenceProvenance: { [REF]: at([V1], [V1]) } } as never
        ),
      }),
      template: {
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
          R: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Name: '/p/r',
              Type: 'String',
              Value: { 'Fn::GetAtt': ['Q', 'Arn'] },
              // Spelled in the template: a rotation alone is no change, as in
              // CloudFormation.
              Tags: { Owner: REF },
            },
          },
        },
      },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['R']);
    expect(run.changed['R']).toEqual(['Value']);
  });

  describe('a NoEcho parameter value (`***` on both sides, schema v11)', () => {
    const parameters = (value: string): CloudFormationTemplate['Parameters'] => ({
      Token: { Type: 'String', NoEcho: true, Default: value },
    });
    const record = (): ResourceState =>
      ssmRecord(
        { Name: '/p/r', Type: 'String', Value: '***', Description: 'd' },
        { noEchoLeaves: [['Value']] } as never
      );

    it('that AWS reports holding a different value is named', async () => {
      const run = await deploy({
        state: stateOf({ R: record() }),
        template: ssmTemplate(
          { Name: '/p/r', Type: 'String', Value: { Ref: 'Token' }, Description: 'd' },
          parameters('token-new-5112')
        ),
        readBack: { Name: '/p/r', Type: 'String', Value: 'token-old-5112', Description: 'd' },
      });
      expect(run.thrown).toBeUndefined();
      expect(run.updated).toEqual(['R']);
      expect(run.changed['R']).toEqual(['Value']);
    });

    it('that nobody read back is named beside another change: an unconfirmed value is never dropped', async () => {
      const run = await deploy({
        state: stateOf({ R: record() }),
        template: ssmTemplate(
          { Name: '/p/r', Type: 'String', Value: { Ref: 'Token' }, Description: 'd2' },
          parameters('token-5112')
        ),
      });
      expect(run.thrown).toBeUndefined();
      expect(run.changed['R']).toEqual(['Description', 'Value']);
    });

    it('that AWS confirmed holding is left out beside another change (a create-only path, read back)', async () => {
      const topicArn = 'arn:aws:sns:us-east-1:123456789012:topic-5112';
      const run = await deploy({
        state: stateOf({
          R: {
            physicalId: topicArn,
            resourceType: 'AWS::SNS::Topic',
            properties: { TopicName: '***', DisplayName: 'd' },
            attributes: {},
            dependencies: [],
            noEchoLeaves: [['TopicName']],
          } as ResourceState,
        }),
        template: {
          Parameters: { Name: { Type: 'String', NoEcho: true, Default: 'topic-5112' } },
          Resources: {
            R: {
              Type: 'AWS::SNS::Topic',
              Properties: { TopicName: { Ref: 'Name' }, DisplayName: 'd2' },
            },
          },
        } as CloudFormationTemplate,
        readBack: { TopicName: 'topic-5112', DisplayName: 'd' },
      });
      expect(run.thrown).toBeUndefined();
      expect(run.updated).toEqual(['R']);
      expect(run.changed['R']).toEqual(['DisplayName']);
    });
  });

  it('names a principal list whose unchanged secret reference the engine dropped from the previous side (go-to-k/cdkd#4064)', async () => {
    const doc = (action: string) => ({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: action, Resource: '*' }],
    });
    const run = await deploy({
      state: stateOf({
        R: {
          physicalId: 'pol',
          resourceType: 'AWS::IAM::Policy',
          properties: { PolicyName: 'pol', PolicyDocument: doc('s3:GetObject'), Roles: [REF] },
          attributes: {},
          dependencies: [],
        } as ResourceState,
      }),
      template: {
        Resources: {
          R: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'pol', PolicyDocument: doc('s3:PutObject'), Roles: [REF] },
          },
        },
      },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.changed['R']).toEqual(['PolicyDocument', 'Roles']);
  });
  describe('a NoEcho Description on a type that reads the set (AWS::ServiceDiscovery::Service)', () => {
    const DNS = { RoutingPolicy: 'WEIGHTED', DnsRecords: [{ Type: 'A', TTL: 60 }] };
    const HC = { Type: 'HTTP', ResourcePath: '/h', FailureThreshold: 3 };
    const VALUE = 'svc-desc-5112';
    const record = (type = 'AWS::ServiceDiscovery::Service'): ResourceState =>
      ({
        physicalId: 'srv-1',
        resourceType: type,
        properties: { Name: 'svc', NamespaceId: 'ns-1', Description: '***', DnsConfig: DNS, HealthCheckConfig: HC },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Description']],
      }) as ResourceState;
    // The HealthCheckConfig removal moves the record off the no-change arm,
    // which is exactly when no readback used to be taken.
    const run = (readBack: Record<string, unknown> | undefined, type?: string) =>
      deploy({
        state: stateOf({ R: record(type) }),
        template: {
          Parameters: { Desc: { Type: 'String', NoEcho: true, Default: VALUE } },
          Resources: {
            R: {
              Type: type ?? 'AWS::ServiceDiscovery::Service',
              Properties: { Name: 'svc', NamespaceId: 'ns-1', Description: { Ref: 'Desc' }, DnsConfig: DNS },
            },
          },
        } as CloudFormationTemplate,
        ...(readBack !== undefined && { readBack }),
        options: { captureObservedState: false },
      });

    it('that AWS holds is left out, and the previous side carries the value AWS holds', async () => {
      const result = await run({ Name: 'svc', Description: VALUE, DnsConfig: DNS });
      expect(result.thrown).toBeUndefined();
      expect(result.reads).toEqual(['R']);
      expect(result.changed['R']).toEqual(['HealthCheckConfig']);
      expect(result.previous['R']?.['Description']).toBe(VALUE);
    });

    it('that AWS holds differently is named', async () => {
      const result = await run({ Name: 'svc', Description: 'svc-desc-old', DnsConfig: DNS });
      expect(result.thrown).toBeUndefined();
      expect(result.reads).toEqual(['R']);
      expect(result.changed['R']).toEqual(['Description', 'HealthCheckConfig']);
      expect(result.previous['R']?.['Description']).toBe('***');
    });

    it('that AWS does not report is named', async () => {
      const result = await run(undefined);
      expect(result.thrown).toBeUndefined();
      expect(result.reads).toEqual(['R']);
      expect(result.changed['R']).toEqual(['Description', 'HealthCheckConfig']);
    });

    it('on a type that does not read the set makes no readback, and names the key', async () => {
      const result = await run({ Description: VALUE }, 'AWS::Test::NotAConsumer');
      expect(result.thrown).toBeUndefined();
      expect(result.updated).toEqual(['R']);
      expect(result.reads).toEqual([]);
      expect(result.changed['R']).toEqual(['Description', 'HealthCheckConfig']);
    });
  });

  it('names every key a redaction rewrote in a reader of a producer this run replaced (go-to-k/cdkd#4838)', async () => {
    // The secret rotated and the queue named from it is replaced (FifoQueue is
    // create-only); the reader's new ARN redacts to the reference it recorded.
    secret.queue = 'chg-q-2';
    const run = await deploy({
      levels: [['Q'], ['R']],
      state: stateOf({
        Q: {
          physicalId: URL_1,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: { Arn: RECORDED_ARN, QueueUrl: URL_1 },
          dependencies: [],
        } as ResourceState,
        R: ssmRecord(
          { Name: '/p/r', Type: 'String', Value: RECORDED_ARN, Description: 'd', Tags: { Owner: REF } },
          { dependencies: ['Q'] } as never
        ),
      }),
      template: {
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF, FifoQueue: true } },
          R: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Name: '/p/r',
              Type: 'String',
              Value: { 'Fn::GetAtt': ['Q', 'Arn'] },
              Description: 'd',
              Tags: { Owner: REF },
            },
          },
        },
      },
      results: {
        Q: {
          physicalId: URL_2,
          attributes: { Arn: 'arn:aws:sqs:us-east-1:123456789012:chg-q-2', QueueUrl: URL_2 },
        },
      },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.created).toEqual(['Q']);
    expect(run.updated).toEqual(['R']);
    expect(run.changed['R']).toEqual(['Tags', 'Value']);
  });

  it('names an updatable key carrying a custom resource NoEcho value nobody read back (go-to-k/cdkd#3729 class)', async () => {
    const token = 'arn:aws:lambda:us-east-1:123456789012:function:h';
    const run = await deploy({
      levels: [['Cr'], ['R']],
      state: stateOf({
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: token, Seed: 'a' },
          attributes: { Shown: '***' },
          dependencies: [],
        } as ResourceState,
        R: {
          physicalId: 'arn:aws:sns:us-east-1:123456789012:fixed-topic',
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: 'fixed-topic', DisplayName: '***' },
          attributes: {},
          dependencies: ['Cr'],
        } as ResourceState,
      }),
      template: {
        Resources: {
          Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: token, Seed: 'b' } },
          R: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: 'fixed-topic', DisplayName: { 'Fn::GetAtt': ['Cr', 'Shown'] } },
          },
        },
      },
      results: {
        Cr: {
          physicalId: 'cr-1',
          wasReplaced: false,
          attributes: { Shown: 'cr-noecho-5112-value' },
          noEchoAttributes: true,
        },
      },
      options: { captureObservedState: false },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.updated).toEqual(['Cr', 'R']);
    expect(run.changed['R']).toEqual(['DisplayName']);
  });

  describe('a record a pre-v11 binary wrote (plaintext at a NoEcho position, no marker)', () => {
    const v10 = (stored: string): StackState => {
      const state = stateOf({
        R: ssmRecord({ Name: '/p/r', Type: 'String', Value: stored, Description: 'd' }),
      });
      state.version = 10 as never;
      return state;
    };
    const template = (value: string, description: string): CloudFormationTemplate =>
      ssmTemplate(
        { Name: '/p/r', Type: 'String', Value: { Ref: 'Token' }, Description: description },
        { Token: { Type: 'String', NoEcho: true, Default: value } }
      );

    it('names a value the witness finds different', async () => {
      const run = await deploy({
        state: v10('token-old-5112'),
        template: template('token-new-5112', 'd'),
        options: { captureObservedState: false },
      });
      expect(run.thrown).toBeUndefined();
      expect(run.changed['R']).toEqual(['Value']);
    });

    it('leaves out a value the witness confirms beside another change', async () => {
      const run = await deploy({
        state: v10('token-same-5112'),
        template: template('token-same-5112', 'd2'),
        options: { captureObservedState: false },
      });
      expect(run.thrown).toBeUndefined();
      expect(run.changed['R']).toEqual(['Description']);
    });
  });
});
