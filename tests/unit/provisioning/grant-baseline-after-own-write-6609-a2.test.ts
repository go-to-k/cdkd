/**
 * go-to-k/cdkd#6609, second slice: a member a separate call writes onto a
 * bigger resource (KMS `KeyPolicy`, delivery destination policy, log group
 * `DataProtectionPolicy`, RestApi `Policy`, EFS `FileSystemPolicy`,
 * CodeBuild `Visibility`) is settled on the baseline captured right after
 * cdkd's own write, and every other read takes the first answer. The stored
 * spellings below are the ones AWS answered in us-east-1 on 2026-11-19.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const fakeClient = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: fakeClient,
    apiGateway: fakeClient,
    sts: fakeClient,
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this; }),
}));
/** The `refresh-observed` warnings, for the unsettled outcome (value-free). */
const unsettledWarnings = (): string[] =>
  childLogger.warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes('refresh-observed'));

vi.mock('../../../src/utils/logger.js', () => {
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

import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { LogsDeliveryDestinationProvider } from '../../../src/provisioning/providers/logs-delivery-destination-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';

const AFTER = { afterOwnWrite: true } as const;
const ACCT = '111111111111';

/** Per SDK command name, the answers in order (the last one repeats); others answer `{}`. */
let script: Record<string, Array<() => unknown>> = {};
function answer(command: string, ...answers: Array<() => unknown>): void {
  script[command] = answers;
}
const callsOf = (command: string): number =>
  mockSend.mock.calls.filter((c) => (c[0] as object).constructor.name === command).length;
const fail = (name: string) => () => {
  throw Object.assign(new Error(name), { name });
};

beforeEach(() => {
  mockSend.mockReset();
  childLogger.warn.mockClear();
  script = {};
  const served: Record<string, number> = {};
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    const queue = script[name];
    if (queue === undefined) return Promise.resolve({});
    const index = Math.min(served[name] ?? 0, queue.length - 1);
    served[name] = (served[name] ?? 0) + 1;
    try {
      return Promise.resolve(queue[index]!());
    } catch (error) {
      return Promise.reject(error);
    }
  });
});

