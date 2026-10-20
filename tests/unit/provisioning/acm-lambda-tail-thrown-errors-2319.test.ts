import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * The ACM certificate and Lambda tail wraps (web function revision / endpoint,
 * MicroVM image, event source mapping, function URL) must not write the
 * CALLER'S IDENTITY into a persisted store (go-to-k/cdkd#2319).
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

const { mockSend, debugSpy, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  const client = () => ({
    send: (command: unknown) => send(command),
    config: {
      region: () => Promise.resolve('us-east-1'),
      retryStrategy: () => Promise.resolve(undefined),
    },
    middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
  });
  return { mockSend: send, debugSpy: vi.fn(), fakeClient: client };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    acm: fakeClient(),
    lambda: fakeClient(),
    lambdaWeb: fakeClient(),
    lambdaMicrovms: fakeClient(),
  }),
}));
// The Lambda and Lambda Web creates go through a dedicated client built from
// the SDK package (no 5xx replay); route it to the same mock.
vi.mock('@aws-sdk/client-lambda', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda')>()),
  LambdaClient: vi.fn().mockImplementation(fakeClient),
}));
vi.mock('@aws-sdk/client-lambda-web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda-web')>()),
  LambdaWebClient: vi.fn().mockImplementation(fakeClient),
}));
vi.mock('../../../src/provisioning/providers/lambda-web-function-arns.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sleep: () => Promise.resolve(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
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

import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import {
  LambdaWebFunctionRevisionProvider,
  resetWebFunctionRevisionCreateRetryStateForTests,
} from '../../../src/provisioning/providers/lambda-web-function-revision-provider.js';
import { LambdaWebFunctionEndpointProvider } from '../../../src/provisioning/providers/lambda-web-function-endpoint-provider.js';
import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';
import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import { LambdaUrlProvider } from '../../../src/provisioning/providers/lambda-url-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
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

const SECRET = 'acm-lambda-tail-secret';
const MASK = (text: string): string => text.split(SECRET).join('***');

const CERT = 'AWS::CertificateManager::Certificate';
const CERT_ARN = 'arn:aws:acm:us-east-1:111122223333:certificate/abcd-1234';
const REV = 'AWS::Lambda::WebFunctionRevision';
const EP = 'AWS::Lambda::WebFunctionEndpoint';
const FN_ARN = 'arn:aws:lambda:us-east-1:111122223333:web-function/my-fn';
const REV_ARN = `${FN_ARN}/revision/rev-abc12`;
const EP_ARN = `${FN_ARN}/endpoint/prod`;
const REV_PROPS = {
  FunctionName: FN_ARN,
  BuildConfig: {
    CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'app.zip' } },
    RuntimeConfig: { Runtime: 'nodejs24.x' },
  },
  ServiceConfig: { ExecutionRoleArn: 'arn:aws:iam::111122223333:role/exec' },
};
const EP_PROPS = {
  FunctionName: FN_ARN,
  EndpointName: 'prod',
  EndpointType: 'HomeRegion',
  AuthType: 'IamAuth',
  RevisionWeights: [{ RevisionId: 'rev-abc12', Weight: 100 }],
};
const IMG = 'AWS::Lambda::MicrovmImage';
const IMG_ARN = 'arn:aws:lambda:us-east-1:111122223333:microvm-image:my-image';
const IMG_PROPS = {
  Name: 'my-image',
  BaseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
  BuildRoleArn: 'arn:aws:iam::111122223333:role/MicrovmBuildRole',
  CodeArtifact: { Uri: 's3://my-bucket/app.zip' },
};
const ESM = 'AWS::Lambda::EventSourceMapping';
const ESM_UUID = '11111111-2222-3333-4444-555555555555';
const ESM_PROPS = {
  FunctionName: 'worker-fn',
  EventSourceArn: 'arn:aws:sqs:us-east-1:111122223333:queue',
};
const URL_TYPE = 'AWS::Lambda::Url';
const URL_FN = 'arn:aws:lambda:us-east-1:111122223333:function:url-fn';

type Site = {
  site: string;
  command: string;
  /** The error class the denial carries, the service's own. */
  name: string;
  /** The IAM action the denial names, the site's own. */
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  /** Runs the operation with `mask` threaded as the operation's `maskSecrets`. */
  run: (mask?: (text: string) => string) => Promise<unknown>;
};

