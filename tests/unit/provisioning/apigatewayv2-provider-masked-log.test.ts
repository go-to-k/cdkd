/**
 * Issue #2177 — the API Gateway V2 family's masked log sinks.
 *
 * `ApiGatewayV2Provider.create()` / `update()` now build ONE masked sink set
 * per operation from the context's masker and route every log line, and the
 * AWS error text a failure message wraps, through it. A Stage's physical id IS
 * its `StageName`, so the Stage sinks also mask a name whose source value is
 * secret-derived (`withDerivedNameMasks`), including a name recorded from a
 * PREVIOUS secret whose plaintext is in no bag of this deploy.
 *
 * Cases assert over the WHOLE transcript (every debug and warn line), not one
 * known line. The secrets are sized for the arm each case must isolate:
 *
 *  - `LONG`, which the message-level mask catches: it fences the AWS-echo sites
 *    (a thrown failure), where only routing through the masker removes it;
 *  - `TINY_A`, two characters, below the masker's substring floor and in no
 *    fixed wording, so on a cdkd line only the RAW value mask `log.value(...)`
 *    (or the derived-name needle) can remove it.
 *
 * The ResponseParameters warning is fenced by
 * `apigatewayv2-provider-masked-warn.test.ts` (issue #1997).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { AccountIdUnavailableError } from '../../../src/utils/error-handler.js';

const { mockSend, warnSpy, debugSpy, mockGetAccountInfo } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  mockGetAccountInfo: vi.fn(),
}));

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, getAccountInfo: (...args: unknown[]) => mockGetAccountInfo(...args) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn(), child: vi.fn() };
  child.child = vi.fn().mockReturnValue(child);
  return { getLogger: () => child };
});

import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

/** Long enough for the message-level substring arm. */
const LONG = 'apigwv2-secret-request-value';
/** A two-character secret in no fixed wording: only a RAW value mask removes it. */
const TINY_A = 'qx';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(LONG, TINY_A));