function zeroDelays<T extends object>(provider: T): T {
  (provider as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs = [0, 0, 0];
  return provider;
}
function withClient<T extends object>(provider: T): T {
  (provider as { client: unknown }).client = fakeClient;
  return zeroDelays(provider);
}
const bag = (read: unknown): Record<string, unknown> => read as Record<string, unknown>;

// ─── AWS::KMS::Key KeyPolicy ────────────────────────────────────────────
describe('AWS::KMS::Key KeyPolicy', () => {
  const declared = {
    Statement: [
      { Action: 'kms:*', Effect: 'Allow', Principal: { AWS: ACCT }, Resource: '*' },
      {
        Action: ['kms:Decrypt', 'kms:Encrypt'],
        Condition: { StringEquals: { 'kms:ViaService': ['sqs.us-east-1.amazonaws.com'] } },
        Effect: 'Allow',
        Principal: { AWS: ACCT },
        Resource: '*',
        Sid: 'A',
      },
    ],
    Version: '2012-10-17',
  };
  // How KMS stores `declared`: account id as its root ARN, the one-element
  // condition list as its scalar, pretty-printed.
  const stored = JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${ACCT}:root` },
          Action: 'kms:*',
          Resource: '*',
        },
        {
          Sid: 'A',
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${ACCT}:root` },
          Action: ['kms:Decrypt', 'kms:Encrypt'],
          Resource: '*',
          Condition: { StringEquals: { 'kms:ViaService': 'sqs.us-east-1.amazonaws.com' } },
        },
      ],
    },
    null,
    2
  );
  const defaultPolicy = JSON.stringify({
    Version: '2012-10-17',
    Id: 'key-default-1',
    Statement: [
      {
        Sid: 'Enable IAM User Permissions',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${ACCT}:root` },
        Action: 'kms:*',
        Resource: '*',
      },
    ],
  });
  const other = JSON.stringify({ ...declared, Statement: [declared.Statement[0]] });
  const policy = (p: string) => () => ({ Policy: p });
  const read = (context?: object) => {
    answer('DescribeKeyCommand', () => ({ KeyMetadata: { KeyId: 'k1', Enabled: true } }));
    return withClient(new KMSProvider()).readCurrentState(
      'k1',
      'Key',
      'AWS::KMS::Key',
      { KeyPolicy: declared },
      context
    );
  };

  it('settles on the first read in KMS storage spelling: 1 GetKeyPolicy, no warning', async () => {
    answer('GetKeyPolicyCommand', policy(stored));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(JSON.parse(stored));
    expect(callsOf('GetKeyPolicyCommand')).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('re-reads a replaced policy until the declared one shows, and records it as read', async () => {
    answer('GetKeyPolicyCommand', policy(other), policy(other), policy(stored));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(JSON.parse(stored));
    expect(callsOf('GetKeyPolicyCommand')).toBe(3);
    expect(callsOf('DescribeKeyCommand')).toBe(1);
  });

  it('re-reads the default policy (none set yet) until the declared one shows', async () => {
    answer('GetKeyPolicyCommand', policy(defaultPolicy), policy(stored));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(JSON.parse(stored));
    expect(callsOf('GetKeyPolicyCommand')).toBe(2);
  });

  it('keeps the declared policy when the default policy outlives the schedule, and warns value-free', async () => {
    answer('GetKeyPolicyCommand', policy(defaultPolicy));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(declared);
    expect(callsOf('GetKeyPolicyCommand')).toBe(4);
    const warnings = unsettledWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('AWS::KMS::Key Key');
    expect(warnings[0]).toContain('KeyPolicy');
    expect(warnings[0]).not.toContain(ACCT);
    expect(warnings[0]).not.toContain('kms:');
  });

  it('records another policy as read when it outlives the schedule', async () => {
    answer('GetKeyPolicyCommand', policy(other));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(JSON.parse(other));
    expect(callsOf('GetKeyPolicyCommand')).toBe(4);
  });

  it('a deterministic first failure (AccessDenied) is not re-read: the read rejects (#6759), 1 call', async () => {
    answer('GetKeyPolicyCommand', fail('AccessDeniedException'), policy(stored));
    await expect(read(AFTER)).rejects.toHaveProperty('name', 'AccessDeniedException');
    expect(callsOf('GetKeyPolicyCommand')).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a transient first failure is re-read until the declared policy shows', async () => {
    answer('GetKeyPolicyCommand', fail('ThrottlingException'), policy(stored));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(JSON.parse(stored));
    expect(callsOf('GetKeyPolicyCommand')).toBe(2);
  });

  it('rejects when every read fails transiently, as the single read does (#6759)', async () => {
    answer('GetKeyPolicyCommand', fail('ThrottlingException'));
    await expect(read(AFTER)).rejects.toHaveProperty('name', 'ThrottlingException');
    expect(callsOf('GetKeyPolicyCommand')).toBe(4);
    // Nothing answered, so nothing to re-capture: no refresh-observed warning.
    expect(unsettledWarnings()).toEqual([]);
  });

  it('an answer with no Policy text is re-read, and omitted when it never carries one', async () => {
    answer('GetKeyPolicyCommand', () => ({}));
    expect(bag(await read(AFTER))).not.toHaveProperty('KeyPolicy');
    expect(callsOf('GetKeyPolicyCommand')).toBe(4);
  });

  it('a failing re-read keeps the newest answer (another policy), not the failure', async () => {
    answer('GetKeyPolicyCommand', policy(other), fail('ThrottlingException'));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(JSON.parse(other));
    expect(callsOf('GetKeyPolicyCommand')).toBe(4);
  });

  it('a deterministic re-read failure ends the schedule and keeps the newest answer', async () => {
    answer('GetKeyPolicyCommand', policy(other), fail('AccessDeniedException'));
    expect(bag(await read(AFTER))['KeyPolicy']).toEqual(JSON.parse(other));
    expect(callsOf('GetKeyPolicyCommand')).toBe(2);
  });

  it('a read without the post-write context takes the first answer: 1 call', async () => {
    answer('GetKeyPolicyCommand', policy(other), policy(stored));
    expect(bag(await read())['KeyPolicy']).toEqual(JSON.parse(other));
    expect(callsOf('GetKeyPolicyCommand')).toBe(1);
  });

  it('a template that declares no KeyPolicy settles nothing: 1 call', async () => {
    answer('DescribeKeyCommand', () => ({ KeyMetadata: { KeyId: 'k1' } }));
    answer('GetKeyPolicyCommand', policy(defaultPolicy), policy(stored));
    await withClient(new KMSProvider()).readCurrentState('k1', 'Key', 'AWS::KMS::Key', {}, AFTER);
    expect(callsOf('GetKeyPolicyCommand')).toBe(1);
  });

  it('heal: skips KeyPolicy while the live key holds the declared policy', () => {
    const observed = { KeyPolicy: JSON.parse(other) };
    expect(
      preFixBaselineUncomparedDriftKeys('AWS::KMS::Key', observed, { KeyPolicy: declared }, {
        KeyPolicy: JSON.parse(stored),
      })
    ).toEqual(['KeyPolicy']);
    expect(
      preFixBaselineUncomparedDriftKeys('AWS::KMS::Key', observed, { KeyPolicy: declared }, {
        KeyPolicy: JSON.parse(other),
      })
    ).toEqual([]);
  });

  it('heal: a kept-declared baseline in TEMPLATE spelling (bare account id) beside the live :root spelling is skipped', () => {
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::KMS::Key',
        { KeyPolicy: declared },
        { KeyPolicy: declared },
        { KeyPolicy: JSON.parse(stored) }
      )
    ).toEqual(['KeyPolicy']);
  });
});

// ─── AWS::Logs::DeliveryDestination DeliveryDestinationPolicy ─────────────
describe('AWS::Logs::DeliveryDestination DeliveryDestinationPolicy', () => {
  const NAME = 'dest1';
  const doc = (sid: string, principal: string, condition: unknown) => ({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: sid,
        Effect: 'Allow',
        Principal: { AWS: principal },
        Action: 'logs:CreateDelivery',
        Resource: `arn:aws:logs:us-east-1:${ACCT}:delivery-destination:${NAME}`,
        Condition: { StringEquals: { 'aws:SourceAccount': condition } },
      },
    ],
  });
  const declared = doc('A', ACCT, [ACCT]);
  // How Logs stores `declared`: root ARN principal, scalar condition value.
  const stored = JSON.stringify(doc('A', `arn:aws:iam::${ACCT}:root`, ACCT));
  const other = JSON.stringify(doc('B', `arn:aws:iam::${ACCT}:root`, ACCT));
  const policy = (p: string) => () => ({ policy: { deliveryDestinationPolicy: p } });
  // A destination with no policy answers `{ policy: {} }`.
  const none = () => ({ policy: {} });
  const read = (context?: object) => {
    answer('GetDeliveryDestinationCommand', () => ({
      deliveryDestination: { name: NAME, arn: `arn:aws:logs:us-east-1:${ACCT}:dd:${NAME}` },
    }));
    return zeroDelays(new LogsDeliveryDestinationProvider()).readCurrentState(
      NAME,
      'Dest',
      'AWS::Logs::DeliveryDestination',
      { Name: NAME, DeliveryDestinationPolicy: { DeliveryDestinationPolicy: declared } },
      context
    );
  };
  const member = (r: unknown) =>
    (bag(r)['DeliveryDestinationPolicy'] as Record<string, unknown> | undefined)?.[
      'DeliveryDestinationPolicy'
    ];
  const GET = 'GetDeliveryDestinationPolicyCommand';

  it('settles on the first read in Logs storage spelling: 1 call', async () => {
    answer(GET, policy(stored));
    expect(member(await read(AFTER))).toEqual(JSON.parse(stored));
    expect(callsOf(GET)).toBe(1);
  });

  it('re-reads a not-yet-visible policy until it shows', async () => {
    answer(GET, none, policy(stored));
    expect(member(await read(AFTER))).toEqual(JSON.parse(stored));
    expect(callsOf(GET)).toBe(2);
  });

  it('re-reads a replaced policy until the declared one shows', async () => {
    answer(GET, policy(other), policy(stored));
    expect(member(await read(AFTER))).toEqual(JSON.parse(stored));
    expect(callsOf(GET)).toBe(2);
  });

  it('keeps the declared policy, in the read shape, when none outlives the schedule', async () => {
    answer(GET, none);
    expect(bag(await read(AFTER))['DeliveryDestinationPolicy']).toEqual({
      DeliveryDestinationPolicy: declared,
    });
    expect(callsOf(GET)).toBe(4);
  });

  it('records another policy as read when it outlives the schedule', async () => {
    answer(GET, policy(other));
    expect(member(await read(AFTER))).toEqual(JSON.parse(other));
    expect(callsOf(GET)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a failing re-read keeps the newest answer (another policy)', async () => {
    answer(GET, policy(other), fail('ThrottlingException'));
    expect(member(await read(AFTER))).toEqual(JSON.parse(other));
    expect(callsOf(GET)).toBe(4);
  });

  it('a read without the post-write context takes the first answer: 1 call', async () => {
    answer(GET, none, policy(stored));
    expect(bag(await read())).not.toHaveProperty('DeliveryDestinationPolicy');
    expect(callsOf(GET)).toBe(1);
  });

  it('a policy declared as a JSON string is not settled (CloudFormation refuses it), and the heal agrees', async () => {
    const asString = {
      DeliveryDestinationPolicy: { DeliveryDestinationPolicy: JSON.stringify(declared) },
    };
    answer('GetDeliveryDestinationCommand', () => ({ deliveryDestination: { name: NAME } }));
    answer(GET, none, policy(stored));
    await zeroDelays(new LogsDeliveryDestinationProvider()).readCurrentState(
      NAME,
      'Dest',
      'AWS::Logs::DeliveryDestination',
      asString,
      AFTER
    );
    expect(callsOf(GET)).toBe(1);
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::Logs::DeliveryDestination',
        { DeliveryDestinationPolicy: { DeliveryDestinationPolicy: JSON.parse(other) } },
        asString,
        { DeliveryDestinationPolicy: { DeliveryDestinationPolicy: JSON.parse(stored) } }
      )
    ).toEqual([]);
  });

  it('heal: skips the policy while the live one is the declared one, or both are none', () => {
    const props = { DeliveryDestinationPolicy: { DeliveryDestinationPolicy: declared } };
    const observed = { DeliveryDestinationPolicy: { DeliveryDestinationPolicy: JSON.parse(other) } };
    const live = (p: string) => ({ DeliveryDestinationPolicy: { DeliveryDestinationPolicy: JSON.parse(p) } });
    const T = 'AWS::Logs::DeliveryDestination';
    expect(preFixBaselineUncomparedDriftKeys(T, observed, props, live(stored))).toEqual([
      'DeliveryDestinationPolicy',
    ]);
    expect(preFixBaselineUncomparedDriftKeys(T, observed, props, live(other))).toEqual([]);
    expect(preFixBaselineUncomparedDriftKeys(T, observed, {}, {})).toEqual([
      'DeliveryDestinationPolicy',
    ]);
    expect(preFixBaselineUncomparedDriftKeys(T, observed, {}, live(other))).toEqual([]);
  });
});

// ─── AWS::Logs::LogGroup DataProtectionPolicy ───────────────────────────
describe('AWS::Logs::LogGroup DataProtectionPolicy', () => {
  const LG = 'lg1';
  const mk = (sid: string) => ({
    name: 'data-protection-policy-cdk',
    description: 'cdk generated data protection policy',
    version: '2021-06-01',
    statement: [
      {
        sid: `audit-statement-${sid}`,
        dataIdentifier: ['arn:aws:dataprotection::aws:data-identifier/EmailAddress'],
        operation: { audit: { findingsDestination: {} } },
      },
    ],
  });
  const declared = mk('A');
  const other = mk('B');
  const policy = (p: unknown) => () => ({ policyDocument: JSON.stringify(p) });
  // A log group with no policy answers `{}`.
  const none = () => ({});
  const read = (context?: object) => {
    answer('DescribeLogGroupsCommand', () => ({
      logGroups: [{ logGroupName: LG, arn: `arn:aws:logs:us-east-1:${ACCT}:log-group:${LG}:*` }],
    }));
    return zeroDelays(new LogsLogGroupProvider()).readCurrentState(
      LG,
      'LogGroup',
      'AWS::Logs::LogGroup',
      { LogGroupName: LG, DataProtectionPolicy: declared },
      context
    );
  };
  const GET = 'GetDataProtectionPolicyCommand';

  it('settles on the first read: 1 call', async () => {
    answer(GET, policy(declared));
    expect(bag(await read(AFTER))['DataProtectionPolicy']).toEqual(declared);
    expect(callsOf(GET)).toBe(1);
  });

  it('re-reads a not-yet-visible policy until it shows', async () => {
    answer(GET, none, none, policy(declared));
    expect(bag(await read(AFTER))['DataProtectionPolicy']).toEqual(declared);
    expect(callsOf(GET)).toBe(3);
  });

  it('re-reads a replaced policy until the declared one shows', async () => {
    answer(GET, policy(other), policy(declared));
    expect(bag(await read(AFTER))['DataProtectionPolicy']).toEqual(declared);
    expect(callsOf(GET)).toBe(2);
  });

  it('keeps the declared policy when none outlives the schedule', async () => {
    answer(GET, none);
    expect(bag(await read(AFTER))['DataProtectionPolicy']).toEqual(declared);
    expect(callsOf(GET)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('records another policy as read when it outlives the schedule', async () => {
    answer(GET, policy(other));
    expect(bag(await read(AFTER))['DataProtectionPolicy']).toEqual(other);
    expect(callsOf(GET)).toBe(4);
  });

  it('a deterministic first failure is not re-read: the read rejects (#6759), 1 call', async () => {
    answer(GET, fail('AccessDeniedException'), policy(declared));
    await expect(read(AFTER)).rejects.toHaveProperty('name', 'AccessDeniedException');
    expect(callsOf(GET)).toBe(1);
  });

  it('rejects when every read fails transiently, as the single read does (#6759)', async () => {
    answer(GET, fail('ThrottlingException'));
    await expect(read(AFTER)).rejects.toHaveProperty('name', 'ThrottlingException');
    expect(callsOf(GET)).toBe(4);
  });

  it('a read without the post-write context takes the first answer: 1 call', async () => {
    answer(GET, none, policy(declared));
    expect(bag(await read())['DataProtectionPolicy']).toBe('');
    expect(callsOf(GET)).toBe(1);
  });

  it('heal: skips the policy while the live one is the declared one, or both are none', () => {
    const T = 'AWS::Logs::LogGroup';
    const observed = { DataProtectionPolicy: other };
    const props = { DataProtectionPolicy: declared };
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, props, { DataProtectionPolicy: declared })
    ).toEqual(['DataProtectionPolicy']);
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, props, { DataProtectionPolicy: other })
    ).toEqual([]);
    expect(preFixBaselineUncomparedDriftKeys(T, observed, {}, { DataProtectionPolicy: '' })).toEqual(
      ['DataProtectionPolicy']
    );
    expect(
      preFixBaselineUncomparedDriftKeys(
        T,
        observed,
        { DataProtectionPolicy: '' },
        { DataProtectionPolicy: '' }
      )
    ).toEqual(['DataProtectionPolicy']);
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, {}, { DataProtectionPolicy: other })
    ).toEqual([]);
  });
});

// ─── AWS::ApiGateway::RestApi Policy ────────────────────────────────────
describe('AWS::ApiGateway::RestApi Policy', () => {
  const API = 'abc123';
  const declared = {
    Statement: [
      {
        Action: 'execute-api:Invoke',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Resource: 'execute-api:/*',
        Sid: 'A',
        Condition: { IpAddress: { 'aws:SourceIp': ['10.0.0.0/8'] } },
      },
    ],
    Version: '2012-10-17',
  };
  // How API Gateway stores `declared`: backslash-escaped, the resource
  // expanded to the API's ARN, the one-element condition list as its scalar.
  const stored = (sid: string) =>
    `{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Sid\\":\\"${sid}\\",\\"Effect\\":\\"Allow\\",\\"Principal\\":{\\"AWS\\":\\"*\\"},\\"Action\\":\\"execute-api:Invoke\\",\\"Resource\\":\\"arn:aws:execute-api:us-east-1:${ACCT}:${API}\\/*\\",\\"Condition\\":{\\"IpAddress\\":{\\"aws:SourceIp\\":\\"10.0.0.0\\/8\\"}}}]}`;
  const api = (policy: string | undefined) => () => ({ id: API, name: 'api', policy });
  const read = (context?: object, properties: Record<string, unknown> = { Policy: declared }) =>
    zeroDelays(new ApiGatewayProvider()).readCurrentState(
      API,
      'Api',
      'AWS::ApiGateway::RestApi',
      properties,
      context
    );
  const GET = 'GetRestApiCommand';
  const sid = (r: unknown) =>
    ((bag(r)['Policy'] as { Statement: Array<{ Sid: string }> }).Statement[0]!).Sid;

  it('settles on the first read in API Gateway storage spelling: 1 call', async () => {
    answer(GET, api(stored('A')));
    expect(sid(await read(AFTER))).toBe('A');
    expect(callsOf(GET)).toBe(1);
  });

  it('re-reads a not-yet-visible policy until it shows', async () => {
    answer(GET, api(undefined), api(stored('A')));
    expect(sid(await read(AFTER))).toBe('A');
    expect(callsOf(GET)).toBe(2);
  });

  it('re-reads a replaced policy until the declared one shows', async () => {
    answer(GET, api(stored('B')), api(stored('A')));
    expect(sid(await read(AFTER))).toBe('A');
    expect(callsOf(GET)).toBe(2);
  });

  it('keeps the declared policy when none outlives the schedule', async () => {
    answer(GET, api(undefined));
    expect(bag(await read(AFTER))['Policy']).toEqual(declared);
    expect(callsOf(GET)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a declared policy string is kept in the read (object) shape', async () => {
    answer(GET, api(undefined));
    expect(bag(await read(AFTER, { Policy: JSON.stringify(declared) }))['Policy']).toEqual(
      declared
    );
  });

  it('records another policy as read when it outlives the schedule', async () => {
    answer(GET, api(stored('B')));
    expect(sid(await read(AFTER))).toBe('B');
    expect(callsOf(GET)).toBe(4);
  });

  it('keeps the declared policy when none shows and the re-reads fail', async () => {
    answer(GET, api(undefined), fail('ThrottlingException'));
    expect(bag(await read(AFTER))['Policy']).toEqual(declared);
    expect(callsOf(GET)).toBe(4);
  });

  it('a read without the post-write context takes the first answer: 1 call', async () => {
    answer(GET, api(undefined), api(stored('A')));
    expect(bag(await read())).not.toHaveProperty('Policy');
    expect(callsOf(GET)).toBe(1);
  });

  it('heal: skips Policy while the live API holds the declared policy', async () => {
    answer(GET, api(stored('A')));
    const live = bag(await read(undefined));
    const observed = { Policy: { ...declared, Statement: [{ ...declared.Statement[0], Sid: 'B' }] } };
    const T = 'AWS::ApiGateway::RestApi';
    expect(preFixBaselineUncomparedDriftKeys(T, observed, { Policy: declared }, live)).toEqual([
      'Policy',
    ]);
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, { Policy: declared }, { Policy: observed.Policy })
    ).toEqual([]);
  });

  it('heal: a kept-declared baseline in TEMPLATE spelling beside the live AWS spelling is skipped', async () => {
    answer(GET, api(stored('A')));
    const live = bag(await read(undefined));
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::ApiGateway::RestApi',
        { Policy: declared },
        { Policy: declared },
        live
      )
    ).toEqual(['Policy']);
  });
});

// ─── AWS::EFS::FileSystem FileSystemPolicy ──────────────────────────────
describe('AWS::EFS::FileSystem FileSystemPolicy', () => {
  const FS = 'fs-0123456789abcdef0';
  const mk = (sid: string) => ({
    Statement: [
      {
        Action: ['elasticfilesystem:ClientRootAccess', 'elasticfilesystem:ClientWrite'],
        Condition: { Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' } },
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Sid: sid,
      },
    ],
    Version: '2012-10-17',
  });
  const declared = mk('A');
  // How EFS stores `declared`: the file system's ARN added as `Resource`.
  const stored = (sid: string) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          ...mk(sid).Statement[0],
          Resource: `arn:aws:elasticfilesystem:us-east-1:${ACCT}:file-system/${FS}`,
        },
      ],
    });
  const policy = (p: string) => () => ({ Policy: p });
  const none = fail('PolicyNotFound');
  const withResource = (resource: string) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ ...mk('A').Statement[0], Resource: resource }],
    });
  const otherFsArn = `arn:aws:elasticfilesystem:us-east-1:${ACCT}:file-system/fs-0aaaaaaaaaaaaaaaa`;
  const read = (context?: object) => {
    answer('DescribeFileSystemsCommand', () => ({ FileSystems: [{ FileSystemId: FS }] }));
    return withClient(new EFSProvider()).readCurrentState(
      FS,
      'Fs',
      'AWS::EFS::FileSystem',
      { FileSystemPolicy: declared },
      context
    );
  };
  const GET = 'DescribeFileSystemPolicyCommand';

  it('settles on the first read in EFS storage spelling (added Resource): 1 call', async () => {
    answer(GET, policy(stored('A')));
    expect(bag(await read(AFTER))['FileSystemPolicy']).toEqual(JSON.parse(stored('A')));
    expect(callsOf(GET)).toBe(1);
  });

  it('re-reads a not-yet-visible policy until it shows', async () => {
    answer(GET, none, policy(stored('A')));
    expect(bag(await read(AFTER))['FileSystemPolicy']).toEqual(JSON.parse(stored('A')));
    expect(callsOf(GET)).toBe(2);
  });

  it('re-reads a replaced policy until the declared one shows', async () => {
    answer(GET, policy(stored('B')), policy(stored('A')));
    expect(bag(await read(AFTER))['FileSystemPolicy']).toEqual(JSON.parse(stored('A')));
    expect(callsOf(GET)).toBe(2);
  });

  it('keeps the declared policy when none outlives the schedule', async () => {
    answer(GET, none);
    expect(bag(await read(AFTER))['FileSystemPolicy']).toEqual(declared);
    expect(callsOf(GET)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('records another policy as read when it outlives the schedule', async () => {
    answer(GET, policy(stored('B')));
    expect(bag(await read(AFTER))['FileSystemPolicy']).toEqual(JSON.parse(stored('B')));
    expect(callsOf(GET)).toBe(4);
  });

  it('a read without the post-write context takes the first answer: 1 call', async () => {
    answer(GET, none, policy(stored('A')));
    expect(bag(await read())).not.toHaveProperty('FileSystemPolicy');
    expect(callsOf(GET)).toBe(1);
  });

  it('a deterministic first failure is not re-read: the read rejects (#6759), 1 call', async () => {
    answer(GET, fail('AccessDeniedException'), policy(stored('A')));
    await expect(read(AFTER)).rejects.toHaveProperty('name', 'AccessDeniedException');
    expect(callsOf(GET)).toBe(1);
  });

  it('every transient failure: the read rejects (#6759), 4 calls', async () => {
    answer(GET, fail('ThrottlingException'));
    await expect(read(AFTER)).rejects.toHaveProperty('name', 'ThrottlingException');
    expect(callsOf(GET)).toBe(4);
  });

  it.each([
    ['Resource "*"', '*'],
    ["another file system's ARN", otherFsArn],
  ])('the fold does not settle a read with %s for a declaration without Resource', async (_, r) => {
    answer(GET, policy(withResource(r)));
    expect(bag(await read(AFTER))['FileSystemPolicy']).toEqual(JSON.parse(withResource(r)));
    expect(callsOf(GET)).toBe(4);
  });

  it("a declaration naming the file system's own ARN settles on the first read (the fold keeps it)", async () => {
    const ownArn = `arn:aws:elasticfilesystem:us-east-1:${ACCT}:file-system/${FS}`;
    const declaredOwn = { ...declared, Statement: [{ ...declared.Statement[0], Resource: ownArn }] };
    answer('DescribeFileSystemsCommand', () => ({ FileSystems: [{ FileSystemId: FS }] }));
    answer(GET, policy(stored('A')));
    await withClient(new EFSProvider()).readCurrentState(
      FS,
      'Fs',
      'AWS::EFS::FileSystem',
      { FileSystemPolicy: declaredOwn },
      AFTER
    );
    expect(callsOf(GET)).toBe(1);
  });

  it('the fold drops nothing where the declared statement has its own Resource', async () => {
    const declaredStar = { ...declared, Statement: [{ ...declared.Statement[0], Resource: '*' }] };
    answer('DescribeFileSystemsCommand', () => ({ FileSystems: [{ FileSystemId: FS }] }));
    answer(GET, policy(stored('A')));
    const result = await withClient(new EFSProvider()).readCurrentState(
      FS,
      'Fs',
      'AWS::EFS::FileSystem',
      { FileSystemPolicy: declaredStar },
      AFTER
    );
    expect(callsOf(GET)).toBe(4);
    expect(bag(result)['FileSystemPolicy']).toEqual(JSON.parse(stored('A')));
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::EFS::FileSystem',
        { FileSystemPolicy: JSON.parse(stored('B')) },
        { FileSystemPolicy: declaredStar },
        { FileSystemPolicy: JSON.parse(stored('A')) }
      )
    ).toEqual([]);
  });

  it('an access point read is not settled and keeps its own dispatch', async () => {
    await withClient(new EFSProvider()).readCurrentState(
      'fsap-1',
      'Ap',
      'AWS::EFS::AccessPoint',
      { FileSystemPolicy: declared },
      AFTER
    );
    expect(callsOf(GET)).toBe(0);
    expect(callsOf('DescribeAccessPointsCommand')).toBe(1);
  });

  it('heal: skips the policy while the live one is the declared one, or both are none', () => {
    const T = 'AWS::EFS::FileSystem';
    const observed = { FileSystemPolicy: JSON.parse(stored('B')) };
    const props = { FileSystemPolicy: declared };
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, props, {
        FileSystemPolicy: JSON.parse(stored('A')),
      })
    ).toEqual(['FileSystemPolicy']);
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, props, {
        FileSystemPolicy: JSON.parse(stored('B')),
      })
    ).toEqual([]);
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, props, {
        FileSystemPolicy: JSON.parse(withResource('*')),
      })
    ).toEqual([]);
    expect(preFixBaselineUncomparedDriftKeys(T, observed, {}, {})).toEqual(['FileSystemPolicy']);
    expect(
      preFixBaselineUncomparedDriftKeys(T, observed, {}, {
        FileSystemPolicy: JSON.parse(stored('B')),
      })
    ).toEqual([]);
  });
});

// ─── AWS::CodeBuild::Project Visibility ─────────────────────────────────
describe('AWS::CodeBuild::Project Visibility', () => {
  const project = (visibility: string) => () => ({
    projects: [{ name: 'p1', projectVisibility: visibility }],
  });
  const read = (context?: object) =>
    withClient(new CodeBuildProvider()).readCurrentState(
      'p1',
      'Project',
      'AWS::CodeBuild::Project',
      { Visibility: 'PUBLIC_READ' },
      context
    );
  const GET = 'BatchGetProjectsCommand';

  it('settles on the first read: 1 call', async () => {
    answer(GET, project('PUBLIC_READ'));
    expect(bag(await read(AFTER))['Visibility']).toBe('PUBLIC_READ');
    expect(callsOf(GET)).toBe(1);
  });

  it('re-reads the replaced visibility until the declared one shows', async () => {
    answer(GET, project('PRIVATE'), project('PRIVATE'), project('PUBLIC_READ'));
    expect(bag(await read(AFTER))['Visibility']).toBe('PUBLIC_READ');
    expect(callsOf(GET)).toBe(3);
  });

  it('re-reads in the other direction (PRIVATE declared, PUBLIC_READ read)', async () => {
    answer(GET, project('PUBLIC_READ'), project('PRIVATE'));
    const result = await withClient(new CodeBuildProvider()).readCurrentState(
      'p1',
      'Project',
      'AWS::CodeBuild::Project',
      { Visibility: 'PRIVATE' },
      AFTER
    );
    expect(bag(result)['Visibility']).toBe('PRIVATE');
    expect(callsOf(GET)).toBe(2);
  });

  it('records the other visibility as read when it outlives the schedule', async () => {
    answer(GET, project('PRIVATE'));
    expect(bag(await read(AFTER))['Visibility']).toBe('PRIVATE');
    expect(callsOf(GET)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a failed re-read keeps the newest answer', async () => {
    answer(GET, project('PRIVATE'), fail('ThrottlingException'));
    expect(bag(await read(AFTER))['Visibility']).toBe('PRIVATE');
    expect(callsOf(GET)).toBe(4);
  });

  it('a read without the post-write context takes the first answer: 1 call', async () => {
    answer(GET, project('PRIVATE'), project('PUBLIC_READ'));
    expect(bag(await read())['Visibility']).toBe('PRIVATE');
    expect(callsOf(GET)).toBe(1);
  });

  it('heal: skips Visibility while the live project has the declared one', () => {
    const T = 'AWS::CodeBuild::Project';
    const props = { Visibility: 'PUBLIC_READ' };
    expect(
      preFixBaselineUncomparedDriftKeys(T, { Visibility: 'PRIVATE' }, props, {
        Visibility: 'PUBLIC_READ',
      })
    ).toEqual(['Visibility']);
    expect(
      preFixBaselineUncomparedDriftKeys(T, { Visibility: 'PUBLIC_READ' }, props, {
        Visibility: 'PRIVATE',
      })
    ).toEqual([]);
  });
});