function sites(): Site[] {
  const ctx = (mask?: (text: string) => string) => (mask ? { maskSecrets: mask } : undefined);
  return [
    {
      site: 'ACM create',
      command: 'RequestCertificateCommand',
      name: 'AccessDeniedException',
      action: 'acm:RequestCertificate',
      prefix: 'Failed to create ACM certificate Res: ',
      run: (mask) =>
        new ACMCertificateProvider().create('Res', CERT, { DomainName: 'example.com' }, ctx(mask)),
    },
    {
      site: 'ACM update',
      command: 'UpdateCertificateOptionsCommand',
      name: 'AccessDeniedException',
      action: 'acm:UpdateCertificateOptions',
      prefix: 'Failed to update ACM certificate Res: ',
      run: (mask) =>
        new ACMCertificateProvider().update(
          'Res',
          CERT_ARN,
          CERT,
          { DomainName: 'example.com', CertificateTransparencyLoggingPreference: 'DISABLED' },
          { DomainName: 'example.com', CertificateTransparencyLoggingPreference: 'ENABLED' },
          ctx(mask)
        ),
    },
    {
      site: 'ACM delete',
      command: 'DeleteCertificateCommand',
      name: 'AccessDeniedException',
      action: 'acm:DeleteCertificate',
      prefix: 'Failed to delete ACM certificate Res: ',
      run: (mask) => new ACMCertificateProvider().delete('Res', CERT_ARN, CERT, undefined, ctx(mask)),
    },
    {
      site: 'web function revision create',
      command: 'CreateWebFunctionRevisionCommand',
      name: 'AccessDeniedException',
      action: 'lambda:CreateWebFunctionRevision',
      prefix: 'Failed to create Lambda web function revision Res: ',
      run: (mask) => new LambdaWebFunctionRevisionProvider().create('Res', REV, REV_PROPS, ctx(mask)),
    },
    {
      site: 'web function revision delete',
      command: 'DeleteWebFunctionRevisionCommand',
      name: 'AccessDeniedException',
      action: 'lambda:DeleteWebFunctionRevision',
      prefix: 'Failed to delete Lambda web function revision Res: ',
      run: (mask) =>
        new LambdaWebFunctionRevisionProvider().delete('Res', REV_ARN, REV, undefined, ctx(mask)),
    },
    {
      site: 'web function endpoint create',
      command: 'CreateWebFunctionEndpointCommand',
      name: 'AccessDeniedException',
      action: 'lambda:CreateWebFunctionEndpoint',
      prefix: 'Failed to create Lambda web function endpoint Res: ',
      run: (mask) => new LambdaWebFunctionEndpointProvider().create('Res', EP, EP_PROPS, ctx(mask)),
    },
    {
      site: 'web function endpoint update',
      command: 'UpdateWebFunctionEndpointCommand',
      name: 'AccessDeniedException',
      action: 'lambda:UpdateWebFunctionEndpoint',
      prefix: 'Failed to update Lambda web function endpoint Res: ',
      run: (mask) =>
        new LambdaWebFunctionEndpointProvider().update(
          'Res',
          EP_ARN,
          EP,
          EP_PROPS,
          EP_PROPS,
          ctx(mask)
        ),
    },
    {
      site: 'web function endpoint delete',
      command: 'DeleteWebFunctionEndpointCommand',
      name: 'AccessDeniedException',
      action: 'lambda:DeleteWebFunctionEndpoint',
      prefix: 'Failed to delete Lambda web function endpoint Res: ',
      run: (mask) =>
        new LambdaWebFunctionEndpointProvider().delete('Res', EP_ARN, EP, undefined, ctx(mask)),
    },
    {
      site: 'MicroVM image create',
      command: 'CreateMicrovmImageCommand',
      name: 'AccessDeniedException',
      action: 'lambda:CreateMicrovmImage',
      prefix: 'Failed to create MicroVM image Res: ',
      run: (mask) => new LambdaMicrovmImageProvider().create('Res', IMG, IMG_PROPS, ctx(mask)),
    },
    {
      site: 'MicroVM image update',
      command: 'UpdateMicrovmImageCommand',
      name: 'AccessDeniedException',
      action: 'lambda:UpdateMicrovmImage',
      prefix: 'Failed to update MicroVM image Res: ',
      run: (mask) =>
        new LambdaMicrovmImageProvider().update(
          'Res',
          IMG_ARN,
          IMG,
          { ...IMG_PROPS, Description: 'new' },
          { ...IMG_PROPS, Description: 'old' },
          ctx(mask)
        ),
    },
    {
      site: 'MicroVM image delete',
      command: 'DeleteMicrovmImageCommand',
      name: 'AccessDeniedException',
      action: 'lambda:DeleteMicrovmImage',
      prefix: 'Failed to delete MicroVM image Res: ',
      run: (mask) => new LambdaMicrovmImageProvider().delete('Res', IMG_ARN, IMG, undefined, ctx(mask)),
    },
    {
      site: 'event source mapping create',
      command: 'CreateEventSourceMappingCommand',
      name: 'AccessDeniedException',
      action: 'lambda:CreateEventSourceMapping',
      prefix: 'Failed to create event source mapping Res: ',
      run: (mask) => new LambdaEventSourceMappingProvider().create('Res', ESM, ESM_PROPS, ctx(mask)),
    },
    {
      site: 'event source mapping update',
      command: 'UpdateEventSourceMappingCommand',
      name: 'AccessDeniedException',
      action: 'lambda:UpdateEventSourceMapping',
      prefix: 'Failed to update event source mapping Res: ',
      run: (mask) =>
        new LambdaEventSourceMappingProvider().update(
          'Res',
          ESM_UUID,
          ESM,
          { ...ESM_PROPS, BatchSize: 5 },
          { ...ESM_PROPS, BatchSize: 10 },
          ctx(mask)
        ),
    },
    {
      site: 'event source mapping delete',
      command: 'DeleteEventSourceMappingCommand',
      name: 'AccessDeniedException',
      action: 'lambda:DeleteEventSourceMapping',
      prefix: 'Failed to delete event source mapping Res: ',
      run: (mask) =>
        new LambdaEventSourceMappingProvider().delete('Res', ESM_UUID, ESM, undefined, ctx(mask)),
    },
    {
      site: 'function URL create',
      command: 'CreateFunctionUrlConfigCommand',
      name: 'AccessDeniedException',
      action: 'lambda:CreateFunctionUrlConfig',
      prefix: 'Failed to create Lambda URL Res: ',
      run: (mask) =>
        new LambdaUrlProvider().create('Res', URL_TYPE, { TargetFunctionArn: URL_FN }, ctx(mask)),
    },
    {
      site: 'function URL update',
      command: 'UpdateFunctionUrlConfigCommand',
      name: 'AccessDeniedException',
      action: 'lambda:UpdateFunctionUrlConfig',
      prefix: 'Failed to update Lambda URL Res: ',
      run: (mask) =>
        new LambdaUrlProvider().update(
          'Res',
          URL_FN,
          URL_TYPE,
          { TargetFunctionArn: URL_FN, AuthType: 'AWS_IAM' },
          { TargetFunctionArn: URL_FN, AuthType: 'NONE' },
          ctx(mask)
        ),
    },
    {
      site: 'function URL delete',
      command: 'DeleteFunctionUrlConfigCommand',
      name: 'AccessDeniedException',
      action: 'lambda:DeleteFunctionUrlConfig',
      prefix: 'Failed to delete Lambda URL Res: ',
      run: (mask) => new LambdaUrlProvider().delete('Res', URL_FN, URL_TYPE, undefined, ctx(mask)),
    },
  ];
}