const echo = (value = LONG): Error => new Error(`Invalid value '${value}' for the request`);
/** The same text with only the secret masked: the diagnosis must survive the mask. */
const MASKED_ECHO = `Invalid value '${SECRET_MASK}' for the request`;

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every debug and warn line the provider wrote, joined. */
const transcript = (): string =>
  [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((args) => String(args[0])).join('\n');

type Handler = (input: Record<string, unknown>) => unknown;

/** A fake API Gateway V2 answering by command name; an absent handler answers `{}`. */
function fakeApiGatewayV2(handlers: Record<string, Handler>): void {
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

const API_CREATED: Handler = () => ({ ApiId: 'abc123', ApiEndpoint: 'https://abc123.example' });

/**
 * Every `create()` / `update()` failure wrap, each driven through the command
 * that fails it, with the masker as a parameter.
 */
const FAILURE_SITES: Array<{
    label: string;
    prefix: string;
    failingCommand: string;
    run: (p: ApiGatewayV2Provider, m: (text: string) => string) => Promise<unknown>;
  }> = [
    {
      label: 'create() Api',
      prefix: 'Failed to create API Gateway V2 Api Api:',
      failingCommand: 'CreateApiCommand',
      run: (p, m) =>
        p.create(
          'Api',
          'AWS::ApiGatewayV2::Api',
          { Name: LONG, ProtocolType: 'HTTP' },
          { maskSecrets: m }
        ),
    },
    {
      label: 'create() Stage',
      prefix: 'Failed to create API Gateway V2 Stage Stg:',
      failingCommand: 'CreateStageCommand',
      run: (p, m) =>
        p.create(
          'Stg',
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1', StageName: 'prod', Description: LONG },
          { maskSecrets: m }
        ),
    },
    {
      label: 'create() Integration',
      prefix: 'Failed to create API Gateway V2 Integration Int:',
      failingCommand: 'CreateIntegrationCommand',
      run: (p, m) =>
        p.create(
          'Int',
          'AWS::ApiGatewayV2::Integration',
          { ApiId: 'api-1', IntegrationType: 'HTTP_PROXY', IntegrationUri: LONG },
          { maskSecrets: m }
        ),
    },
    {
      label: 'create() Route',
      prefix: 'Failed to create API Gateway V2 Route Rt:',
      failingCommand: 'CreateRouteCommand',
      run: (p, m) =>
        p.create(
          'Rt',
          'AWS::ApiGatewayV2::Route',
          { ApiId: 'api-1', RouteKey: 'GET /', Target: LONG },
          { maskSecrets: m }
        ),
    },
    {
      label: 'create() Authorizer',
      prefix: 'Failed to create API Gateway V2 Authorizer Auth:',
      failingCommand: 'CreateAuthorizerCommand',
      run: (p, m) =>
        p.create(
          'Auth',
          'AWS::ApiGatewayV2::Authorizer',
          { ApiId: 'api-1', AuthorizerType: 'REQUEST', AuthorizerUri: LONG },
          { maskSecrets: m }
        ),
    },
    {
      label: 'update() Api',
      prefix: 'Failed to update API Gateway V2 Api Api:',
      failingCommand: 'UpdateApiCommand',
      run: (p, m) =>
        p.update(
          'Api',
          'abc123',
          'AWS::ApiGatewayV2::Api',
          { Name: LONG },
          { Name: 'n' },
          { maskSecrets: m }
        ),
    },
    {
      label: 'update() Stage',
      prefix: 'Failed to update API Gateway V2 Stage Stg:',
      failingCommand: 'UpdateStageCommand',
      run: (p, m) =>
        p.update(
          'Stg',
          'prod',
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1', Description: LONG },
          { ApiId: 'api-1' },
          { maskSecrets: m }
        ),
    },
    {
      label: 'update() Stage, removal-only arm',
      prefix: 'Failed to update API Gateway V2 Stage Stg:',
      failingCommand: 'DeleteAccessLogSettingsCommand',
      run: (p, m) =>
        p.update(
          'Stg',
          'prod',
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1' },
          { ApiId: 'api-1', AccessLogSettings: { DestinationArn: 'arn', Format: '$context' } },
          { maskSecrets: m }
        ),
    },
    {
      label: 'update() Integration',
      prefix: 'Failed to update API Gateway V2 Integration Int:',
      failingCommand: 'UpdateIntegrationCommand',
      run: (p, m) =>
        p.update(
          'Int',
          'int-1',
          'AWS::ApiGatewayV2::Integration',
          { ApiId: 'api-1', IntegrationUri: LONG },
          { ApiId: 'api-1', IntegrationUri: 'old' },
          { maskSecrets: m }
        ),
    },
    {
      label: 'update() Route',
      prefix: 'Failed to update API Gateway V2 Route Rt:',
      failingCommand: 'UpdateRouteCommand',
      run: (p, m) =>
        p.update(
          'Rt',
          'route-1',
          'AWS::ApiGatewayV2::Route',
          { ApiId: 'api-1', Target: LONG },
          { ApiId: 'api-1', Target: 'old' },
          { maskSecrets: m }
        ),
    },
    {
      label: 'update() Route, removal-only arm',
      prefix: 'Failed to update API Gateway V2 Route Rt:',
      failingCommand: 'DeleteRouteRequestParameterCommand',
      run: (p, m) =>
        p.update(
          'Rt',
          'route-1',
          'AWS::ApiGatewayV2::Route',
          { ApiId: 'api-1' },
          { ApiId: 'api-1', RequestParameters: { 'route.request.header.x': { Required: true } } },
          { maskSecrets: m }
        ),
    },
    {
      label: 'update() Authorizer',
      prefix: 'Failed to update API Gateway V2 Authorizer Auth:',
      failingCommand: 'UpdateAuthorizerCommand',
      run: (p, m) =>
        p.update(
          'Auth',
          'auth-1',
          'AWS::ApiGatewayV2::Authorizer',
          { ApiId: 'api-1', AuthorizerUri: LONG },
          { ApiId: 'api-1', AuthorizerUri: 'old' },
          { maskSecrets: m }
        ),
    },
  ];

describe('ApiGatewayV2Provider masked log sinks (issue #2177)', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    mockGetAccountInfo.mockReset();
    mockGetAccountInfo.mockResolvedValue({
      accountId: '111122223333',
      region: 'us-east-1',
      partition: 'aws',
    });
    provider = new ApiGatewayV2Provider();
  });

  describe('every create() / update() line routes through the operation masker', () => {
    // A masker that hides the LOGICAL ID: every line of these operations names
    // it, so a line written through the raw logger shows it. Each case also
    // asserts the transcript is non-empty, so a silent operation cannot pass.
    const LID = 'LogicalZed';
    const hideLid = (text: string): string => text.replaceAll(LID, SECRET_MASK);
    const ctx = { maskSecrets: hideLid };

    const cases: Array<{ label: string; run: (p: ApiGatewayV2Provider) => Promise<unknown> }> = [
      {
        label: 'create() Api',
        run: (p) => p.create(LID, 'AWS::ApiGatewayV2::Api', { Name: 'n', ProtocolType: 'HTTP' }, ctx),
      },
      {
        label: 'create() Stage',
        run: (p) =>
          p.create(LID, 'AWS::ApiGatewayV2::Stage', { ApiId: 'api-1', StageName: 'prod' }, ctx),
      },
      {
        label: 'create() Integration (with the TlsConfig warning)',
        run: (p) =>
          p.create(
            LID,
            'AWS::ApiGatewayV2::Integration',
            {
              ApiId: 'api-1',
              IntegrationType: 'HTTP_PROXY',
              TlsConfig: { ServerNameToVerify: 'example.com' },
            },
            ctx
          ),
      },
      {
        label: 'create() Route',
        run: (p) =>
          p.create(LID, 'AWS::ApiGatewayV2::Route', { ApiId: 'api-1', RouteKey: 'GET /' }, ctx),
      },
      {
        label: 'create() Authorizer',
        run: (p) =>
          p.create(
            LID,
            'AWS::ApiGatewayV2::Authorizer',
            { ApiId: 'api-1', AuthorizerType: 'JWT' },
            ctx
          ),
      },
      {
        label: 'update() Api (with CORS removal and the heal)',
        run: (p) =>
          p.update(
            LID,
            'abc123',
            'AWS::ApiGatewayV2::Api',
            { Name: 'n2' },
            { Name: 'n', CorsConfiguration: { AllowOrigins: ['*'] } },
            ctx
          ),
      },
      {
        label: 'update() Api (no change)',
        run: (p) => p.update(LID, 'abc123', 'AWS::ApiGatewayV2::Api', { Name: 'n' }, { Name: 'n' }, ctx),
      },
      {
        label: 'update() Stage',
        run: (p) =>
          p.update(
            LID,
            'prod',
            'AWS::ApiGatewayV2::Stage',
            { ApiId: 'api-1', Description: 'new' },
            { ApiId: 'api-1' },
            ctx
          ),
      },
      {
        label: 'update() Stage (no change)',
        run: (p) =>
          p.update(LID, 'prod', 'AWS::ApiGatewayV2::Stage', { ApiId: 'api-1' }, { ApiId: 'api-1' }, ctx),
      },
      {
        label: 'update() Integration (with the TlsConfig warning)',
        run: (p) =>
          p.update(
            LID,
            'int-1',
            'AWS::ApiGatewayV2::Integration',
            { ApiId: 'api-1', TlsConfig: { ServerNameToVerify: 'example.com' } },
            { ApiId: 'api-1' },
            ctx
          ),
      },
      {
        label: 'update() Integration (no change)',
        run: (p) =>
          p.update(
            LID,
            'int-1',
            'AWS::ApiGatewayV2::Integration',
            { ApiId: 'api-1' },
            { ApiId: 'api-1' },
            ctx
          ),
      },
      {
        label: 'update() Route',
        run: (p) =>
          p.update(
            LID,
            'route-1',
            'AWS::ApiGatewayV2::Route',
            { ApiId: 'api-1', RouteKey: 'GET /b' },
            { ApiId: 'api-1', RouteKey: 'GET /a' },
            ctx
          ),
      },
      {
        label: 'update() Route (no change)',
        run: (p) =>
          p.update(LID, 'route-1', 'AWS::ApiGatewayV2::Route', { ApiId: 'api-1' }, { ApiId: 'api-1' }, ctx),
      },
      {
        label: 'update() Authorizer',
        run: (p) =>
          p.update(
            LID,
            'auth-1',
            'AWS::ApiGatewayV2::Authorizer',
            { ApiId: 'api-1', Name: 'b' },
            { ApiId: 'api-1', Name: 'a' },
            ctx
          ),
      },
      {
        label: 'update() Authorizer (no change)',
        run: (p) =>
          p.update(LID, 'auth-1', 'AWS::ApiGatewayV2::Authorizer', { ApiId: 'api-1' }, { ApiId: 'api-1' }, ctx),
      },
    ];

    for (const c of cases) {
      it(c.label, async () => {
        fakeApiGatewayV2({
          CreateApiCommand: API_CREATED,
          UpdateApiCommand: API_CREATED,
          CreateIntegrationCommand: () => ({ IntegrationId: 'int-1' }),
          CreateRouteCommand: () => ({ RouteId: 'route-1' }),
          CreateAuthorizerCommand: () => ({ AuthorizerId: 'auth-1' }),
        });
        await c.run(provider);
        const lines = transcript();
        expect(lines).toContain(SECRET_MASK);
        expect(lines).not.toContain(LID);
      });
    }

    it('create() Api: the ExecuteApiArn decline warning goes through the masked sink', async () => {
      mockGetAccountInfo.mockRejectedValue(
        new AccountIdUnavailableError('Cannot determine the AWS account id: STS unreachable.')
      );
      fakeApiGatewayV2({ CreateApiCommand: API_CREATED });
      await provider.create(
        'Api',
        'AWS::ApiGatewayV2::Api',
        { Name: 'n', ProtocolType: 'HTTP' },
        { maskSecrets: (t) => t.replaceAll('abc123', SECRET_MASK) }
      );
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(`ExecuteApiArn attribute for API ${SECRET_MASK} is NOT recorded`);
      expect(warned).not.toContain('abc123');
    });

    it('create() Api: the ExecuteApiArn build-failure warning goes through the masked sink', async () => {
      mockGetAccountInfo.mockRejectedValue(new Error('no region'));
      fakeApiGatewayV2({ CreateApiCommand: API_CREATED });
      await provider.create(
        'Api',
        'AWS::ApiGatewayV2::Api',
        { Name: 'n', ProtocolType: 'HTTP' },
        { maskSecrets: (t) => t.replaceAll('abc123', SECRET_MASK) }
      );
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(`Could not build the ExecuteApiArn attribute for API ${SECRET_MASK}`);
      expect(warned).not.toContain('abc123');
    });

    it('update() Api: the skipped-heal line goes through the masked sink', async () => {
      mockGetAccountInfo.mockRejectedValue(
        new AccountIdUnavailableError('Cannot determine the AWS account id: STS unreachable.')
      );
      fakeApiGatewayV2({ UpdateApiCommand: API_CREATED });
      await provider.update(
        'Api',
        'abc123',
        'AWS::ApiGatewayV2::Api',
        { Name: 'n2' },
        { Name: 'n' },
        { maskSecrets: (t) => t.replaceAll('abc123', SECRET_MASK) }
      );
      const lines = transcript();
      expect(lines).toContain(`Skipping the ExecuteApiArn heal for API ${SECRET_MASK}`);
      expect(lines).not.toContain('abc123');
    });
  });

  describe('bag values interpolated into cdkd lines are masked RAW', () => {
    it('create() Stage: the stage name on the success line', async () => {
      fakeApiGatewayV2({});
      const result = await provider.create(
        'Stg',
        'AWS::ApiGatewayV2::Stage',
        { ApiId: 'api-1', StageName: TINY_A },
        { maskSecrets }
      );
      expect(result.physicalId).toBe(TINY_A);
      const lines = transcript();
      expect(lines).toContain(`Successfully created API Gateway V2 Stage Stg: ${SECRET_MASK}`);
      expect(lines).not.toContain(TINY_A);
    });

    it('update() Stage: the recorded stage name on the updating line', async () => {
      // No recorded StageName on the previous side and none on the desired,
      // so no derived-name needle: only the RAW `log.value` mask reaches it.
      fakeApiGatewayV2({});
      await provider.update(
        'Stg',
        TINY_A,
        'AWS::ApiGatewayV2::Stage',
        { ApiId: 'api-1', Description: 'new' },
        { ApiId: 'api-1' },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updating API Gateway V2 Stage Stg: ${SECRET_MASK}`);
      expect(lines).not.toContain(TINY_A);
    });

    it('an ordinary stage name renders unchanged (negative control)', async () => {
      fakeApiGatewayV2({});
      await provider.create(
        'Stg',
        'AWS::ApiGatewayV2::Stage',
        { ApiId: 'api-1', StageName: 'prod' },
        { maskSecrets }
      );
      await provider.update(
        'Stg',
        'prod',
        'AWS::ApiGatewayV2::Stage',
        { ApiId: 'api-1', StageName: 'prod', Description: 'new' },
        { ApiId: 'api-1', StageName: 'prod' },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain('Successfully created API Gateway V2 Stage Stg: prod');
      expect(lines).toContain('Updating API Gateway V2 Stage Stg: prod');
    });

    it('no context: lines print unmasked (back-compat, absent means identity)', async () => {
      fakeApiGatewayV2({});
      await provider.create('Stg', 'AWS::ApiGatewayV2::Stage', {
        ApiId: 'api-1',
        StageName: TINY_A,
      });
      expect(transcript()).toContain(`Successfully created API Gateway V2 Stage Stg: ${TINY_A}`);
    });
  });

  describe('AWS text quoting a request value back', () => {

    for (const c of FAILURE_SITES) {
      it(`${c.label} failure message`, async () => {
        fakeApiGatewayV2({ UpdateApiCommand: API_CREATED, [c.failingCommand]: throwing(echo()) });
        const message = await thrownMessage(c.run(provider, maskSecrets));
        expect(message).toContain(c.prefix);
        expect(message).not.toContain(LONG);
        expect(message).toContain(MASKED_ECHO);
      });
    }
  });

  describe('a Stage name derived from a secret', () => {
    // The physical id is the recorded name; state persists a secret-derived
    // name as its `{{resolve:` reference (or `***`) while the physical id stays
    // the plaintext, which may be in no bag of this deploy (a rotated secret),
    // so the base masker alone cannot recognise it. `updateStage` refuses a
    // StageName CHANGE before any line, so the shapes that reach a line are
    // the ones where both sides agree (a replay of state, as rollback and
    // `drift --revert` pass) or one side is absent.
    const OLD_NAME = 'old-secret-stage-name';
    const REF = '{{resolve:secretsmanager:stage-name}}';
    const replay = { ApiId: 'api-1', StageName: REF };

    it('update() replaying the recorded reference: the name is masked on the updating line', async () => {
      fakeApiGatewayV2({});
      await provider.update(
        'Stg',
        OLD_NAME,
        'AWS::ApiGatewayV2::Stage',
        { ...replay, Description: 'changed' },
        replay,
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updating API Gateway V2 Stage Stg: ${SECRET_MASK}`);
      expect(lines).not.toContain(OLD_NAME);
    });

    it('update() replaying the recorded reference: an AWS echo of the name is masked', async () => {
      fakeApiGatewayV2({ UpdateStageCommand: throwing(echo(OLD_NAME)) });
      const message = await thrownMessage(
        provider.update(
          'Stg',
          OLD_NAME,
          'AWS::ApiGatewayV2::Stage',
          { ...replay, Description: 'changed' },
          replay,
          { maskSecrets }
        )
      );
      expect(message).toContain('Failed to update API Gateway V2 Stage Stg:');
      expect(message).not.toContain(OLD_NAME);
      expect(message).toContain(MASKED_ECHO);
    });

    it('update() previous side only: a recorded reference with no desired StageName', async () => {
      // Only the previous side can mark the name secret-derived here.
      fakeApiGatewayV2({ UpdateStageCommand: throwing(echo(OLD_NAME)) });
      const message = await thrownMessage(
        provider.update(
          'Stg',
          OLD_NAME,
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1', Description: 'changed' },
          replay,
          { maskSecrets }
        )
      );
      expect(message).toContain(MASKED_ECHO);
      expect(message).not.toContain(OLD_NAME);
      expect(transcript()).toContain(`Updating API Gateway V2 Stage Stg: ${SECRET_MASK}`);
      expect(transcript()).not.toContain(OLD_NAME);
    });

    it('update() previous side only: a recorded *** counts as secret-derived too', async () => {
      fakeApiGatewayV2({});
      await provider.update(
        'Stg',
        OLD_NAME,
        'AWS::ApiGatewayV2::Stage',
        { ApiId: 'api-1', Description: 'changed' },
        { ApiId: 'api-1', StageName: SECRET_MASK },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updating API Gateway V2 Stage Stg: ${SECRET_MASK}`);
      expect(lines).not.toContain(OLD_NAME);
    });

    it('update() with a differing StageName is refused before any line names it', async () => {
      fakeApiGatewayV2({});
      const message = await thrownMessage(
        provider.update(
          'Stg',
          OLD_NAME,
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1', StageName: LONG },
          replay,
          { maskSecrets }
        )
      );
      expect(message).toContain('StageName is immutable');
      expect(message).not.toContain(OLD_NAME);
      expect(message).not.toContain(LONG);
      expect(transcript()).not.toContain(OLD_NAME);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('create(): a short secret name AWS echoes back is masked', async () => {
      // Below the base masker's substring floor, so only the derived-name mask
      // the create builds from the desired StageName catches the echo.
      fakeApiGatewayV2({
        CreateStageCommand: throwing(new Error(`Stage already exists: ${TINY_A}`)),
      });
      const message = await thrownMessage(
        provider.create(
          'Stg',
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1', StageName: TINY_A },
          { maskSecrets }
        )
      );
      expect(message).toContain(`Stage already exists: ${SECRET_MASK}`);
      expect(message).not.toContain(TINY_A);
    });

    it('update(): a short secret name AWS echoes back is masked through the desired side', async () => {
      fakeApiGatewayV2({
        UpdateStageCommand: throwing(new Error(`Invalid stage identifier specified: ${TINY_A}`)),
      });
      const message = await thrownMessage(
        provider.update(
          'Stg',
          TINY_A,
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1', StageName: TINY_A, Description: 'changed' },
          // No recorded StageName, so only the desired side can name it.
          { ApiId: 'api-1' },
          { maskSecrets }
        )
      );
      expect(message).toContain(`Invalid stage identifier specified: ${SECRET_MASK}`);
      expect(message).not.toContain(TINY_A);
    });

    it('update(): an ordinary recorded name in an AWS echo renders unchanged (negative control)', async () => {
      fakeApiGatewayV2({ UpdateStageCommand: throwing(echo('prod')) });
      const message = await thrownMessage(
        provider.update(
          'Stg',
          'prod',
          'AWS::ApiGatewayV2::Stage',
          { ApiId: 'api-1', StageName: 'prod', Description: 'changed' },
          { ApiId: 'api-1', StageName: 'prod' },
          { maskSecrets }
        )
      );
      expect(message).toContain(`Invalid value 'prod' for the request`);
    });
  });
  describe('a masked failure still classifies as retryable (issue #4244 class)', () => {
    /** A secret that spells part of the retry table's `does not exist` wording. */
    const RETRY_WORD = 'exist';
    const retryMasker = createSecretMasker(bagOf(RETRY_WORD));
    const TRANSIENT = 'Api abc123 does not exist';
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

    for (const c of FAILURE_SITES) {
      it(`${c.label}: the stamp keeps it retryable`, async () => {
        fakeApiGatewayV2({
          UpdateApiCommand: API_CREATED,
          [c.failingCommand]: throwing(new Error(TRANSIENT)),
        });
        const failure = await thrown(c.run(provider, retryMasker));
        expect(failure.message).toContain(c.prefix);
        // Premise: the mask cut the retry wording out of the message itself.
        expect(failure.message).not.toContain('does not exist');
        expect(isRetryableTransientError(failure, failure.message)).toBe(false);
        expect(hasRedactedCause(failure)).toBe(true);
        expect(retryable(failure)).toBe(true);
      });

      it(`${c.label}: a failure the mask left unchanged is not stamped`, async () => {
        fakeApiGatewayV2({
          UpdateApiCommand: API_CREATED,
          [c.failingCommand]: throwing(new Error('Bad request parameter')),
        });
        const failure = await thrown(c.run(provider, retryMasker));
        expect(failure.message).toContain(`${c.prefix} Bad request parameter`);
        expect(hasRedactedCause(failure)).toBe(false);
        expect(retryable(failure)).toBe(false);
      });
    }
  });
});
