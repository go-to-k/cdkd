/**
 * Issue #2177 — the API Gateway (v1) family's masked log sinks.
 *
 * `ApiGatewayProvider.create()` / `update()` now build ONE masked sink set per
 * operation from the context's masker and route every log line, and the AWS
 * error text a failure message wraps, through it. A Stage's physical id IS its
 * `StageName`, so the Stage sinks also mask a name whose source value is
 * secret-derived (`withDerivedNameMasks`), including a name recorded from a
 * PREVIOUS secret whose plaintext is in no bag of this deploy.
 *
 * Cases assert over the WHOLE transcript (every debug and warn line), not one
 * known line. The secrets are sized for the arm each case must isolate:
 *
 *  - `LONG`, which the message-level mask catches: it fences the AWS-echo sites
 *    (a thrown failure, a cleanup warning, a replacement's orphan reason), where
 *    only routing through the masker removes it;
 *  - `TINY_A` / `TINY_B`, two characters, below the masker's substring floor and
 *    in no fixed wording, so on a cdkd line only the RAW value mask
 *    `log.value(...)` can remove them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

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
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

/** Long enough for the message-level substring arm. */
const LONG = 'apigw-secret-stage-value';
/** Two-character secrets in no fixed wording: only a RAW value mask removes them. */
const TINY_A = 'qx';
const TINY_B = 'jv';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(LONG, TINY_A, TINY_B));

/** An AWS-authored failure (the marker fields `describeAwsFailure` keys on). */
const awsAuthored = (name: string, message: string, statusCode = 400): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: statusCode >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: statusCode, requestId: 'req-0123456789' },
  });

const echo = (value = LONG): Error =>
  awsAuthored('BadRequestException', `Invalid value '${value}' for the request`);
/** The same text with only the secret masked: the diagnosis must survive the mask. */
const MASKED_ECHO = `Invalid value '${SECRET_MASK}' for the request`;

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every debug and warn line the provider wrote, joined. */
const transcript = (): string =>
  [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((args) => String(args[0])).join('\n');

type Handler = (input: Record<string, unknown>) => unknown;

/** A fake API Gateway answering by command name; an absent handler answers `{}`. */
function fakeApiGateway(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const handler = handlers[commandName(command)];
    return handler ? handler(command.input) : {};
  });
}

const throwing =
  (error: Error): Handler =>
  () => {
    throw error;
  };

async function thrownMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the operation to throw');
}