describe('ACM / Lambda tail thrown wraps keep the caller identity out (go-to-k/cdkd#2319)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
    resetWebFunctionRevisionCreateRetryStateForTests();
    process.env['CDKD_MICROVM_IMAGE_POLL_INTERVAL_MS'] = '1';
    process.env['CDKD_MICROVM_IMAGE_POLL_ATTEMPTS'] = '2';
  });
  afterEach(() => {
    delete process.env['CDKD_MICROVM_IMAGE_POLL_INTERVAL_MS'];
    delete process.env['CDKD_MICROVM_IMAGE_POLL_ATTEMPTS'];
  });

  describe.each(sites())('$site', ({ command, name, action, prefix, answers, run }) => {
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

      // AWS's own text is not discarded: it is logged at debug.
      expect(debugged()).toContain(CALLER_ARN);
    });

    it("masks AWS's text on the debug line through the operation's masker", async () => {
      failOn(command, awsError('ValidationException', `Invalid value '${SECRET}'`), answers);
      const failure = await thrown(run(MASK));

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(`${prefix}ValidationException. ${VERBOSE_POINTER}`);
      expect(debugged()).toContain("Invalid value '***'");
      expect(debugged()).not.toContain(SECRET);
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

    it('keeps a non-Error throw as text, unstamped', async () => {
      failOn(command, 'socket hang up', answers);
      const failure = await thrown(run());

      expect(failure.message).toContain(`${prefix}socket hang up`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });

  it('the ACM create whose cleanup also fails keeps the survivor note and created-before mark', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'RequestCertificateCommand') return { CertificateArn: CERT_ARN };
      if (name === 'DescribeCertificateCommand') {
        throw accessDenied('AccessDeniedException', 'acm:DescribeCertificate');
      }
      if (name === 'DeleteCertificateCommand') {
        throw accessDenied('AccessDeniedException', 'acm:DeleteCertificate');
      }
      return {};
    });
    const failure = await thrown(
      new ACMCertificateProvider().create('Res', CERT, { DomainName: 'example.com' })
    );
    expect(failure.message).toContain(
      `Failed to create ACM certificate Res: AccessDeniedException. ${VERBOSE_POINTER} ` +
        `The certificate ${CERT_ARN} this attempt created could NOT be deleted`
    );
    expect(failure.message).not.toContain(CALLER_ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(createdBeforeFailure(failure, 'Res', CERT)).toBe(CERT_ARN);
  });

  it('the ACM create whose cleanup succeeds names no survivor', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'RequestCertificateCommand') return { CertificateArn: CERT_ARN };
      if (name === 'DescribeCertificateCommand') {
        throw accessDenied('AccessDeniedException', 'acm:DescribeCertificate');
      }
      return {};
    });
    const failure = await thrown(
      new ACMCertificateProvider().create('Res', CERT, { DomainName: 'example.com' })
    );
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === 'DeleteCertificateCommand')).toBe(true);
    expect(failure.message).toContain(`AccessDeniedException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('could NOT be deleted');
    expect(createdBeforeFailure(failure, 'Res', CERT)).toBeUndefined();
  });

  it.each([
    [
      'web function endpoint',
      'CreateWebFunctionEndpointCommand',
      () => new LambdaWebFunctionEndpointProvider().create('Res', EP, EP_PROPS),
      EP_ARN,
      EP,
      { CreateWebFunctionEndpointCommand: { endpointArn: EP_ARN } },
      'GetWebFunctionEndpointCommand',
    ],
    [
      'MicroVM image',
      'CreateMicrovmImageCommand',
      () => new LambdaMicrovmImageProvider().create('Res', IMG, IMG_PROPS),
      IMG_ARN,
      IMG,
      { CreateMicrovmImageCommand: { imageArn: IMG_ARN, state: 'CREATING' } },
      'GetMicrovmImageCommand',
    ],
  ])(
    'the %s create keeps the created-before-failure mark on the redacted wrap',
    async (_label, _create, run, arn, type, answers, failing) => {
      failOn(failing, accessDenied('AccessDeniedException', 'lambda:Get'), answers);
      const failure = await thrown(run());
      expect(failure.message).toContain(`AccessDeniedException. ${VERBOSE_POINTER}`);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(createdBeforeFailure(failure, 'Res', type)).toBe(arn);
    }
  );

  it("the ACM replacement update threads the update's masker into its inner create", async () => {
    failOn('RequestCertificateCommand', awsError('ValidationException', `Invalid value '${SECRET}'`));
    const failure = await thrown(
      new ACMCertificateProvider().update(
        'Res',
        CERT_ARN,
        CERT,
        { DomainName: 'new.example.com' },
        { DomainName: 'example.com' },
        { maskSecrets: MASK }
      )
    );
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === 'RequestCertificateCommand')).toBe(true);
    expect(failure.message).toContain(`ValidationException. ${VERBOSE_POINTER}`);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(debugged()).toContain("Invalid value '***'");
    expect(debugged()).not.toContain(SECRET);
  });

  it('the ACM replacement whose old-certificate delete is denied records a redacted reason', async () => {
    const NEW_ARN = 'arn:aws:acm:us-east-1:111122223333:certificate/new-5678';
    failOn('DeleteCertificateCommand', accessDenied('AccessDeniedException', 'acm:DeleteCertificate'), {
      RequestCertificateCommand: { CertificateArn: NEW_ARN },
      DescribeCertificateCommand: { Certificate: { Status: 'ISSUED' } },
    });
    const result = await new ACMCertificateProvider().update(
      'Res',
      CERT_ARN,
      CERT,
      { DomainName: 'new.example.com' },
      { DomainName: 'example.com' }
    );
    // Non-vacuity: the replacement reached the old certificate's delete.
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === 'DeleteCertificateCommand')).toBe(true);
    expect(result.physicalId).toBe(NEW_ARN);
    const reason = (result as { reason?: string }).reason ?? '';
    expect(reason).toContain(`AccessDeniedException. ${VERBOSE_POINTER}`);
    expect(reason).not.toContain(CALLER_ACCOUNT);
    expect(reason).not.toContain(CALLER_SESSION);
  });

  describe('restates an occupied name', () => {
    const cases = [
      {
        label: 'event source mapping',
        command: 'CreateEventSourceMappingCommand',
        error: awsError(
          'ResourceConflictException',
          `An event source mapping with SQS arn and function already exists. Please update or delete the existing mapping with UUID ${ESM_UUID}`,
          409
        ),
        other: awsError('ResourceConflictException', 'The operation cannot be performed at this time.', 409),
        run: () => new LambdaEventSourceMappingProvider().create('Res', ESM, ESM_PROPS),
      },
      {
        label: 'web function endpoint',
        command: 'CreateWebFunctionEndpointCommand',
        error: awsError('ConflictException', 'Endpoint prod already exists for function my-fn', 409),
        other: awsError('ValidationException', 'RevisionWeights must sum to 100'),
        run: () => new LambdaWebFunctionEndpointProvider().create('Res', EP, EP_PROPS),
      },
      {
        label: 'MicroVM image',
        command: 'CreateMicrovmImageCommand',
        error: awsError('ConflictException', 'A MicroVM image named my-image already exists', 409),
        other: awsError('ValidationException', 'BaseImageArn is not valid'),
        run: () => new LambdaMicrovmImageProvider().create('Res', IMG, IMG_PROPS),
      },
    ];

    it.each(cases)('$label', async ({ command, error, run }) => {
      failOn(command, error);
      const failure = await thrown(run());
      expect(failure.message).toContain(' AWS reports that it already exists.');
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

  it('a revision delete in use keeps the conflict class, not the endpoint list', async () => {
    failOn(
      'DeleteWebFunctionRevisionCommand',
      awsError('ConflictException', `endpoints [prod] are using it (${CALLER_ACCOUNT})`, 409)
    );
    const failure = await thrown(new LambdaWebFunctionRevisionProvider().delete('Res', REV_ARN, REV));
    expect(failure.message).toBe(
      `Failed to delete Lambda web function revision Res: ConflictException. ${VERBOSE_POINTER}`
    );
    expect(debugged()).toContain('endpoints [prod] are using it');
  });

  /** A revision create whose readiness wait is denied, then whose cleanup delete is refused. */
  function revisionCreateLeftBehind(deleteError: Error): void {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateWebFunctionRevisionCommand') {
        return { revisionArn: REV_ARN, revisionId: 'rev-abc12' };
      }
      if (name === 'GetWebFunctionRevisionCommand') {
        throw accessDenied('AccessDeniedException', 'lambda:GetWebFunctionRevision');
      }
      if (name === 'DeleteWebFunctionRevisionCommand') throw deleteError;
      return {};
    });
  }

  it('a revision create whose cleanup delete is refused keeps its survivor marks on the redacted wrap', async () => {
    revisionCreateLeftBehind(accessDenied('AccessDeniedException', 'lambda:DeleteWebFunctionRevision'));
    const failure = await thrown(new LambdaWebFunctionRevisionProvider().create('Res', REV, REV_PROPS));
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === 'DeleteWebFunctionRevisionCommand')).toBe(true);
    expect(failure.message).toContain(
      `Failed to create Lambda web function revision Res: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain(CALLER_ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(true);
    expect(createdBeforeFailure(failure, 'Res', REV)).toBe(REV_ARN);
  });

  it("a revision create threads its masker into the cleanup delete's debug line", async () => {
    revisionCreateLeftBehind(awsError('ValidationException', `Invalid value '${SECRET}'`));
    await thrown(new LambdaWebFunctionRevisionProvider().create('Res', REV, REV_PROPS, { maskSecrets: MASK }));
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === 'DeleteWebFunctionRevisionCommand')).toBe(true);
    expect(debugged()).toContain("Invalid value '***'");
    expect(debugged()).not.toContain(SECRET);
  });

  // A secret whose plaintext is a WHOLE function ARN: the masker knows only the
  // ARN, so the bare name AWS quotes is removed by the delete's derived-name
  // needle alone.
  const ARN_SECRET_NAME = 'arn-secret-fn';
  const ARN_SECRET = `arn:aws:lambda:us-east-1:111122223333:function:${ARN_SECRET_NAME}`;
  const ARN_MASK = (text: string): string => text.split(ARN_SECRET).join('***');

  it.each([
    [
      'event source mapping',
      'DeleteEventSourceMappingCommand',
      () =>
        new LambdaEventSourceMappingProvider().delete(
          'Res',
          ESM_UUID,
          ESM,
          { ...ESM_PROPS, FunctionName: ARN_SECRET },
          { maskSecrets: ARN_MASK }
        ),
    ],
    [
      'function URL',
      'DeleteFunctionUrlConfigCommand',
      () =>
        new LambdaUrlProvider().delete(
          'Res',
          ARN_SECRET,
          URL_TYPE,
          { TargetFunctionArn: ARN_SECRET },
          { maskSecrets: ARN_MASK }
        ),
    ],
  ])(
    'the %s delete masks a derived function name AWS quotes back on its debug line',
    async (_label, command, run) => {
      failOn(command, awsError('ValidationException', `Function not found: ${ARN_SECRET_NAME}`));
      const failure = await thrown(run());
      expect(failure.message).toContain(`ValidationException. ${VERBOSE_POINTER}`);
      expect(debugged()).toContain('Function not found: ***');
      expect(debugged()).not.toContain(ARN_SECRET_NAME);
    }
  );
});

