import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The Route 53 and KMS wraps must not write the CALLER'S IDENTITY into a
 * persisted store (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and these services word an access denial as
 * `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
 * to perform: ...`. Each AWS fixture here carries that wording and the smithy
 * service markers `describeAwsFailure` keys on. Both polarities: an
 * AWS-authored failure is named by its class with `cause` kept (so the retry
 * classifiers still read it), and a cdkd-authored or transport failure keeps
 * its own text.
 */

const { mockSend, debugSpy, warnSpy, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    debugSpy: vi.fn(),
    warnSpy: vi.fn(),
    fakeClient: () => ({
      send: (command: unknown) => send(command),
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () => Promise.resolve(undefined),
      },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
  };
});

vi.mock('@aws-sdk/client-route-53', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-route-53')>();
  return { ...actual, Route53Client: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kms')>();
  return { ...actual, KMSClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  createdBeforeFailure,
  isAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** An access denial as these services word it, AWS-authored. */
function accessDenied(name: string, action: string): Error {
  return Object.assign(
    new Error(
      `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
        `arn:aws:${action.split(':')[0]}:us-east-1:${CALLER_ACCOUNT}:x because no ` +
        `identity-based policy allows the ${action} action`
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

function awsError(name: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Fail `failing` with `error`; every other command answers `answers[name]` or `{}`. */
function failOn(failing: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name === failing) throw error;
    return answers[name] ?? {};
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

const debugged = (): string => debugSpy.mock.calls.map((args) => String(args[0])).join('\n');
const warned = (): string => warnSpy.mock.calls.map((args) => String(args[0])).join('\n');

const ZONE = 'Z0123456789ABC';
const HZ = 'AWS::Route53::HostedZone';
const RS = 'AWS::Route53::RecordSet';
const RECORD = {
  HostedZoneId: ZONE,
  Name: 'www.example.com.',
  Type: 'A',
  TTL: '300',
  ResourceRecords: ['192.0.2.1'],
};
const MASK = (text: string): string => text.split('kms-r53-secret').join('***');
const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const KEY_ARN = `arn:aws:kms:us-east-1:111122223333:key/${KEY_ID}`;

type Site = {
  site: string;
  command: string;
  /** The error class the denial carries, the service's own. */
  name: string;
  /** The IAM action the denial names, the site's own. */
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  run: () => Promise<unknown>;
};

function sites(): Site[] {
  const r53 = new Route53Provider();
  const kms = new KMSProvider();
  return [
    {
      site: 'Route 53 create HostedZone',
      command: 'CreateHostedZoneCommand',
      name: 'AccessDenied',
      action: 'route53:CreateHostedZone',
      prefix: 'Failed to create hosted zone Res: ',
      run: () => r53.create('Res', HZ, { Name: 'example.com' }),
    },
    {
      site: 'Route 53 create HostedZone Accelerated Recovery',
      command: 'UpdateHostedZoneFeaturesCommand',
      name: 'AccessDenied',
      action: 'route53:UpdateHostedZoneFeatures',
      prefix: `Failed to enable Accelerated Recovery on hosted zone Res (${ZONE}): `,
      answers: { CreateHostedZoneCommand: { HostedZone: { Id: `/hostedzone/${ZONE}` } } },
      run: () =>
        r53.create('Res', HZ, {
          Name: 'example.com',
          HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
        }),
    },
    {
      site: 'Route 53 update HostedZone',
      command: 'GetHostedZoneCommand',
      name: 'AccessDenied',
      action: 'route53:GetHostedZone',
      prefix: 'Failed to update hosted zone Res: ',
      run: () =>
        r53.update('Res', ZONE, HZ, { Name: 'example.com' }, { Name: 'example.com' }),
    },
    {
      site: 'Route 53 update HostedZone tag removal',
      command: 'ChangeTagsForResourceCommand',
      name: 'AccessDenied',
      action: 'route53:ChangeTagsForResource',
      prefix: 'Failed to remove tag(s) gone from hosted zone Res: ',
      run: () =>
        r53.update(
          'Res',
          ZONE,
          HZ,
          { Name: 'example.com', HostedZoneTags: [] },
          { Name: 'example.com', HostedZoneTags: [{ Key: 'gone', Value: 'v' }] }
        ),
    },
    {
      site: 'Route 53 delete HostedZone',
      command: 'DeleteHostedZoneCommand',
      name: 'AccessDenied',
      action: 'route53:DeleteHostedZone',
      prefix: 'Failed to delete hosted zone Res: ',
      run: () => r53.delete('Res', ZONE, HZ),
    },
    {
      site: 'Route 53 create RecordSet',
      command: 'ChangeResourceRecordSetsCommand',
      name: 'AccessDenied',
      action: 'route53:ChangeResourceRecordSets',
      prefix: 'Failed to create record set Res: ',
      run: () => r53.create('Res', RS, RECORD),
    },
    {
      site: 'Route 53 update RecordSet',
      command: 'ChangeResourceRecordSetsCommand',
      name: 'AccessDenied',
      action: 'route53:ChangeResourceRecordSets',
      prefix: 'Failed to update record set Res: ',
      run: () =>
        r53.update('Res', `${ZONE}|www.example.com.|A`, RS, { ...RECORD, TTL: '60' }, RECORD),
    },
    {
      site: 'Route 53 delete RecordSet',
      command: 'ChangeResourceRecordSetsCommand',
      name: 'AccessDenied',
      action: 'route53:ChangeResourceRecordSets',
      prefix: 'Failed to delete record set Res: ',
      run: () => r53.delete('Res', `${ZONE}|www.example.com.|A`, RS, RECORD),
    },
    {
      site: 'Route 53 RecordSet HostedZoneName lookup',
      command: 'ListHostedZonesByNameCommand',
      name: 'AccessDenied',
      action: 'route53:ListHostedZonesByName',
      prefix: 'Could not resolve HostedZoneName "example.com." for record set Res: ',
      run: () =>
        r53.create('Res', RS, {
          HostedZoneName: 'example.com.',
          Name: 'www.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['192.0.2.1'],
        }),
    },
    {
      site: 'KMS create Key',
      command: 'CreateKeyCommand',
      name: 'AccessDeniedException',
      action: 'kms:CreateKey',
      prefix: 'Failed to create KMS Key Res: ',
      run: () => kms.create('Res', 'AWS::KMS::Key', { Description: 'd-create' }),
    },
    {
      site: 'KMS create Key follow-up EnableKeyRotation',
      command: 'EnableKeyRotationCommand',
      name: 'AccessDeniedException',
      action: 'kms:EnableKeyRotation',
      prefix: 'Failed to create KMS Key Res: ',
      answers: { CreateKeyCommand: { KeyMetadata: { KeyId: KEY_ID, Arn: KEY_ARN } } },
      run: () =>
        kms.create('Res', 'AWS::KMS::Key', { Description: 'd-rotate', EnableKeyRotation: true }),
    },
    {
      site: 'KMS update Key',
      command: 'UpdateKeyDescriptionCommand',
      name: 'AccessDeniedException',
      action: 'kms:UpdateKeyDescription',
      prefix: 'Failed to update KMS Key Res: ',
      run: () =>
        kms.update('Res', KEY_ID, 'AWS::KMS::Key', { Description: 'new' }, { Description: 'old' }),
    },
    {
      site: 'KMS delete Key',
      command: 'ScheduleKeyDeletionCommand',
      name: 'AccessDeniedException',
      action: 'kms:ScheduleKeyDeletion',
      prefix: 'Failed to schedule deletion for KMS Key Res: ',
      run: () => kms.delete('Res', KEY_ID, 'AWS::KMS::Key'),
    },
    {
      site: 'KMS create Alias',
      command: 'CreateAliasCommand',
      name: 'AccessDeniedException',
      action: 'kms:CreateAlias',
      prefix: 'Failed to create KMS Alias Res: ',
      run: () =>
        kms.create('Res', 'AWS::KMS::Alias', { AliasName: 'alias/a', TargetKeyId: KEY_ID }),
    },
    {
      site: 'KMS update Alias',
      command: 'UpdateAliasCommand',
      name: 'AccessDeniedException',
      action: 'kms:UpdateAlias',
      prefix: 'Failed to update KMS Alias Res: ',
      run: () =>
        kms.update(
          'Res',
          'alias/a',
          'AWS::KMS::Alias',
          { AliasName: 'alias/a', TargetKeyId: KEY_ID },
          { AliasName: 'alias/a', TargetKeyId: 'old' }
        ),
    },
    {
      site: 'KMS delete Alias',
      command: 'DeleteAliasCommand',
      name: 'AccessDeniedException',
      action: 'kms:DeleteAlias',
      prefix: 'Failed to delete KMS Alias Res: ',
      run: () => kms.delete('Res', 'alias/a', 'AWS::KMS::Alias'),
    },
  ];
}

describe('Route 53 / KMS thrown wraps keep the caller identity out (go-to-k/cdkd#2319)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
    warnSpy.mockReset();
  });

  describe.each(sites())('$site', ({ site, command, name, action, prefix, answers, run }) => {
    it('names an AWS-authored failure by its class, keeps cause, and stays retryable', async () => {
      const original = accessDenied(name, action);
      failOn(command, original, answers);
      const failure = await thrown(run());

      // Non-vacuity: the rejection came from the site's own command.
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect(failure.message).toContain(`${prefix}${name}. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(failure.message).not.toContain(CALLER_ROLE);
      expect(failure.message).not.toContain(CALLER_SESSION);
      expect(failure.cause).toBe(original);

      // The withheld `not authorized to perform` still reaches the classifier.
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);

      // AWS's own text is not discarded: it is on the debug line, never only
      // dropped (the lookup's warn names the class since go-to-k/cdkd#2319).
      expect(debugged()).toContain(CALLER_ARN);
    });

    it('keeps a cdkd-authored or transport failure verbatim, unstamped', async () => {
      const original = new Error('connect ECONNREFUSED 10.0.0.1:443');
      failOn(command, original, answers);
      const failure = await thrown(run());

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
      expect(failure.cause).toBe(original);
    });

    // The Route 53 wraps withhold a non-Error throw like an AWS failure
    // (go-to-k/cdkd#2319 tail-d): its `String()` is the whole payload.
    const withholdsNonError = site.startsWith('Route 53');

    it.skipIf(withholdsNonError)('keeps a non-Error throw as text, unstamped', async () => {
      failOn(command, 'socket hang up', answers);
      const failure = await thrown(run());

      expect(failure.message).toContain(`${prefix}socket hang up`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
    });

    it.runIf(withholdsNonError)('withholds a non-Error throw, unstamped', async () => {
      failOn(command, 'socket hang up', answers);
      const failure = await thrown(run());

      expect(failure.message).toContain(
        `${prefix}a non-Error value of type string. ${VERBOSE_POINTER}`
      );
      expect(failure.message).not.toContain('socket hang up');
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });

  it('the Accelerated Recovery mutation lock stays retryable through the redacted wrap', async () => {
    // `is marked disabled for mutation` is a RETRYABLE_ERROR_MESSAGE_PATTERNS
    // substring; withholding it from the message must not make it terminal.
    const original = awsError(
      'ConcurrentModification',
      `HostedZone ${ZONE} is marked disabled for mutation`
    );
    failOn('GetHostedZoneCommand', original);
    const failure = await thrown(
      new Route53Provider().update('Res', ZONE, HZ, { Name: 'example.com' }, { Name: 'example.com' })
    );
    expect(failure.message).toContain(`ConcurrentModification. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('disabled for mutation');
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
  });

  it('closes the redacted class as one sentence before the tag-removal remedy', async () => {
    failOn('ChangeTagsForResourceCommand', accessDenied('AccessDenied', 'route53:ChangeTagsForResource'));
    const failure = await thrown(
      new Route53Provider().update(
        'Res',
        ZONE,
        HZ,
        { Name: 'example.com', HostedZoneTags: [] },
        { Name: 'example.com', HostedZoneTags: [{ Key: 'gone', Value: 'v' }] }
      )
    );
    expect(failure.message).toContain(
      `${VERBOSE_POINTER} The removal will NOT be retried on the next deploy`
    );
    expect(failure.message).not.toContain('..');
  });

  it('the KMS key create keeps the created-before-failure mark on the redacted wrap', async () => {
    failOn('EnableKeyRotationCommand', accessDenied('AccessDeniedException', 'kms:EnableKeyRotation'), {
      CreateKeyCommand: { KeyMetadata: { KeyId: KEY_ID, Arn: KEY_ARN } },
    });
    const failure = await thrown(
      new KMSProvider().create('Res', 'AWS::KMS::Key', {
        Description: 'd-mark',
        EnableKeyRotation: true,
      })
    );
    expect(failure.message).toContain(`AccessDeniedException. ${VERBOSE_POINTER}`);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(createdBeforeFailure(failure, 'Res', 'AWS::KMS::Key')).toBe(KEY_ID);
  });

  it('the CNAME-conflict refusal keeps its collision note and marker', async () => {
    const CNAME_CONFLICT =
      '[RRSet of type CNAME with DNS name www.example.com. is not permitted as it conflicts with other records with the same DNS name in zone example.com.]';
    failOn('ChangeResourceRecordSetsCommand', awsError('InvalidChangeBatch', CNAME_CONFLICT));
    const failure = await thrown(
      new Route53Provider().create('Res', RS, {
        ...RECORD,
        Type: 'CNAME',
        ResourceRecords: ['t.example.com'],
      })
    );
    expect(failure.message).toContain(`InvalidChangeBatch. ${VERBOSE_POINTER}`);
    expect(failure.message).toContain(
      `Failed to create record set Res (a record with the same DNS name already exists in the hosted zone): InvalidChangeBatch. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('is not permitted');
    expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
  });

  describe('restates an occupied name', () => {
    const cases = [
      {
        label: 'Route 53 duplicate record',
        command: 'ChangeResourceRecordSetsCommand',
        error: awsError(
          'InvalidChangeBatch',
          "[Tried to create resource record set [name='www.example.com.', type='A'] but it already exists]"
        ),
        other: awsError('InvalidChangeBatch', '[Invalid Resource Record: FATAL problem: ARRDATAIllegalIPv4Address]'),
        run: () => new Route53Provider().create('Res', RS, RECORD),
      },
      {
        label: 'KMS alias',
        command: 'CreateAliasCommand',
        error: awsError(
          'AlreadyExistsException',
          `An alias with the name arn:aws:kms:us-east-1:${CALLER_ACCOUNT}:alias/a already exists`
        ),
        other: awsError('ValidationException', 'AliasName must begin with alias/'),
        run: () =>
          new KMSProvider().create('Res', 'AWS::KMS::Alias', {
            AliasName: 'alias/a',
            TargetKeyId: KEY_ID,
          }),
      },
    ];

    it.each(cases)('$label', async ({ command, error, run }) => {
      failOn(command, error);
      const failure = await thrown(run());
      expect(failure.message).toContain(' AWS reports that it already exists.');
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
    });

    it.each(cases)('$label: a refusal that is not an occupied name restates nothing', async ({ command, other, run }) => {
      failOn(command, other);
      const failure = await thrown(run());
      expect(failure.message).toContain(VERBOSE_POINTER);
      expect(failure.message).not.toContain('already exists');
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(false);
    });
  });

  it('masks a secret AWS echoes back on the debug line (Route 53 record create)', async () => {
    const SECRET = 'r53-secret-record-value';
    failOn(
      'ChangeResourceRecordSetsCommand',
      awsError('InvalidChangeBatch', `[Invalid Resource Record: '${SECRET}']`)
    );
    const failure = await thrown(
      new Route53Provider().create('Res', RS, RECORD, {
        maskSecrets: (text: string) => text.split(SECRET).join('***'),
      })
    );
    expect(failure.message).toContain(`InvalidChangeBatch. ${VERBOSE_POINTER}`);
    expect(debugged()).toContain("Invalid Resource Record: '***'");
    expect(debugged()).not.toContain(SECRET);
  });

  it.each([
    ['update', 'UpdateHostedZoneCommentCommand'],
    ['tag removal', 'ChangeTagsForResourceCommand'],
  ])('Route 53 hosted zone %s threads the update masker to the debug line', async (_label, command) => {
    const SECRET = 'r53-secret-comment';
    failOn(command, awsError('InvalidInput', `Invalid value '${SECRET}'`));
    await thrown(
      new Route53Provider().update(
        'Res',
        ZONE,
        HZ,
        { Name: 'example.com', HostedZoneConfig: { Comment: 'new' }, HostedZoneTags: [] },
        {
          Name: 'example.com',
          HostedZoneConfig: { Comment: 'old' },
          HostedZoneTags: [{ Key: 'gone', Value: 'v' }],
        },
        { maskSecrets: (text: string) => text.split(SECRET).join('***') }
      )
    );
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
    expect(debugged()).toContain("Invalid value '***'");
    expect(debugged()).not.toContain(SECRET);
  });

  it.each([
    ['Route 53 record delete', 'ChangeResourceRecordSetsCommand', () =>
      new Route53Provider().delete('Res', `${ZONE}|www.example.com.|A`, RS, RECORD, {
        maskSecrets: (text: string) => text.split('kms-r53-secret').join('***'),
      })],
    ['KMS alias delete', 'DeleteAliasCommand', () =>
      new KMSProvider().delete('Res', 'alias/a', 'AWS::KMS::Alias', undefined, {
        maskSecrets: (text: string) => text.split('kms-r53-secret').join('***'),
      })],
    ['KMS key update', 'UpdateKeyDescriptionCommand', () =>
      new KMSProvider().update(
        'Res',
        KEY_ID,
        'AWS::KMS::Key',
        { Description: 'new' },
        { Description: 'old' },
        { maskSecrets: (text: string) => text.split('kms-r53-secret').join('***') }
      )],
    ['Route 53 hosted zone create', 'CreateHostedZoneCommand', () =>
      new Route53Provider().create('Res', HZ, { Name: 'example.com' }, { maskSecrets: MASK })],
    ['Route 53 Accelerated Recovery enable', 'UpdateHostedZoneFeaturesCommand', () =>
      new Route53Provider().create(
        'Res',
        HZ,
        { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' } },
        { maskSecrets: MASK }
      )],
    ['Route 53 hosted zone delete', 'DeleteHostedZoneCommand', () =>
      new Route53Provider().delete('Res', ZONE, HZ, undefined, { maskSecrets: MASK })],
    ['Route 53 record update', 'ChangeResourceRecordSetsCommand', () =>
      new Route53Provider().update(
        'Res',
        `${ZONE}|www.example.com.|A`,
        RS,
        { ...RECORD, TTL: '60' },
        RECORD,
        { maskSecrets: MASK }
      )],
    ['KMS alias create', 'CreateAliasCommand', () =>
      new KMSProvider().create(
        'Res',
        'AWS::KMS::Alias',
        { AliasName: 'alias/a', TargetKeyId: KEY_ID },
        { maskSecrets: MASK }
      )],
    ['KMS alias update', 'UpdateAliasCommand', () =>
      new KMSProvider().update(
        'Res',
        'alias/a',
        'AWS::KMS::Alias',
        { AliasName: 'alias/a', TargetKeyId: KEY_ID },
        { AliasName: 'alias/a', TargetKeyId: 'old' },
        { maskSecrets: MASK }
      )],
    ['KMS key delete', 'ScheduleKeyDeletionCommand', () =>
      new KMSProvider().delete('Res', KEY_ID, 'AWS::KMS::Key', undefined, { maskSecrets: MASK })],
    ['KMS key create', 'CreateKeyCommand', () =>
      new KMSProvider().create('Res', 'AWS::KMS::Key', { Description: 'd-mask' }, {
        maskSecrets: (text: string) => text.split('kms-r53-secret').join('***'),
      })],
  ])('%s masks a secret AWS echoes back on the debug line', async (_label, command, run) => {
    failOn(command, awsError('ValidationException', "Invalid value 'kms-r53-secret'"), {
      CreateHostedZoneCommand: { HostedZone: { Id: `/hostedzone/${ZONE}` } },
    });
    const failure = await thrown(run());
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
    expect(failure.message).toContain(`ValidationException. ${VERBOSE_POINTER}`);
    expect(debugged()).toContain("Invalid value '***'");
    expect(debugged()).not.toContain('kms-r53-secret');
  });

  it('a hosted zone delete that stripped the zone first stays delete-started on the redacted wrap', async () => {
    // A query-logging config detached before the refused DeleteHostedZone sets
    // `progress.stripped`; `markDeleteStarted` must land on the redacted wrap.
    failOn('DeleteHostedZoneCommand', accessDenied('AccessDenied', 'route53:DeleteHostedZone'), {
      ListQueryLoggingConfigsCommand: { QueryLoggingConfigs: [{ Id: 'qlc-1', HostedZoneId: ZONE }] },
    });
    const failure = await thrown(new Route53Provider().delete('Res', ZONE, HZ));
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === 'DeleteQueryLoggingConfigCommand')).toBe(true);
    expect(failure.message).toContain(`AccessDenied. ${VERBOSE_POINTER}`);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(isDeleteStarted(failure)).toBe(true);
  });

  it.each([
    ['the rollback delete also fails', true],
    ['the rollback delete succeeds', false],
  ])(
    'a hosted zone create whose Accelerated Recovery enable fails keeps its marks on the redacted wrap (%s)',
    async (_label, rollbackFails) => {
      mockSend.mockImplementation(async (command: unknown) => {
        const name = commandName(command);
        if (name === 'CreateHostedZoneCommand') return { HostedZone: { Id: `/hostedzone/${ZONE}` } };
        if (name === 'UpdateHostedZoneFeaturesCommand') {
          throw accessDenied('AccessDenied', 'route53:UpdateHostedZoneFeatures');
        }
        if (name === 'DeleteHostedZoneCommand' && rollbackFails) {
          throw accessDenied('AccessDenied', 'route53:DeleteHostedZone');
        }
        return {};
      });
      const failure = await thrown(
        new Route53Provider().create('Res', HZ, {
          Name: 'example.com',
          HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
        })
      );
      expect(failure.message).toContain(`AccessDenied. ${VERBOSE_POINTER}`);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(isAuxiliaryFailure(failure)).toBe(true);
      // A zone the rollback could not delete is live with no state record.
      expect(createdBeforeFailure(failure, 'Res', HZ)).toBe(rollbackFails ? ZONE : undefined);
    }
  );

  it('the hosted zone tag ADD warn goes through the operation masker', async () => {
    const SECRET = 'r53-secret-tag-value';
    failOn('ChangeTagsForResourceCommand', awsError('InvalidInput', `Invalid tag value '${SECRET}'`));
    await new Route53Provider().update(
      'Res',
      ZONE,
      HZ,
      { Name: 'example.com', HostedZoneTags: [{ Key: 'k', Value: 'v2' }] },
      { Name: 'example.com', HostedZoneTags: [{ Key: 'k', Value: 'v1' }] },
      { maskSecrets: (text: string) => text.split(SECRET).join('***') }
    );
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === 'ChangeTagsForResourceCommand')).toBe(true);
    expect(warned()).toContain("Failed to apply tags to hosted zone Res: Invalid tag value '***'");
    expect(warned()).not.toContain(SECRET);
  });
});
