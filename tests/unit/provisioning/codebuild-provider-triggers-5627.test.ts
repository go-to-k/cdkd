import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
/** Which client instance sent each command: the provider holds two. */
const { sentBy } = vi.hoisted(() => ({ sentBy: new Map<string, object>() }));
const { disposeSpy } = vi.hoisted(() => ({ disposeSpy: vi.fn() }));

// Counts `dispose`: the SIGINT listener is shared, so its count cannot show it.
vi.mock('../../../src/provisioning/interrupt-watch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/interrupt-watch.js')>();
  return {
    ...actual,
    startInterruptWatch: (what: string) => {
      const watch = actual.startInterruptWatch(what);
      return {
        ...watch,
        dispose: () => {
          disposeSpy();
          watch.dispose();
        },
      };
    },
  };
});

vi.mock('@aws-sdk/client-codebuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codebuild')>();
  return {
    ...actual,
    CodeBuildClient: vi.fn().mockImplementation(() => {
      const client = {
        send: (cmd: { constructor: { name: string } }) => {
          sentBy.set(cmd.constructor.name, client);
          return mockSend(cmd);
        },
        config: { region: () => Promise.resolve('us-east-1') },
      };
      return client;
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';
import {
  createdBeforeFailure,
  isAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import {
  isIamPropagationError,
  isMarkedNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

const TYPE = 'AWS::CodeBuild::Project';
const ARN = 'arn:aws:codebuild:us-east-1:111122223333:project/proj';
const BASE = {
  Name: 'proj',
  Source: { Type: 'GITHUB', Location: 'https://github.com/o/r.git' },
  Artifacts: { Type: 'NO_ARTIFACTS' },
  Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'img' },
  ServiceRole: 'arn:aws:iam::111122223333:role/svc',
};
const GROUPS = [
  [
    { Type: 'EVENT', Pattern: 'PUSH' },
    { Type: 'HEAD_REF', Pattern: '^refs/heads/main$', ExcludeMatchedPattern: false },
  ],
];
const SDK_GROUPS = [
  [
    { type: 'EVENT', pattern: 'PUSH' },
    { type: 'HEAD_REF', pattern: '^refs/heads/main$', excludeMatchedPattern: false },
  ],
];

const calls = (): string[] => mockSend.mock.calls.map((c) => c[0].constructor.name);
const inputOf = (name: string): Record<string, unknown> =>
  mockSend.mock.calls.find((c) => c[0].constructor.name === name)?.[0].input;

/** `CreateWebhook` throws each error in turn, then succeeds. */
function armWebhookOutcomes(...errors: Error[]): void {
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
    cmd.constructor.name === 'CreateWebhookCommand' && errors.length > 0
      ? Promise.reject(errors.shift())
      : Promise.resolve({ project: { name: 'proj', arn: ARN } })
  );
}

/** `UpdateProject` answers with `project.webhook` exactly when one is live. */
function armLive(live: boolean): void {
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
    Promise.resolve({
      project: { name: 'proj', arn: ARN, ...(live && cmd.constructor.name === 'UpdateProjectCommand' && { webhook: { url: 'u' } }) },
    })
  );
}

describe('CodeBuildProvider Triggers (go-to-k/cdkd#5627)', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    armLive(false);
    provider = new CodeBuildProvider();
  });

  describe('create', () => {
    it('declares Triggers handled', () => {
      expect(provider.handledProperties.get(TYPE)?.has('Triggers')).toBe(true);
    });

    it('creates the webhook after the project, with every declared member', async () => {
      await provider.create('L', TYPE, {
        ...BASE,
        Source: { Type: 'GITHUB', Location: 'CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION' },
        Triggers: {
          Webhook: true,
          BuildType: 'BUILD_BATCH',
          FilterGroups: GROUPS,
          ScopeConfiguration: { Name: 'org', Scope: 'GITHUB_GLOBAL', Domain: 'd' },
          PullRequestBuildPolicy: {
            RequiresCommentApproval: 'DISABLED',
            ApproverRoles: ['GITHUB_ADMIN'],
          },
        },
      });
      expect(calls()).toEqual(['CreateProjectCommand', 'CreateWebhookCommand']);
      expect(inputOf('CreateWebhookCommand')).toEqual({
        projectName: 'proj',
        buildType: 'BUILD_BATCH',
        filterGroups: SDK_GROUPS,
        scopeConfiguration: { name: 'org', scope: 'GITHUB_GLOBAL', domain: 'd' },
        pullRequestBuildPolicy: {
          requiresCommentApproval: 'DISABLED',
          approverRoles: ['GITHUB_ADMIN'],
        },
      });
    });

    it('sends CreateWebhook on the client with no 5xx replay, as it has no idempotency token', async () => {
      await provider.create('L', TYPE, { ...BASE, Triggers: { Webhook: true } });
      await provider.update('L', 'proj', TYPE, { ...BASE, Triggers: { Webhook: false } }, BASE);
      expect(sentBy.get('CreateWebhookCommand')).toBe(sentBy.get('CreateProjectCommand'));
      expect(sentBy.get('CreateWebhookCommand')).not.toBe(sentBy.get('UpdateProjectCommand'));
    });

    it('reports the project before the webhook call, so an interrupted one is journaled', async () => {
      let atWebhook: unknown = 'unset';
      const sink = new CreatedResourceSink('L', TYPE);
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'CreateWebhookCommand') atWebhook = sink.report;
        return Promise.resolve({ project: { name: 'proj', arn: ARN } });
      });
      await collectCreatedResources(sink, () =>
        provider.create('L', TYPE, { ...BASE, Triggers: { Webhook: true } })
      );
      expect(atWebhook).toEqual({ physicalId: 'proj' });
    });

    it('keeps the type off Cloud Control, which has no handlers for it', () => {
      expect(provider.disableCcApiFallback).toBe(true);
    });

    it('sends a declared empty FilterGroups', async () => {
      await provider.create('L', TYPE, { ...BASE, Triggers: { Webhook: true, FilterGroups: [] } });
      expect(inputOf('CreateWebhookCommand')).toEqual({ projectName: 'proj', filterGroups: [] });
    });

    it('accepts and sends nowhere a scope beside no enabled webhook', async () => {
      await provider.create('L', TYPE, {
        ...BASE,
        Triggers: { Webhook: false, ScopeConfiguration: { Name: 'o' } },
      });
      expect(calls()).toEqual(['CreateProjectCommand']);
    });

    it('refuses a scope on a project with no source location to compare', async () => {
      const { Source: _source, ...sourceless } = BASE;
      await expect(
        provider.create('L', TYPE, {
          ...sourceless,
          Triggers: { Webhook: true, ScopeConfiguration: { Name: 'o' } },
        })
      ).rejects.toThrow('cannot specify a scope');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('omits what the template does not declare, as CloudFormation does', async () => {
      await provider.create('L', TYPE, { ...BASE, Triggers: { Webhook: true } });
      expect(inputOf('CreateWebhookCommand')).toEqual({ projectName: 'proj' });
    });

    it('defaults an unnamed scope to the one the schema documents', async () => {
      await provider.create('L', TYPE, {
        ...BASE,
        Source: { Type: 'GITHUB', Location: 'CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION' },
        Triggers: { Webhook: true, ScopeConfiguration: { Name: 'org' } },
      });
      expect(inputOf('CreateWebhookCommand')['scopeConfiguration']).toEqual({
        name: 'org',
        scope: 'GITHUB_ORGANIZATION',
      });
    });

    it.each(['true', 'True', 'TRUE'])('enables the webhook for the spelling %s', async (Webhook) => {
      await provider.create('L', TYPE, { ...BASE, Triggers: { Webhook } });
      expect(calls()).toContain('CreateWebhookCommand');
    });

    it.each(['false', 'False'])('creates no webhook for the spelling %s', async (Webhook) => {
      await provider.create('L', TYPE, { ...BASE, Triggers: { Webhook } });
      expect(calls()).toEqual(['CreateProjectCommand']);
    });

    it('coerces ExcludeMatchedPattern: "True" as well', async () => {
      await provider.create('L', TYPE, {
        ...BASE,
        Triggers: {
          Webhook: true,
          FilterGroups: [[{ Type: 'HEAD_REF', Pattern: 'x', ExcludeMatchedPattern: 'True' }]],
        },
      });
      expect(inputOf('CreateWebhookCommand')['filterGroups']).toEqual([
        [{ type: 'HEAD_REF', pattern: 'x', excludeMatchedPattern: true }],
      ]);
    });

    it('takes the string spelling of a boolean, which CloudFormation coerces', async () => {
      await provider.create('L', TYPE, {
        ...BASE,
        Triggers: {
          Webhook: 'true',
          FilterGroups: [[{ Type: 'HEAD_REF', Pattern: 'x', ExcludeMatchedPattern: 'true' }]],
        },
      });
      expect(inputOf('CreateWebhookCommand')['filterGroups']).toEqual([
        [{ type: 'HEAD_REF', pattern: 'x', excludeMatchedPattern: true }],
      ]);
    });

    it.each([
      ['Webhook: false', { Webhook: false }],
      ['Webhook: "false"', { Webhook: 'false' }],
      ['an empty block', {}],
      ['a policy with no Webhook', { PullRequestBuildPolicy: { RequiresCommentApproval: 'DISABLED' } }],
    ])('creates no webhook for %s', async (_name, Triggers) => {
      await provider.create('L', TYPE, { ...BASE, Triggers });
      expect(calls()).toEqual(['CreateProjectCommand']);
    });

    it.each([
      ['filter groups with no Webhook', { FilterGroups: GROUPS }, 'cannot specify filter groups'],
      [
        'empty filter groups beside Webhook: false',
        { Webhook: false, FilterGroups: [] },
        'cannot specify filter groups',
      ],
      ['a build type with no Webhook', { BuildType: 'BUILD' }, 'cannot specify build type'],
      ['a scope off the default location', { Webhook: true, ScopeConfiguration: { Name: 'o' } }, 'cannot specify a scope'],
      ['a non-object block', 'yes', 'Triggers must be an object'],
      ['a non-boolean Webhook', { Webhook: 1 }, 'Triggers.Webhook must be a boolean'],
      ['flat filter groups', { Webhook: true, FilterGroups: GROUPS[0] }, 'a list of filter lists'],
      ['a non-object filter', { Webhook: true, FilterGroups: [['x']] }, 'a list of filter lists'],
      ['a non-string build type', { Webhook: true, BuildType: 1 }, 'Triggers.BuildType must be a string'],
      ['a non-object policy', { Webhook: true, PullRequestBuildPolicy: 'x' }, 'PullRequestBuildPolicy must be an object'],
      ['a non-object scope', { Webhook: true, ScopeConfiguration: 'x' }, 'ScopeConfiguration must be an object'],
    ])('refuses %s before CreateProject', async (_name, Triggers, message) => {
      await expect(provider.create('L', TYPE, { ...BASE, Triggers })).rejects.toThrow(message);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('masks the value a refusal echoes', async () => {
      await expect(
        provider.create(
          'L',
          TYPE,
          { ...BASE, Triggers: { Webhook: 's3cr3t' } },
          { maskSecrets: (t: string) => t.replaceAll('s3cr3t', '***') }
        )
      ).rejects.toThrow(/Triggers\.Webhook must be a boolean, got "\*\*\*"/);
    });

    it('on a state replay a refused block gets no webhook and a warning', async () => {
      await provider.create(
        'L',
        TYPE,
        { ...BASE, Triggers: { FilterGroups: GROUPS } },
        { replayingState: true }
      );
      expect(calls()).toEqual(['CreateProjectCommand']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gets no webhook'));
    });

    it('a failed CreateWebhook names the project it left behind', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'CreateWebhookCommand'
          ? Promise.reject(new Error('no credentials'))
          : Promise.resolve({ project: { name: 'proj', arn: ARN } })
      );
      const error = await provider
        .create('L', TYPE, { ...BASE, Triggers: { Webhook: true } })
        .catch((e: unknown) => e);
      expect(createdBeforeFailure(error, 'L', TYPE)).toBe('proj');
      expect(isAuxiliaryFailure((error as Error).cause)).toBe(true);
    });

    it('never returns a secret CreateWebhook answers with', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        Promise.resolve(
          cmd.constructor.name === 'CreateWebhookCommand'
            ? { webhook: { secret: 'hook-secret' } }
            : { project: { name: 'proj', arn: ARN } }
        )
      );
      const result = await provider.create('L', TYPE, { ...BASE, Triggers: { Webhook: true } });
      expect(JSON.stringify(result)).not.toContain('hook-secret');
    });
  });

  describe('update', () => {
    const update = (
      properties: Record<string, unknown>,
      previous: Record<string, unknown> = BASE,
      context?: Parameters<CodeBuildProvider['update']>[5]
    ) => provider.update('L', 'proj', TYPE, properties, previous, context);

    it('creates a webhook none is live for, one deleted out of band included', async () => {
      await update({ ...BASE, Triggers: { Webhook: true } }, { ...BASE, Triggers: { Webhook: true } });
      expect(calls()).toEqual(['UpdateProjectCommand', 'CreateWebhookCommand']);
    });

    it('updates a live webhook with the members CloudFormation always sends', async () => {
      armLive(true);
      await update({ ...BASE, Triggers: { Webhook: true, FilterGroups: GROUPS, BuildType: 'BUILD_BATCH' } });
      expect(calls()).toEqual(['UpdateProjectCommand', 'UpdateWebhookCommand']);
      expect(inputOf('UpdateWebhookCommand')).toEqual({
        projectName: 'proj',
        filterGroups: SDK_GROUPS,
        buildType: 'BUILD_BATCH',
        rotateSecret: false,
      });
    });

    it('clears removed filters, resets a removed build type, keeps a removed policy', async () => {
      armLive(true);
      await update(
        { ...BASE, Triggers: { Webhook: true } },
        {
          ...BASE,
          Triggers: {
            Webhook: true,
            FilterGroups: GROUPS,
            BuildType: 'BUILD_BATCH',
            PullRequestBuildPolicy: { RequiresCommentApproval: 'DISABLED' },
          },
        }
      );
      expect(inputOf('UpdateWebhookCommand')).toEqual({
        projectName: 'proj',
        filterGroups: [],
        buildType: 'BUILD',
        rotateSecret: false,
      });
    });

    it('sends a declared policy', async () => {
      armLive(true);
      await update({
        ...BASE,
        Triggers: { Webhook: true, PullRequestBuildPolicy: { RequiresCommentApproval: 'DISABLED' } },
      });
      expect(inputOf('UpdateWebhookCommand')['pullRequestBuildPolicy']).toEqual({
        requiresCommentApproval: 'DISABLED',
      });
    });

    it('still updates the webhook when Triggers did not change', async () => {
      armLive(true);
      const properties = { ...BASE, Description: 'new', Triggers: { Webhook: true } };
      await update(properties, { ...BASE, Triggers: { Webhook: true } });
      expect(calls()).toContain('UpdateWebhookCommand');
    });

    it('deletes a live webhook on Webhook: false', async () => {
      armLive(true);
      await update({ ...BASE, Triggers: { Webhook: false } }, { ...BASE, Triggers: { Webhook: true } });
      expect(calls()).toEqual(['UpdateProjectCommand', 'DeleteWebhookCommand']);
      expect(inputOf('DeleteWebhookCommand')).toEqual({ projectName: 'proj' });
    });

    it('calls nothing for Webhook: false with none live', async () => {
      await update({ ...BASE, Triggers: { Webhook: false } });
      expect(calls()).toEqual(['UpdateProjectCommand']);
    });

    it.each([
      ['a removed Triggers', { ...BASE }],
      ['an empty block', { ...BASE, Triggers: {} }],
      ['a policy with no Webhook', { ...BASE, Triggers: { PullRequestBuildPolicy: { RequiresCommentApproval: 'DISABLED' } } }],
    ])('keeps a live webhook for %s, as CloudFormation does', async (_name, properties) => {
      armLive(true);
      await update(properties, { ...BASE, Triggers: { Webhook: true } });
      expect(calls()).toEqual(['UpdateProjectCommand']);
    });

    it('refuses what CloudFormation refuses before UpdateProject', async () => {
      await expect(update({ ...BASE, Triggers: { FilterGroups: GROUPS } })).rejects.toThrow(
        'cannot specify filter groups'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names the resource on the refusal', async () => {
      const error = await update({ ...BASE, Triggers: { BuildType: 'BUILD' } }).catch(
        (e: unknown) => e
      );
      expect(error).toMatchObject({ logicalId: 'L', physicalId: 'proj' });
    });

    it('sends UpdateWebhook and DeleteWebhook on the client with the full SDK retry', async () => {
      armLive(true);
      await update({ ...BASE, Triggers: { Webhook: true } });
      await update({ ...BASE, Triggers: { Webhook: false } });
      expect(sentBy.get('UpdateWebhookCommand')).toBe(sentBy.get('UpdateProjectCommand'));
      expect(sentBy.get('DeleteWebhookCommand')).toBe(sentBy.get('UpdateProjectCommand'));
    });

    describe('a scope, which UpdateWebhook cannot carry', () => {
      const scoped = (name: string) => ({
        ...BASE,
        Source: { Type: 'GITHUB', Location: 'CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION' },
        Triggers: { Webhook: true, ScopeConfiguration: { Name: name } },
      });

      const armLiveScope = (scope?: Record<string, unknown>): void => {
        mockSend.mockImplementation(() =>
          Promise.resolve({
            project: {
              name: 'proj',
              arn: ARN,
              webhook: { url: 'u', ...(scope && { scopeConfiguration: scope }) },
            },
          })
        );
      };
      const LIVE = { name: 'same', scope: 'GITHUB_ORGANIZATION' };

      it('warns when it differs from the live webhook, and sends no scope', async () => {
        armLiveScope(LIVE);
        await update(scoped('new'), scoped('same'));
        expect(inputOf('UpdateWebhookCommand')).not.toHaveProperty('scopeConfiguration');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot change scope'));
      });

      it('warns when the live webhook holds none', async () => {
        armLiveScope();
        await update(scoped('new'), scoped('new'));
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it('is silent when it matches, the default made explicit included', async () => {
        armLiveScope(LIVE);
        await update(scoped('same'), scoped('same'));
        await update(
          {
            ...scoped('same'),
            Triggers: {
              Webhook: true,
              ScopeConfiguration: { Name: 'same', Scope: 'GITHUB_ORGANIZATION' },
            },
          },
          scoped('same')
        );
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('is silent after a removal and a redeclaration: the scope never left the webhook', async () => {
        armLiveScope(LIVE);
        await update(scoped('same'), { ...scoped('same'), Triggers: { Webhook: true } });
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('is silent when the template declares none', async () => {
        armLiveScope(LIVE);
        await update({ ...scoped('same'), Triggers: { Webhook: true } }, scoped('same'));
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('is silent when the live webhook carries a field the template does not declare', async () => {
        armLiveScope({ ...LIVE, domain: 'filled-in' });
        await update(scoped('same'), scoped('same'));
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('warns when a declared field differs from the live one', async () => {
        armLiveScope({ ...LIVE, domain: 'other' });
        await update(
          {
            ...scoped('same'),
            Triggers: { Webhook: true, ScopeConfiguration: { Name: 'same', Domain: 'mine' } },
          },
          scoped('same')
        );
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it('reaches CreateWebhook with none live', async () => {
        await update(scoped('new'), scoped('old'));
        expect(inputOf('CreateWebhookCommand')['scopeConfiguration']).toMatchObject({ name: 'new' });
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    it('a rollback replay of a refused block leaves the webhook alone', async () => {
      armLive(true);
      await update({ ...BASE, Triggers: { BuildType: 'BUILD' } }, BASE, { replayingState: true });
      expect(calls()).toEqual(['UpdateProjectCommand']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('left unchanged'));
    });

    it.each([
      ['CreateWebhookCommand', false, true],
      ['UpdateWebhookCommand', true, true],
      ['DeleteWebhookCommand', true, false],
    ])('wraps a failed %s', async (failing, live, Webhook) => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === failing
          ? Promise.reject(new Error('no credentials'))
          : Promise.resolve({
              project: { name: 'proj', arn: ARN, ...(live && { webhook: { url: 'u' } }) },
            })
      );
      await expect(update({ ...BASE, Triggers: { Webhook } })).rejects.toThrow(
        /Failed to update CodeBuild Project L: no credentials/
      );
    });
  });

  describe('the connection race on a fresh service role', () => {
    const TOKEN = 'The security token included in the request is invalid.';
    const CONNECTION = 'User is not authorized to access connection arn:aws:codestar-connections:x';
    const awsError = (name: string, message: string): Error =>
      Object.assign(new Error(message), { name, $metadata: {}, $fault: 'client' });
    const failure = async (run: Promise<unknown>): Promise<Error> => {
      const error = await run.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    };

    it.each([TOKEN, CONNECTION])('CreateProject answering "%s" retries', async (message) => {
      mockSend.mockRejectedValue(awsError('OAuthProviderException', message));
      const error = await failure(provider.create('L', TYPE, BASE));
      expect(isIamPropagationError(error.message)).toBe(true);
      expect(error.message).not.toContain('arn:aws');
    });

    it('keeps the meaning of each sentence in the final error', async () => {
      mockSend.mockRejectedValue(awsError('OAuthProviderException', CONNECTION));
      const denied = await failure(provider.create('L', TYPE, BASE));
      expect(denied.message).toContain(
        'The service role is not authorized to perform access to the connection Source.Auth names'
      );
      expect(denied.message).not.toContain('security token');

      mockSend.mockRejectedValue(awsError('OAuthProviderException', TOKEN));
      const token = await failure(provider.create('L', TYPE, BASE));
      expect(token.message).toContain('security token included in the request is invalid');
      expect(token.message).not.toContain('Source.Auth names');
    });

    it.each([TOKEN, CONNECTION])('UpdateProject answering "%s" retries', async (message) => {
      mockSend.mockRejectedValue(awsError('OAuthProviderException', message));
      const error = await failure(provider.update('L', 'proj', TYPE, BASE, BASE));
      expect(isIamPropagationError(error.message)).toBe(true);
    });

    it('DeleteProject does not read it as a race: no role is in play', async () => {
      mockSend.mockRejectedValue(awsError('OAuthProviderException', TOKEN));
      const error = await failure(provider.delete('L', 'proj', TYPE));
      expect(isIamPropagationError(error.message)).toBe(false);
    });

    it("stays terminal for the caller's own credentials", async () => {
      mockSend.mockRejectedValue(awsError('UnrecognizedClientException', TOKEN));
      const error = await failure(provider.create('L', TYPE, BASE));
      expect(isIamPropagationError(error.message)).toBe(false);
    });

    it('stays terminal for another OAuth failure', async () => {
      mockSend.mockRejectedValue(awsError('OAuthProviderException', 'The token was revoked'));
      const error = await failure(provider.create('L', TYPE, BASE));
      expect(isIamPropagationError(error.message)).toBe(false);
    });

    it('does not read a failure past CreateProject as a race', async () => {
      armWebhookOutcomes(awsError('OAuthProviderException', TOKEN));
      const error = await failure(
        provider.create('L', TYPE, { ...BASE, Triggers: { Webhook: true } })
      );
      expect(isIamPropagationError(error.message)).toBe(false);
    });
  });

  describe('a CreateWebhook that fails after CreateProject', () => {
    const serverError = (): Error =>
      Object.assign(new Error('boom'), {
        name: 'InternalFailure',
        $fault: 'server',
        $metadata: { httpStatusCode: 500 },
      });
    const iamError = (): Error =>
      Object.assign(new Error('not authorized to perform: codebuild:CreateWebhook'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
      });
    const denied = (): Error =>
      Object.assign(new Error('nope'), {
        name: 'InvalidInputException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      });
    const alreadyExists = (): Error =>
      Object.assign(new Error('Webhook already exists for this project'), {
        name: 'ResourceAlreadyExistsException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      });
    const sleeps: number[] = [];
    const count = (name: string): number => calls().filter((c) => c === name).length;
    const create = () => provider.create('L', TYPE, { ...BASE, Triggers: { Webhook: true } });

    beforeEach(() => {
      sleeps.length = 0;
      Object.assign(provider, {
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });
    });

    it.each([
      ['a 5xx', serverError],
      ['an IAM propagation refusal', iamError],
    ])('retries %s locally, never re-entering CreateProject', async (_name, make) => {
      armWebhookOutcomes(make(), make());
      await expect(create()).resolves.toMatchObject({ physicalId: 'proj' });
      expect(count('CreateProjectCommand')).toBe(1);
      expect(count('CreateWebhookCommand')).toBe(3);
      expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
    });

    it('takes an already-exists on a later attempt as its own 5xx having landed', async () => {
      armWebhookOutcomes(serverError(), alreadyExists());
      await expect(create()).resolves.toMatchObject({ physicalId: 'proj' });
      expect(count('CreateWebhookCommand')).toBe(2);
    });

    it('retries a timeout, whose request may have landed', async () => {
      armWebhookOutcomes(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      await expect(create()).resolves.toMatchObject({ physicalId: 'proj' });
      expect(count('CreateWebhookCommand')).toBe(2);
    });

    it('refuses an already-exists after a throttle, which did nothing', async () => {
      armWebhookOutcomes(
        Object.assign(new Error('slow down'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 429 },
        }),
        alreadyExists()
      );
      await expect(create()).rejects.toBeInstanceOf(Error);
      expect(count('CreateWebhookCommand')).toBe(2);
    });

    it('refuses an already-exists after a definite IAM refusal', async () => {
      armWebhookOutcomes(iamError(), alreadyExists());
      await expect(create()).rejects.toBeInstanceOf(Error);
      expect(count('CreateWebhookCommand')).toBe(2);
    });

    it('keeps the latch across a later unambiguous try', async () => {
      armWebhookOutcomes(serverError(), iamError(), alreadyExists());
      await expect(create()).resolves.toMatchObject({ physicalId: 'proj' });
      expect(count('CreateWebhookCommand')).toBe(3);
    });

    it('rethrows a non-Error throw as it is, with no retry', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'CreateWebhookCommand'
          ? Promise.reject('a string')
          : Promise.resolve({ project: { name: 'proj', arn: ARN } })
      );
      const error = (await create().catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toMatch(/Cannot read|undefined/);
      expect(count('CreateWebhookCommand')).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it('waits a second at most between interrupt checks', async () => {
      armWebhookOutcomes(serverError());
      await create();
      expect(sleeps).toEqual([1000, 1000]);
    });

    describe('with the command owning interrupts', () => {
      beforeEach(() => {
        disarmInterruptWatchForTests();
        interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      });
      afterEach(() => {
        disarmInterruptWatchForTests();
        delete interruptWatchTestSeam.commandOwnsInterrupts;
      });

      it('stops on an interrupt during the backoff, and releases its watch', async () => {
        armWebhookOutcomes(serverError(), serverError());
        let naps = 0;
        Object.assign(provider, {
          sleep: () => {
            naps++;
            process.emit('SIGINT');
            return Promise.resolve();
          },
        });
        const error = await create().catch((e: unknown) => e);
        expect(isInterruptedWaitError(error)).toBe(true);
        expect(naps).toBe(1);
        expect(count('CreateWebhookCommand')).toBe(1);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
      });

      it('stops on an interrupt in the last second, before another try', async () => {
        armWebhookOutcomes(serverError());
        let naps = 0;
        Object.assign(provider, {
          sleep: () => {
            naps++;
            if (naps === 2) process.emit('SIGINT');
            return Promise.resolve();
          },
        });
        const error = await create().catch((e: unknown) => e);
        expect(isInterruptedWaitError(error)).toBe(true);
        expect(count('CreateWebhookCommand')).toBe(1);
      });

      it('releases its watch on success and on a terminal failure', async () => {
        await create();
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        armWebhookOutcomes(denied());
        await create().catch(() => undefined);
        expect(disposeSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('refuses an already-exists on the first attempt', async () => {
      armWebhookOutcomes(alreadyExists());
      await expect(create()).rejects.toBeInstanceOf(Error);
      expect(count('CreateWebhookCommand')).toBe(1);
    });

    it('stops at the bound, terminal, so create() is not re-entered', async () => {
      armWebhookOutcomes(serverError(), serverError(), serverError(), serverError(), serverError());
      const error = await create().catch((e: unknown) => e);
      expect(count('CreateWebhookCommand')).toBe(4);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(createdBeforeFailure(error, 'L', TYPE)).toBe('proj');
    });

    it('does not retry a failure that cannot pass, and marks it terminal', async () => {
      armWebhookOutcomes(denied());
      const error = await create().catch((e: unknown) => e);
      expect(count('CreateWebhookCommand')).toBe(1);
      expect(sleeps).toEqual([]);
      expect(isMarkedNonRetryable(error)).toBe(true);
    });
  });

  it('declares Triggers unreadable to drift, as the schema marks it write-only', () => {
    expect(provider.getDriftUnknownPaths()).toContain('Triggers');
  });
});