/**
 * Each inline wrap (caught error or status reason) masks the FINISHED debug line too (`m(build(m(detail)).message)`),
 * not only AWS's text: the cdkd prefix names the logical id, which a debug
 * sink the deploy engine does not bind could otherwise print unmasked.
 */
describe('the debug line is masked as a whole, prefix included (go-to-k/cdkd#2319)', () => {
  const SECRET_ID = `${SECRET}-Res`;
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
    resetWebFunctionRevisionCreateRetryStateForTests();
  });
  /** The one debug line carrying `needle`; fails unless exactly one does. */
  const wrapLine = (needle: string): string => {
    const lines = debugSpy.mock.calls.map((args) => String(args[0])).filter((l) => l.includes(needle));
    expect(lines).toHaveLength(1);
    return lines[0]!;
  };

  it.each([
    {
      helper: 'ACM wrapCaughtError',
      command: 'RequestCertificateCommand',
      prefix: 'Failed to create ACM certificate ***-Res: ',
      run: () =>
        new ACMCertificateProvider().create(SECRET_ID, CERT, { DomainName: 'example.com' }, { maskSecrets: MASK }),
    },
    {
      helper: 'MicroVM image wrapError',
      command: 'CreateMicrovmImageCommand',
      prefix: 'Failed to create MicroVM image ***-Res: ',
      run: () => new LambdaMicrovmImageProvider().create(SECRET_ID, IMG, IMG_PROPS, { maskSecrets: MASK }),
    },
    {
      helper: 'web function endpoint wrapError',
      command: 'CreateWebFunctionEndpointCommand',
      prefix: 'Failed to create Lambda web function endpoint ***-Res: ',
      run: () =>
        new LambdaWebFunctionEndpointProvider().create(SECRET_ID, EP, EP_PROPS, { maskSecrets: MASK }),
    },
    {
      helper: 'web function revision wrapError',
      command: 'CreateWebFunctionRevisionCommand',
      prefix: 'Failed to create Lambda web function revision ***-Res: ',
      run: () =>
        new LambdaWebFunctionRevisionProvider().create(SECRET_ID, REV, REV_PROPS, { maskSecrets: MASK }),
    },
  ])('$helper', async ({ command, prefix, run }) => {
    failOn(command, accessDenied('AccessDeniedException', 'x:Create'));
    await thrown(run());
    expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
    // The wrap's own line, not the provider's other (pre-existing) debug lines.
    const line = wrapLine('User: ');
    expect(line).toContain(`${prefix}User: ${CALLER_ARN} is not authorized`);
    expect(line).not.toContain(SECRET);
  });

  it.each([
    {
      helper: 'web function revision wrapStatusReasonError',
      prefix: 'Lambda web function revision ***-Res entered Failed: ',
      answers: {
        CreateWebFunctionRevisionCommand: { revisionArn: REV_ARN, revisionId: 'rev-abc12' },
        GetWebFunctionRevisionCommand: { state: 'Failed', stateReason: `role ${CALLER_ARN} cannot read` },
      },
      run: () =>
        new LambdaWebFunctionRevisionProvider().create(SECRET_ID, REV, REV_PROPS, { maskSecrets: MASK }),
    },
    {
      helper: 'web function endpoint wrapStatusReasonError (entered Failed)',
      prefix: 'Lambda web function endpoint ***-Res entered Failed: ',
      answers: {
        CreateWebFunctionEndpointCommand: { endpointArn: EP_ARN },
        GetWebFunctionEndpointCommand: { state: 'Failed', stateReason: `role ${CALLER_ARN} cannot read` },
      },
      run: () =>
        new LambdaWebFunctionEndpointProvider().create(SECRET_ID, EP, EP_PROPS, { maskSecrets: MASK }),
    },
    {
      helper: 'web function endpoint wrapStatusReasonError (update failed)',
      prefix: 'Lambda web function endpoint ***-Res update failed: ',
      answers: {
        UpdateWebFunctionEndpointCommand: {},
        GetWebFunctionEndpointCommand: {
          state: 'Active',
          updateStatus: 'Failed',
          updateStatusReason: `role ${CALLER_ARN} cannot read`,
        },
      },
      run: () =>
        new LambdaWebFunctionEndpointProvider().update(SECRET_ID, EP_ARN, EP, EP_PROPS, EP_PROPS, {
          maskSecrets: MASK,
        }),
    },
  ])('$helper', async ({ prefix, answers, run }) => {
    failOn('NoSuchCommand', undefined, answers);
    await thrown(run());
    const line = wrapLine('cannot read');
    expect(line).toContain(`${prefix}role ${CALLER_ARN} cannot read`);
    expect(line).not.toContain(SECRET);
  });
});