describe('ApiGatewayProvider masked log sinks (issue #2177)', () => {
  let provider: ApiGatewayProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    provider = new ApiGatewayProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('bag values interpolated into cdkd lines are masked RAW', () => {
    it('update() Resource: both PathPart values of a replacement', async () => {
      fakeApiGateway({ CreateResourceCommand: () => ({ id: 'res-new' }) });
      await provider.update(
        'Res',
        'res-old',
        'AWS::ApiGateway::Resource',
        { RestApiId: 'api-1', ParentId: 'root-1', PathPart: TINY_B },
        { RestApiId: 'api-1', ParentId: 'root-1', PathPart: TINY_A },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `PathPart changed from "${SECRET_MASK}" to "${SECRET_MASK}", replacing resource`
      );
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('update() Resource: an ordinary PathPart renders unchanged (negative control)', async () => {
      fakeApiGateway({ CreateResourceCommand: () => ({ id: 'res-new' }) });
      await provider.update(
        'Res',
        'res-old',
        'AWS::ApiGateway::Resource',
        { RestApiId: 'api-1', ParentId: 'root-1', PathPart: 'users' },
        { RestApiId: 'api-1', ParentId: 'root-1', PathPart: 'orders' },
        { maskSecrets }
      );
      expect(transcript()).toContain('PathPart changed from "orders" to "users"');
    });

    it('create() Stage: the stage name on the success line', async () => {
      fakeApiGateway({});
      const result = await provider.create(
        'Stg',
        'AWS::ApiGateway::Stage',
        { RestApiId: 'api-1', StageName: TINY_A, DeploymentId: 'dep-1' },
        { maskSecrets }
      );
      expect(result.physicalId).toBe(TINY_A);
      const lines = transcript();
      expect(lines).toContain(`Successfully created API Gateway Stage Stg: ${SECRET_MASK}`);
      expect(lines).not.toContain(TINY_A);
    });

    it('create() Method: the three ids on the success line', async () => {
      fakeApiGateway({});
      await provider.create(
        'Mth',
        'AWS::ApiGateway::Method',
        { RestApiId: TINY_A, ResourceId: TINY_B, HttpMethod: 'GET' },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Successfully created API Gateway Method Mth: ${SECRET_MASK}|${SECRET_MASK}|GET`
      );
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('update() Method: the recorded ids on the updating line', async () => {
      fakeApiGateway({});
      await provider.update(
        'Mth',
        `${TINY_A}|${TINY_B}|GET`,
        'AWS::ApiGateway::Method',
        { ApiKeyRequired: true },
        { ApiKeyRequired: false },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Updating API Gateway Method Mth: ${SECRET_MASK}|${SECRET_MASK}|GET`
      );
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('update() Method: a malformed recorded id is masked per part in the refusal', async () => {
      const message = await thrownMessage(
        provider.update(
          'Mth',
          `api-1|${TINY_A}`,
          'AWS::ApiGateway::Method',
          { ApiKeyRequired: true },
          { ApiKeyRequired: false },
          { maskSecrets }
        )
      );
      expect(message).toContain('Invalid physicalId format for API Gateway Method');
      expect(message).not.toContain(TINY_A);
      expect(transcript()).not.toContain(TINY_A);
    });

    it('no context: lines print unmasked (back-compat, absent means identity)', async () => {
      fakeApiGateway({});
      await provider.create('Stg', 'AWS::ApiGateway::Stage', {
        RestApiId: 'api-1',
        StageName: TINY_A,
        DeploymentId: 'dep-1',
      });
      expect(transcript()).toContain(`Successfully created API Gateway Stage Stg: ${TINY_A}`);
    });
  });

  describe('AWS text quoting a request value back', () => {
    const cases: Array<{
      label: string;
      prefix: string;
      failingCommand: string;
      run: (p: ApiGatewayProvider) => Promise<unknown>;
    }> = [
      {
        label: 'create() Account',
        prefix: 'Failed to create API Gateway Account Acct:',
        failingCommand: 'UpdateAccountCommand',
        run: (p) =>
          p.create('Acct', 'AWS::ApiGateway::Account', { CloudWatchRoleArn: LONG }, { maskSecrets }),
      },
      {
        label: 'update() Account',
        prefix: 'Failed to update API Gateway Account Acct:',
        failingCommand: 'UpdateAccountCommand',
        run: (p) =>
          p.update(
            'Acct',
            'ApiGatewayAccount',
            'AWS::ApiGateway::Account',
            { CloudWatchRoleArn: LONG },
            {},
            { maskSecrets }
          ),
      },
      {
        label: 'create() Authorizer',
        prefix: 'Failed to create API Gateway Authorizer Auth:',
        failingCommand: 'CreateAuthorizerCommand',
        run: (p) =>
          p.create(
            'Auth',
            'AWS::ApiGateway::Authorizer',
            { RestApiId: 'api-1', Name: 'auth', Type: 'TOKEN', AuthorizerUri: LONG },
            { maskSecrets }
          ),
      },
      {
        label: 'update() Authorizer',
        prefix: 'Failed to update API Gateway Authorizer Auth:',
        failingCommand: 'UpdateAuthorizerCommand',
        run: (p) =>
          p.update(
            'Auth',
            'auth-1',
            'AWS::ApiGateway::Authorizer',
            { RestApiId: 'api-1', AuthorizerUri: LONG },
            { RestApiId: 'api-1', AuthorizerUri: 'old' },
            { maskSecrets }
          ),
      },
      {
        label: 'create() Resource',
        prefix: 'Failed to create API Gateway Resource Res:',
        failingCommand: 'CreateResourceCommand',
        run: (p) =>
          p.create(
            'Res',
            'AWS::ApiGateway::Resource',
            { RestApiId: 'api-1', ParentId: 'root-1', PathPart: LONG },
            { maskSecrets }
          ),
      },
      {
        label: 'create() Deployment',
        prefix: 'Failed to create API Gateway Deployment Dep:',
        failingCommand: 'CreateDeploymentCommand',
        run: (p) =>
          p.create(
            'Dep',
            'AWS::ApiGateway::Deployment',
            { RestApiId: 'api-1', Description: LONG },
            { maskSecrets }
          ),
      },
      {
        label: 'create() Stage',
        prefix: 'Failed to create API Gateway Stage Stg:',
        failingCommand: 'CreateStageCommand',
        run: (p) =>
          p.create(
            'Stg',
            'AWS::ApiGateway::Stage',
            { RestApiId: 'api-1', StageName: LONG, DeploymentId: 'dep-1' },
            { maskSecrets }
          ),
      },
      {
        label: 'update() Stage',
        prefix: 'Failed to update API Gateway Stage Stg:',
        failingCommand: 'UpdateStageCommand',
        run: (p) =>
          p.update(
            'Stg',
            'prod',
            'AWS::ApiGateway::Stage',
            { RestApiId: 'api-1', StageName: 'prod', Description: LONG },
            { RestApiId: 'api-1', StageName: 'prod' },
            { maskSecrets }
          ),
      },
      {
        label: 'create() Method',
        prefix: 'Failed to create API Gateway Method Mth:',
        failingCommand: 'PutMethodCommand',
        run: (p) =>
          p.create(
            'Mth',
            'AWS::ApiGateway::Method',
            { RestApiId: 'api-1', ResourceId: 'res-1', HttpMethod: 'GET', OperationName: LONG },
            { maskSecrets }
          ),
      },
      {
        label: 'update() Method',
        prefix: 'Failed to update API Gateway Method Mth:',
        failingCommand: 'UpdateMethodCommand',
        run: (p) =>
          p.update(
            'Mth',
            'api-1|res-1|GET',
            'AWS::ApiGateway::Method',
            { OperationName: LONG },
            {},
            { maskSecrets }
          ),
      },
    ];

    for (const c of cases) {
      it(`${c.label} failure message`, async () => {
        fakeApiGateway({ [c.failingCommand]: throwing(echo()) });
        const message = await thrownMessage(c.run(provider));
        expect(message).toContain(c.prefix);
        expect(message).not.toContain(LONG);
        expect(message).toContain(MASKED_ECHO);
      });
    }

    it('create() Stage: the post-create cleanup warning', async () => {
      fakeApiGateway({
        UpdateStageCommand: throwing(awsAuthored('BadRequestException', 'bad certificate')),
        DeleteStageCommand: throwing(echo()),
      });
      const message = await thrownMessage(
        provider.create(
          'Stg',
          'AWS::ApiGateway::Stage',
          {
            RestApiId: 'api-1',
            StageName: TINY_A,
            DeploymentId: 'dep-1',
            ClientCertificateId: 'cert-1',
          },
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to create API Gateway Stage Stg:');
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(
        `Failed to clean up stage ${SECRET_MASK} after a post-create patch failure:`
      );
      expect(warned).toContain(MASKED_ECHO);
      expect(warned).not.toContain(LONG);
      expect(warned).not.toContain(TINY_A);
    });

    it('create() Method: the partial-create cleanup warning and its pasteable command', async () => {
      fakeApiGateway({
        PutIntegrationCommand: throwing(awsAuthored('BadRequestException', 'bad integration')),
        DeleteMethodCommand: throwing(echo()),
      });
      await thrownMessage(
        provider.create(
          'Mth',
          'AWS::ApiGateway::Method',
          {
            RestApiId: TINY_A,
            ResourceId: TINY_B,
            HttpMethod: 'GET',
            Integration: { Type: 'MOCK' },
          },
          { maskSecrets }
        )
      );
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(
        `Failed to clean up partially-created API Gateway Method Mth (${SECRET_MASK}/${SECRET_MASK}/GET):`
      );
      expect(warned).toContain(MASKED_ECHO);
      expect(warned).not.toContain(LONG);
      expect(warned).not.toContain(TINY_A);
      expect(warned).not.toContain(TINY_B);
    });

    it('update() Resource: a replacement whose old delete fails masks the warning and the reason', async () => {
      fakeApiGateway({
        CreateResourceCommand: () => ({ id: 'res-new' }),
        DeleteResourceCommand: throwing(echo()),
      });
      const result = await provider.update(
        'Res',
        'res-old',
        'AWS::ApiGateway::Resource',
        { RestApiId: 'api-1', ParentId: 'root-1', PathPart: 'users' },
        { RestApiId: 'api-1', ParentId: 'root-1', PathPart: 'orders' },
        { maskSecrets }
      );
      expect(result).toMatchObject({ outcome: 'partial', physicalId: 'res-new' });
      const reason = (result as { reason?: string }).reason ?? '';
      expect(reason).toContain('old API Gateway Resource res-old could not be deleted:');
      expect(reason).not.toContain(LONG);
      expect(reason).toContain(SECRET_MASK);
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain('Failed to delete old API Gateway Resource res-old');
      expect(warned).not.toContain(LONG);
    });

    it('update() Account: the IAM propagation retry warning goes through the masked sink', async () => {
      vi.useFakeTimers();
      let calls = 0;
      fakeApiGateway({
        UpdateAccountCommand: () => {
          calls++;
          if (calls === 1) throw awsAuthored('BadRequestException', 'not authorized');
          return {};
        },
      });
      const masker = vi.fn((text: string) => text.replaceAll('Acct', SECRET_MASK));
      const done = provider.update(
        'Acct',
        'ApiGatewayAccount',
        'AWS::ApiGateway::Account',
        { CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/r' },
        {},
        { maskSecrets: masker }
      );
      await vi.runAllTimersAsync();
      await done;
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(`IAM propagation delay for ${SECRET_MASK} (attempt 1/`);
    });
  });

  describe('a Stage name derived from a secret', () => {
    // A rotated or re-pointed secret: state recorded the PREVIOUS StageName as
    // its reference, so the redacted diff sees no StageName change and routes
    // the deploy to update(). The desired bag holds the NEW plaintext (`LONG`,
    // in this deploy's bag); the physical id is the OLD plaintext, which is in
    // no bag of this deploy, so the base masker alone cannot recognise it.
    const OLD_NAME = 'old-secret-stage-name';
    const previous = {
      RestApiId: 'api-1',
      StageName: '{{resolve:secretsmanager:stage-name}}',
      Tags: [],
    };
    const desired = { RestApiId: 'api-1', StageName: LONG };

    it('update(): the recorded name is masked on every line and in the ARN', async () => {
      fakeApiGateway({});
      await provider.update(
        'Stg',
        OLD_NAME,
        'AWS::ApiGateway::Stage',
        { ...desired, Tags: [{ Key: 'team', Value: 'core' }] },
        previous,
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updating API Gateway Stage Stg: ${SECRET_MASK}`);
      expect(lines).toContain(`/restapis/api-1/stages/${SECRET_MASK}`);
      expect(lines).not.toContain(OLD_NAME);
    });

    it('update(): an AWS echo of the recorded name is masked in the failure message', async () => {
      fakeApiGateway({ UpdateStageCommand: throwing(echo(OLD_NAME)) });
      const message = await thrownMessage(
        provider.update(
          'Stg',
          OLD_NAME,
          'AWS::ApiGateway::Stage',
          { ...desired, Description: 'changed' },
          previous,
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to update API Gateway Stage Stg:');
      expect(message).not.toContain(OLD_NAME);
      expect(message).toContain(MASKED_ECHO);
    });

    it('update(): a recorded *** previous name counts as secret-derived too (backstop)', async () => {
      // The desired name is outside this operation's masker, so only the
      // previous side's `***` marks the recorded name secret-derived.
      fakeApiGateway({});
      await provider.update(
        'Stg',
        OLD_NAME,
        'AWS::ApiGateway::Stage',
        { RestApiId: 'api-1', StageName: OLD_NAME, Description: 'changed' },
        { RestApiId: 'api-1', StageName: SECRET_MASK },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updating API Gateway Stage Stg: ${SECRET_MASK}`);
      expect(lines).not.toContain(OLD_NAME);
    });

    it('create(): a short secret name AWS echoes back is masked', async () => {
      // Below the base masker's substring floor, so only the derived-name mask
      // the create builds from the desired StageName catches the echo.
      fakeApiGateway({
        CreateStageCommand: throwing(
          awsAuthored('ConflictException', `Stage already exist: ${TINY_A}`, 409)
        ),
      });
      const message = await thrownMessage(
        provider.create(
          'Stg',
          'AWS::ApiGateway::Stage',
          { RestApiId: 'api-1', StageName: TINY_A, DeploymentId: 'dep-1' },
          { maskSecrets }
        )
      );
      expect(message).toContain(`Stage already exist: ${SECRET_MASK}`);
      expect(message).not.toContain(TINY_A);
    });

    it('update() backstop: only the previous reference names the secret', async () => {
      // A caller whose masker does not know the desired name (none of the
      // threaded callers is known to produce this shape today) while state
      // recorded the name as a reference: only the previous side marks it
      // secret-derived. The pair can only over-mask.
      fakeApiGateway({ UpdateStageCommand: throwing(echo(OLD_NAME)) });
      const message = await thrownMessage(
        provider.update(
          'Stg',
          OLD_NAME,
          'AWS::ApiGateway::Stage',
          { RestApiId: 'api-1', StageName: OLD_NAME, Description: 'changed' },
          previous,
          { maskSecrets }
        )
      );
      expect(message).toContain(MASKED_ECHO);
      expect(message).not.toContain(OLD_NAME);
      expect(transcript()).toContain(`Updating API Gateway Stage Stg: ${SECRET_MASK}`);
      expect(transcript()).not.toContain(OLD_NAME);
    });

    it('update(): a short secret name AWS echoes back is masked through the desired side', async () => {
      // No rotation: the desired name is this deploy's (two-character) secret
      // and equals the physical id. The base masker's substring arm skips a
      // needle that short, so only the derived-name mask catches the echo.
      fakeApiGateway({
        UpdateStageCommand: throwing(
          awsAuthored('NotFoundException', `Invalid stage identifier specified: ${TINY_A}`, 404)
        ),
      });
      const message = await thrownMessage(
        provider.update(
          'Stg',
          TINY_A,
          'AWS::ApiGateway::Stage',
          { RestApiId: 'api-1', StageName: TINY_A, Description: 'changed' },
          // No recorded StageName, so only the desired side can name it.
          { RestApiId: 'api-1' },
          { maskSecrets }
        )
      );
      expect(message).toContain(`Invalid stage identifier specified: ${SECRET_MASK}`);
      expect(message).not.toContain(TINY_A);
    });

    it('update(): an ordinary recorded name renders unchanged (negative control)', async () => {
      fakeApiGateway({});
      await provider.update(
        'Stg',
        'prod',
        'AWS::ApiGateway::Stage',
        { RestApiId: 'api-1', StageName: 'prod', Tags: [{ Key: 'team', Value: 'core' }] },
        { RestApiId: 'api-1', StageName: 'prod', Tags: [] },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain('Updating API Gateway Stage Stg: prod');
      expect(lines).toContain('/restapis/api-1/stages/prod');
    });

    it('update(): a short secret RestApiId is masked RAW in the tag lines ARN', async () => {
      // Below the base masker's substring floor, so only the display ARN's
      // raw-masked segment keeps it out; the raw ARN still goes to AWS.
      fakeApiGateway({});
      await provider.update(
        'Stg',
        'prod',
        'AWS::ApiGateway::Stage',
        { RestApiId: TINY_A, StageName: 'prod', Tags: [{ Key: 'team', Value: 'core' }] },
        { RestApiId: TINY_A, StageName: 'prod', Tags: [{ Key: 'old', Value: 'gone' }] },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Added/updated 1 tag(s) on API Gateway resource arn:aws:apigateway:us-east-1::/restapis/${SECRET_MASK}/stages/prod`);
      expect(lines).not.toContain(TINY_A);
      const sent = mockSend.mock.calls
        .map(([c]) => c as { input: Record<string, unknown> })
        .filter((c) => commandName(c) === 'TagResourceCommand');
      expect(sent[0]?.input['resourceArn']).toBe(
        `arn:aws:apigateway:us-east-1::/restapis/${TINY_A}/stages/prod`
      );
    });
  });

  describe('a masked failure still classifies as retryable (issue #4259)', () => {
    /** A secret that spells part of the retry table's `does not exist` wording. */
    const RETRY_WORD = 'exist';
    const retryMasker = createSecretMasker(bagOf(RETRY_WORD));
    const TRANSIENT = 'Invalid deployment identifier specified: dep-1 does not exist';
    const retryable = (error: Error): boolean =>
      isRetryableTransientError(error, retryClassificationText(error));

    async function thrown(promise: Promise<unknown>): Promise<Error> {
      try {
        await promise;
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected the operation to throw');
    }

    type Masker = typeof retryMasker;
    const SITES = [
      {
        site: 'create() Account',
        command: 'UpdateAccountCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.create('Acct', 'AWS::ApiGateway::Account', { CloudWatchRoleArn: 'arn:r' }, { maskSecrets: m }),
      },
      {
        site: 'update() Account',
        command: 'UpdateAccountCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.update(
            'Acct',
            'ApiGatewayAccount',
            'AWS::ApiGateway::Account',
            { CloudWatchRoleArn: 'arn:r' },
            {},
            { maskSecrets: m }
          ),
      },
      {
        site: 'create() Authorizer',
        command: 'CreateAuthorizerCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.create(
            'Auth',
            'AWS::ApiGateway::Authorizer',
            { RestApiId: 'api-1', Name: 'auth', Type: 'TOKEN', AuthorizerUri: 'uri' },
            { maskSecrets: m }
          ),
      },
      {
        site: 'update() Authorizer',
        command: 'UpdateAuthorizerCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.update(
            'Auth',
            'auth-1',
            'AWS::ApiGateway::Authorizer',
            { RestApiId: 'api-1', AuthorizerUri: 'new' },
            { RestApiId: 'api-1', AuthorizerUri: 'old' },
            { maskSecrets: m }
          ),
      },
      {
        site: 'create() Resource',
        command: 'CreateResourceCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.create(
            'Res',
            'AWS::ApiGateway::Resource',
            { RestApiId: 'api-1', ParentId: 'root-1', PathPart: 'users' },
            { maskSecrets: m }
          ),
      },
      {
        site: 'create() Deployment',
        command: 'CreateDeploymentCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.create('Dep', 'AWS::ApiGateway::Deployment', { RestApiId: 'api-1' }, { maskSecrets: m }),
      },
      {
        site: 'create() Stage',
        command: 'CreateStageCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.create(
            'Stg',
            'AWS::ApiGateway::Stage',
            { RestApiId: 'api-1', StageName: 'prod', DeploymentId: 'dep-1' },
            { maskSecrets: m }
          ),
      },
      {
        site: 'update() Stage',
        command: 'UpdateStageCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.update(
            'Stg',
            'prod',
            'AWS::ApiGateway::Stage',
            { RestApiId: 'api-1', StageName: 'prod', Description: 'new' },
            { RestApiId: 'api-1', StageName: 'prod' },
            { maskSecrets: m }
          ),
      },
      {
        site: 'create() Method',
        command: 'PutMethodCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.create(
            'Mth',
            'AWS::ApiGateway::Method',
            { RestApiId: 'api-1', ResourceId: 'res-1', HttpMethod: 'GET' },
            { maskSecrets: m }
          ),
      },
      {
        site: 'update() Method',
        command: 'UpdateMethodCommand',
        run: (p: ApiGatewayProvider, m: Masker) =>
          p.update(
            'Mth',
            'api-1|res-1|GET',
            'AWS::ApiGateway::Method',
            { OperationName: 'op' },
            {},
            { maskSecrets: m }
          ),
      },
    ] as const;

    it.each(SITES)('$site: the stamp keeps it retryable', async ({ command, run }) => {
      fakeApiGateway({ [command]: throwing(awsAuthored('BadRequestException', TRANSIENT)) });
      const failure = await thrown(run(provider, retryMasker));
      // Non-vacuity: the rejection came from the site's own command.
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      // Premise: the mask cut the retry wording out of the message itself.
      expect(failure.message).not.toContain('does not exist');
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryable(failure)).toBe(true);
    });

    it.each(SITES)(
      '$site: a failure the mask left unchanged is not stamped',
      async ({ command, run }) => {
        fakeApiGateway({
          [command]: throwing(awsAuthored('BadRequestException', 'Bad request parameter')),
        });
        const failure = await thrown(run(provider, retryMasker));
        expect(failure.message).toContain('Bad request parameter');
        expect(hasRedactedCause(failure)).toBe(false);
        expect(retryable(failure)).toBe(false);
      }
    );

    it('create() Stage: a 3-character secret StageName cut by the derived-name mask is stamped too', async () => {
      // Below the substring floor, so only the Stage's derived-name mask (no
      // floor) reaches AWS's sentence, and it cuts `exist` to `***st`.
      const NAME = 'exi';
      fakeApiGateway({
        CreateStageCommand: throwing(awsAuthored('BadRequestException', TRANSIENT)),
      });
      const failure = await thrown(
        provider.create(
          'Stg',
          'AWS::ApiGateway::Stage',
          { RestApiId: 'api-1', StageName: NAME, DeploymentId: 'dep-1' },
          { maskSecrets: createSecretMasker(bagOf(NAME)) }
        )
      );
      expect(failure.message).toContain(`does not ${SECRET_MASK}st`);
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryable(failure)).toBe(true);
    });

    it('update() Stage: a 3-character recorded name from a PREVIOUS secret is stamped too', async () => {
      // The recorded name is in no bag of this deploy; only the previous
      // side's `{{resolve:` reference marks it secret-derived, so only the
      // Stage's derived-name mask cuts `exist` to `***st`.
      const OLD = 'exi';
      fakeApiGateway({
        UpdateStageCommand: throwing(awsAuthored('BadRequestException', TRANSIENT)),
      });
      const failure = await thrown(
        provider.update(
          'Stg',
          OLD,
          'AWS::ApiGateway::Stage',
          { RestApiId: 'api-1', StageName: 'new-stage-name', Description: 'changed' },
          { RestApiId: 'api-1', StageName: '{{resolve:secretsmanager:stage-name}}' },
          { maskSecrets: createSecretMasker(bagOf('unrelated-secret-value')) }
        )
      );
      expect(failure.message).toContain(`does not ${SECRET_MASK}st`);
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryable(failure)).toBe(true);
    });
  });
});