/**
 * A FAILED state read off a successful Get (go-to-k/cdkd#2319): AWS's reason is
 * not a caught error, yet it reached the same persisted thrown message.
 */
describe('a web function status reason stays out of the thrown message (go-to-k/cdkd#2319)', () => {
  const REASON = `role ${CALLER_ARN} cannot read ${SECRET}`;
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
    resetWebFunctionRevisionCreateRetryStateForTests();
  });

  it.each([
    {
      label: 'revision create, entered Failed',
      prefix: `Lambda web function revision Res entered Failed: E1. ${VERBOSE_POINTER}`,
      answers: {
        CreateWebFunctionRevisionCommand: { revisionArn: REV_ARN, revisionId: 'rev-abc12' },
        GetWebFunctionRevisionCommand: {
          state: 'Failed',
          stateReason: REASON,
          errors: [{ errorCode: 'E1', errorMessage: 'bad zip' }],
        },
      },
      cause: `${REASON} (E1 bad zip)`,
      physicalId: REV_ARN,
      run: (mask?: (t: string) => string) =>
        new LambdaWebFunctionRevisionProvider().create('Res', REV, REV_PROPS, mask ? { maskSecrets: mask } : undefined),
    },
    {
      label: 'endpoint create, entered Failed',
      prefix: `Lambda web function endpoint Res entered Failed: ${VERBOSE_POINTER}`,
      answers: {
        CreateWebFunctionEndpointCommand: { endpointArn: EP_ARN },
        GetWebFunctionEndpointCommand: { state: 'Failed', stateReason: REASON },
      },
      cause: REASON,
      physicalId: undefined,
      run: (mask?: (t: string) => string) =>
        new LambdaWebFunctionEndpointProvider().create('Res', EP, EP_PROPS, mask ? { maskSecrets: mask } : undefined),
    },
    {
      label: 'endpoint update, update failed',
      prefix: `Lambda web function endpoint Res update failed: ${VERBOSE_POINTER}`,
      answers: {
        UpdateWebFunctionEndpointCommand: {},
        GetWebFunctionEndpointCommand: { state: 'Active', updateStatus: 'Failed', updateStatusReason: REASON },
      },
      cause: REASON,
      physicalId: EP_ARN,
      run: (mask?: (t: string) => string) =>
        new LambdaWebFunctionEndpointProvider().update(
          'Res',
          EP_ARN,
          EP,
          EP_PROPS,
          EP_PROPS,
          mask ? { maskSecrets: mask } : undefined
        ),
    },
  ])('$label', async ({ prefix, answers, cause, physicalId, run }) => {
    failOn('NoSuchCommand', undefined, answers);
    const failure = await thrown(run(MASK));
    expect(failure).toBeInstanceOf(ProvisioningError);
    expect((failure as ProvisioningError).physicalId).toBe(physicalId);
    expect(failure.message).toContain(prefix);
    expect(failure.message).not.toContain(CALLER_ACCOUNT);
    expect(failure.message).not.toContain(CALLER_SESSION);
    expect(hasRedactedCause(failure)).toBe(true);
    // The classifiers still read AWS's reason on the cause chain.
    expect((failure.cause as Error).message).toBe(cause);
    expect(retryClassificationText(failure)).toContain(CALLER_ARN);
    // AWS's text reaches the debug log, through the operation's masker.
    expect(debugged()).toContain(`role ${CALLER_ARN} cannot read ***`);
    expect(debugged()).not.toContain(SECRET);
  });

  it('a revision that fails with no reason keeps the fallback, unstamped, and its survivor marks', async () => {
    failOn('DeleteWebFunctionRevisionCommand', accessDenied('AccessDeniedException', 'lambda:DeleteWebFunctionRevision'), {
      CreateWebFunctionRevisionCommand: { revisionArn: REV_ARN, revisionId: 'rev-abc12' },
      GetWebFunctionRevisionCommand: { state: 'Failed' },
    });
    const failure = await thrown(new LambdaWebFunctionRevisionProvider().create('Res', REV, REV_PROPS));
    expect(failure.message).toBe('Lambda web function revision Res entered Failed: no reason given');
    expect(hasRedactedCause(failure)).toBe(false);
    expect(createdBeforeFailure(failure, 'Res', REV)).toBe(REV_ARN);
    expect(isMarkedNonRetryable(failure)).toBe(true);
  });

  it.each([
    {
      label: 'the code comes from the first build error that has one',
      revision: { state: 'Failed', stateReason: 'build failed', errors: [{ errorMessage: 'x' }, { errorCode: 'E2' }] },
      message: `Lambda web function revision Res entered Failed: E2. ${VERBOSE_POINTER}`,
      cause: 'build failed (x; E2)',
    },
    {
      label: 'no build error code leaves the pointer alone',
      revision: { state: 'Failed', stateReason: 'build failed', errors: [{ errorMessage: 'x' }] },
      message: `Lambda web function revision Res entered Failed: ${VERBOSE_POINTER}`,
      cause: 'build failed (x)',
    },
    {
      label: 'build errors with no state reason',
      revision: { state: 'Failed', errors: [{ errorCode: 'E1', errorMessage: 'bad zip' }] },
      message: `Lambda web function revision Res entered Failed: E1. ${VERBOSE_POINTER}`,
      cause: 'no reason given (E1 bad zip)',
    },
    {
      label: 'an empty state reason with build errors',
      revision: { state: 'Failed', stateReason: '', errors: [{ errorCode: 'E1', errorMessage: 'bad zip' }] },
      message: `Lambda web function revision Res entered Failed: E1. ${VERBOSE_POINTER}`,
      cause: 'no reason given (E1 bad zip)',
    },
  ])('revision errors[]: $label', async ({ revision, message, cause }) => {
    failOn('NoSuchCommand', undefined, {
      CreateWebFunctionRevisionCommand: { revisionArn: REV_ARN, revisionId: 'rev-abc12' },
      GetWebFunctionRevisionCommand: revision,
    });
    const failure = await thrown(new LambdaWebFunctionRevisionProvider().create('Res', REV, REV_PROPS));
    expect(failure.message).toBe(message);
    expect(hasRedactedCause(failure)).toBe(true);
    expect((failure.cause as Error).message).toBe(cause);
  });

  it('a revision whose only build error is empty keeps the unredacted fallback', async () => {
    failOn('NoSuchCommand', undefined, {
      CreateWebFunctionRevisionCommand: { revisionArn: REV_ARN, revisionId: 'rev-abc12' },
      GetWebFunctionRevisionCommand: { state: 'Failed', errors: [{}] },
    });
    const failure = await thrown(new LambdaWebFunctionRevisionProvider().create('Res', REV, REV_PROPS));
    expect(failure.message).toBe('Lambda web function revision Res entered Failed: no reason given');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each([
    {
      label: 'create, entered Failed',
      message: 'Lambda web function endpoint Res entered Failed: no reason given',
      answers: {
        CreateWebFunctionEndpointCommand: { endpointArn: EP_ARN },
        GetWebFunctionEndpointCommand: { state: 'Failed' },
      },
      run: () => new LambdaWebFunctionEndpointProvider().create('Res', EP, EP_PROPS),
    },
    {
      label: 'update, update failed',
      message: 'Lambda web function endpoint Res update failed: no reason given',
      answers: {
        UpdateWebFunctionEndpointCommand: {},
        GetWebFunctionEndpointCommand: { state: 'Active', updateStatus: 'Failed' },
      },
      run: () => new LambdaWebFunctionEndpointProvider().update('Res', EP_ARN, EP, EP_PROPS, EP_PROPS),
    },
  ])('an endpoint $label with no reason keeps the fallback, unstamped', async ({ message, answers, run }) => {
    failOn('NoSuchCommand', undefined, answers);
    const failure = await thrown(run());
    expect(failure.message).toBe(message);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a status reason with no masker threaded still stays out of the message', async () => {
    failOn('NoSuchCommand', undefined, {
      CreateWebFunctionEndpointCommand: { endpointArn: EP_ARN },
      GetWebFunctionEndpointCommand: { state: 'Failed', stateReason: REASON },
    });
    const failure = await thrown(new LambdaWebFunctionEndpointProvider().create('Res', EP, EP_PROPS));
    expect(failure.message).toContain(`entered Failed: ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(CALLER_ACCOUNT);
    // Absent means identity: the debug line carries AWS's text as is.
    expect(debugged()).toContain(REASON);
  });
});
