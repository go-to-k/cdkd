import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import {
  shiftAliasThroughCodeDeploy,
  readAliasDeploymentPolicy,
  functionNameOf,
  deploymentWaitCapMs,
  settleWaitCapMs,
  aliasAppSpec,
  buildCodeDeployAliasClients,
  trafficRoutingMs,
  ACTIVE_DEPLOYMENT_STATUSES,
  type CodeDeployAliasClients,
  type CodeDeployAliasHost,
} from '../../../src/provisioning/cloud-control/codedeploy-alias-update.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import {
  clearResolvedResourceTimeouts,
  setResolvedResourceTimeouts,
} from '../../../src/provisioning/resource-timeout-registry.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import type { UpdateContext } from '../../../src/types/resource.js';

// go-to-k/cdkd#6437 PR 3: `UpdatePolicy.CodeDeployLambdaAliasUpdate` under
// `--update-policy`, the CodeDeploy step `CloudControlProvider.update` runs
// before its patch for an `AWS::Lambda::Alias`.

const TYPE = 'AWS::Lambda::Alias';
const ALIAS_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn:live';
const PREVIOUS = { FunctionName: 'my-fn', FunctionVersion: '1', Name: 'live' };
const DESIRED = { ...PREVIOUS, FunctionVersion: '2' };
const POLICY = {
  CodeDeployLambdaAliasUpdate: { ApplicationName: 'my-app', DeploymentGroupName: 'my-dg' },
};

class Cmd {
  constructor(
    readonly kind: string,
    readonly input: Record<string, unknown>
  ) {}
}
const command = (kind: string) =>
  class extends Cmd {
    constructor(input: Record<string, unknown>) {
      super(kind, input);
    }
  };

interface Script {
  /** GetAlias answers in order (the last repeats); an Error rejects. */
  alias?: Array<{ FunctionVersion?: string; RoutingConfig?: unknown } | Error>;
  /** ListDeployments answers in order (the last repeats). */
  active?: Array<string[] | Error>;
  create?: Array<string | Error>;
  /** GetDeployment statuses in order (the last repeats). */
  statuses?: Array<{ status: string; message?: string } | Error>;
  stop?: Error;
  /** ListDeployments pages, consumed in order before `active` (pagination). */
  activePages?: Array<{ deployments: string[]; nextToken?: string }>;
  /** GetDeploymentConfig's trafficRoutingConfig; an Error rejects GetDeploymentGroup. */
  routing?: Record<string, unknown> | Error;
  updateAlias?: Error;
}

let sent: Cmd[];
let script: Script;
let destroyed: number;

function clients(): CodeDeployAliasClients {
  const take = <T>(list: T[] | undefined, fallback: T): T =>
    list === undefined || list.length === 0 ? fallback : list.length > 1 ? list.shift()! : list[0]!;
  const answer = (value: unknown) =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  const send = (c: unknown): Promise<unknown> => {
    const cmd = c as Cmd;
    sent.push(cmd);
    switch (cmd.kind) {
      case 'GetAlias': {
        const a = take(script.alias, { FunctionVersion: '1' });
        return answer(a);
      }
      case 'ListDeployments': {
        if (script.activePages !== undefined && script.activePages.length > 0) {
          return Promise.resolve(script.activePages.shift());
        }
        const a = take(script.active, [] as string[]);
        return a instanceof Error ? Promise.reject(a) : Promise.resolve({ deployments: a });
      }
      case 'CreateDeployment': {
        const a = take(script.create, 'd-NEW');
        return a instanceof Error ? Promise.reject(a) : Promise.resolve({ deploymentId: a });
      }
      case 'GetDeployment': {
        const a = take(script.statuses, { status: 'Succeeded' });
        return a instanceof Error
          ? Promise.reject(a)
          : Promise.resolve({
              deploymentInfo: {
                status: a.status,
                ...(a.message !== undefined && { errorInformation: { message: a.message } }),
              },
            });
      }
      case 'GetDeploymentGroup':
        return script.routing instanceof Error
          ? Promise.reject(script.routing)
          : Promise.resolve({ deploymentGroupInfo: { deploymentConfigName: 'cfg' } });
      case 'GetDeploymentConfig':
        return Promise.resolve({
          deploymentConfigInfo: { trafficRoutingConfig: script.routing ?? { type: 'AllAtOnce' } },
        });
      case 'UpdateAlias':
        return script.updateAlias ? Promise.reject(script.updateAlias) : Promise.resolve({});
      case 'StopDeployment':
        return script.stop ? Promise.reject(script.stop) : Promise.resolve({ status: 'Pending' });
      default:
        return Promise.reject(new Error(`unexpected ${cmd.kind}`));
    }
  };
  // Each client refuses the other's commands, so a call sent to the wrong
  // client fails the case.
  const onlyFor =
    (kinds: string[]) =>
    (c: unknown): Promise<unknown> =>
      kinds.includes((c as Cmd).kind)
        ? send(c)
        : Promise.reject(new Error(`${(c as Cmd).kind} sent to the wrong client`));
  return {
    codeDeploy: {
      send: onlyFor([
        'ListDeployments',
        'CreateDeployment',
        'GetDeployment',
        'StopDeployment',
        'GetDeploymentGroup',
        'GetDeploymentConfig',
      ]),
    },
    lambda: { send: onlyFor(['GetAlias', 'UpdateAlias']) },
    commands: {
      GetAlias: command('GetAlias'),
      ListDeployments: command('ListDeployments'),
      CreateDeployment: command('CreateDeployment'),
      GetDeployment: command('GetDeployment'),
      StopDeployment: command('StopDeployment'),
      UpdateAlias: command('UpdateAlias'),
      GetDeploymentGroup: command('GetDeploymentGroup'),
      GetDeploymentConfig: command('GetDeploymentConfig'),
    },
    destroy: () => {
      destroyed++;
    },
  };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let built: number;
/** The fake clock the waits read: every sleep advances it. */
let clock: number;
function host(): CodeDeployAliasHost {
  return {
    logger: logger as never,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    startedAliasDeployments: new Map(),
    codeDeployAliasClients: () => {
      built++;
      return Promise.resolve(clients());
    },
  };
}

function run(
  context: UpdateContext | undefined,
  h: CodeDeployAliasHost = host(),
  desired: Record<string, unknown> = DESIRED,
  previous: Record<string, unknown> = PREVIOUS,
  resourceType = TYPE,
  mask: (t: string) => string = (t) => t
) {
  return shiftAliasThroughCodeDeploy(h, {
    logicalId: 'Alias',
    physicalId: ALIAS_ARN,
    resourceType,
    properties: desired,
    previousProperties: previous,
    context,
    mask,
  });
}

const kinds = () => sent.map((c) => c.kind);
const of = (kind: string) => sent.filter((c) => c.kind === kind);

beforeEach(() => {
  sent = [];
  script = {};
  destroyed = 0;
  built = 0;
  clock = 0;
  vi.clearAllMocks();
  delete process.env['CDKD_NO_WAIT'];
});
afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
  clearResolvedResourceTimeouts();
});

describe('nothing applies', () => {
  it.each([
    ['no context (flag off)', undefined, DESIRED, TYPE],
    ['a policy without CodeDeployLambdaAliasUpdate', { updatePolicy: { Other: {} } }, DESIRED, TYPE],
    ['an unchanged version', { updatePolicy: POLICY }, PREVIOUS, TYPE],
    ['another type', { updatePolicy: POLICY }, DESIRED, 'AWS::Lambda::Function'],
  ])('%s: no client, no call', async (_label, context, desired, type) => {
    expect(await run(context as UpdateContext | undefined, host(), desired, PREVIOUS, type)).toBe(
      'none'
    );
    expect(built).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('the deployment', () => {
  it('reads the live version, checks the group, creates the AppSpec deployment and waits for Succeeded', async () => {
    script.statuses = [{ status: 'InProgress' }, { status: 'Succeeded' }];
    const h = host();
    expect(await run({ updatePolicy: POLICY }, h)).toBe('shifted');
    expect(kinds()).toEqual([
      'GetAlias',
      'ListDeployments',
      'GetDeploymentGroup',
      'GetDeploymentConfig',
      'CreateDeployment',
      'GetDeployment',
      'GetDeployment',
    ]);
    expect(of('GetAlias')[0]!.input).toEqual({ FunctionName: 'my-fn', Name: 'live' });
    expect(of('ListDeployments')[0]!.input).toEqual({
      applicationName: 'my-app',
      deploymentGroupName: 'my-dg',
      includeOnlyStatuses: ACTIVE_DEPLOYMENT_STATUSES,
    });
    const create = of('CreateDeployment')[0]!.input as {
      applicationName: string;
      deploymentGroupName: string;
      revision: { revisionType: string; appSpecContent: { content: string; sha256: string } };
    };
    expect(create.applicationName).toBe('my-app');
    expect(create.deploymentGroupName).toBe('my-dg');
    expect(create.revision.revisionType).toBe('AppSpecContent');
    const { content, sha256 } = create.revision.appSpecContent;
    expect(sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(JSON.parse(content)).toEqual({
      version: 0,
      Resources: [
        {
          Alias: {
            Type: 'AWS::Lambda::Function',
            Properties: { Name: 'my-fn', Alias: 'live', CurrentVersion: '1', TargetVersion: '2' },
          },
        },
      ],
    });
    expect(h.startedAliasDeployments.get(ALIAS_ARN)).toBe('d-NEW');
    expect(destroyed).toBe(1);
  });

  it('takes CurrentVersion from the live alias, not the record', async () => {
    script.alias = [{ FunctionVersion: '5' }];
    await run({ updatePolicy: POLICY });
    const content = JSON.parse(
      (of('CreateDeployment')[0]!.input as { revision: { appSpecContent: { content: string } } })
        .revision.appSpecContent.content
    );
    expect(content.Resources[0].Alias.Properties.CurrentVersion).toBe('5');
  });

  it.each([
    ['forward: refuses before applying', undefined],
    ['revert: switches directly', true],
  ])(
    'never guesses CurrentVersion from the record when GetAlias fails (%s)',
    async (_label, replayingState) => {
      script.alias = [new Error('AccessDenied')];
      const outcome = await run(
        { updatePolicy: POLICY, ...(replayingState && { replayingState }) },
        host(),
        replayingState ? PREVIOUS : DESIRED,
        replayingState ? DESIRED : PREVIOUS
      ).catch((e: unknown) => e);
      if (replayingState) expect(outcome).toBe('none');
      else expect(isRefusedBeforeApplying(outcome, 'Alias')).toBe(true);
      expect(of('CreateDeployment')).toEqual([]);
    }
  );

  it('sends the hooks the policy names', async () => {
    await run({
      updatePolicy: {
        CodeDeployLambdaAliasUpdate: {
          ...POLICY.CodeDeployLambdaAliasUpdate,
          BeforeAllowTrafficHook: 'pre-hook',
          AfterAllowTrafficHook: 'post-hook',
        },
      },
    });
    const content = JSON.parse(
      (of('CreateDeployment')[0]!.input as { revision: { appSpecContent: { content: string } } })
        .revision.appSpecContent.content
    );
    expect(content.Hooks).toEqual([
      { BeforeAllowTraffic: 'pre-hook' },
      { AfterAllowTraffic: 'post-hook' },
    ]);
  });

  it('accepts a number-typed version', async () => {
    expect(
      await run({ updatePolicy: POLICY }, host(), { ...PREVIOUS, FunctionVersion: 2 }, PREVIOUS)
    ).toBe('shifted');
    expect(of('CreateDeployment')).toHaveLength(1);
  });

  it('does not deploy when the alias already serves the new version (a retried update)', async () => {
    script.alias = [{ FunctionVersion: '2' }];
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
    expect(kinds()).toEqual(['GetAlias', 'ListDeployments']);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'still splits traffic'
    );
  });

  it('retries a throttled CreateDeployment', async () => {
    script.create = [
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
      'd-2',
    ];
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
    expect(of('CreateDeployment')).toHaveLength(2);
  });

  it('--no-wait still waits for the deployment (the old version is deleted next)', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    script.statuses = [{ status: 'InProgress' }, { status: 'Succeeded' }];
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
    expect(of('GetDeployment')).toHaveLength(2);
  });

  it('keeps waiting through an unreadable GetDeployment', async () => {
    script.statuses = [new Error('blip'), { status: 'Succeeded' }];
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
    expect(of('GetDeployment')).toHaveLength(2);
  });
});

describe('refusals before anything is sent', () => {
  const expectRefused = (error: unknown) => {
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(of('CreateDeployment')).toEqual([]);
  };

  it('a deployment already running on the group', async () => {
    script.active = [['d-OTHER']];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expectRefused(error);
    expect(String((error as Error).message)).toContain('d-OTHER');
  });

  it('a group whose running deployments cannot be listed', async () => {
    script.active = [new Error('AccessDenied')];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expectRefused(error);
    expect(String((error as Error).message)).toContain('codedeploy:ListDeployments');
  });

  it('a CreateDeployment CodeDeploy rejects', async () => {
    script.create = [Object.assign(new Error('no such group'), { name: 'DeploymentGroupDoesNotExistException' })];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(of('CreateDeployment')).toHaveLength(1);
  });

  it.each([
    ['a missing DeploymentGroupName', { CodeDeployLambdaAliasUpdate: { ApplicationName: 'a' } }],
    [
      'an unresolved intrinsic',
      { CodeDeployLambdaAliasUpdate: { ApplicationName: { Ref: 'App' }, DeploymentGroupName: 'g' } },
    ],
    [
      'a non-string hook',
      {
        CodeDeployLambdaAliasUpdate: {
          ApplicationName: 'a',
          DeploymentGroupName: 'g',
          BeforeAllowTrafficHook: { Ref: 'Hook' },
        },
      },
    ],
  ])('an unusable policy: %s', async (_label, updatePolicy) => {
    const error = await run({ updatePolicy }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(sent).toEqual([]);
  });

  it('a target version that is not a published number ($LATEST)', async () => {
    const error = await run(
      { updatePolicy: POLICY },
      host(),
      { ...PREVIOUS, FunctionVersion: '$LATEST' },
      PREVIOUS
    ).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('a deployment that does not succeed', () => {
  it.each(['Failed', 'Stopped'])(
    'ends %s: waits for the group to settle, reads the alias and fails the update',
    async (status) => {
      script.statuses = [{ status, message: 'hook said no' }];
      script.active = [[], ['d-ROLLBACK'], []];
      script.alias = [{ FunctionVersion: '1' }, { FunctionVersion: '1' }];
      const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isRefusedBeforeApplying(error, 'Alias')).toBe(false);
      const message = String((error as Error).message);
      expect(message).toContain(`ended ${status}: hook said no`);
      expect(message).toContain('serves version 1');
      expect(of('ListDeployments')).toHaveLength(3);
      expect(of('GetAlias')).toHaveLength(2);
    }
  );

  it('says when the traffic is still split', async () => {
    script.statuses = [{ status: 'Failed' }];
    script.alias = [
      { FunctionVersion: '1' },
      { FunctionVersion: '1', RoutingConfig: { AdditionalVersionWeights: { '2': 0.1 } } },
    ];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('traffic still split');
  });

  it('stops a deployment still running at the cap, with rollback, and says so', async () => {
    setResolvedResourceTimeouts({ globalMs: 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.statuses = [{ status: 'InProgress' }];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(of('StopDeployment').map((c) => c.input)).toEqual([
      { deploymentId: 'd-NEW', autoRollbackEnabled: true },
    ]);
    expect(String((error as Error).message)).toContain('was stopped');
    expect(String((error as Error).message)).toContain('--resource-timeout AWS::Lambda::Alias=');
  });

  it('says when the stop could not be confirmed', async () => {
    setResolvedResourceTimeouts({ globalMs: 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.statuses = [{ status: 'InProgress' }];
    script.stop = new Error('AccessDenied');
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('could not be confirmed stopped');
  });

  it('masks the message', async () => {
    script.statuses = [{ status: 'Failed', message: 'secret-value leaked' }];
    const error = await run(
      { updatePolicy: POLICY },
      host(),
      DESIRED,
      PREVIOUS,
      TYPE,
      (t) => t.replaceAll('secret-value', '***')
    ).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('secret-value');
    expect(String((error as Error).message)).toContain('***');
  });
});

describe('rollback revert (replayingState)', () => {
  it('shifts back through CodeDeploy', async () => {
    script.alias = [{ FunctionVersion: '2' }];
    expect(
      await run({ updatePolicy: POLICY, replayingState: true }, host(), PREVIOUS, DESIRED)
    ).toBe('shifted');
    const content = JSON.parse(
      (of('CreateDeployment')[0]!.input as { revision: { appSpecContent: { content: string } } })
        .revision.appSpecContent.content
    );
    expect(content.Resources[0].Alias.Properties).toMatchObject({
      CurrentVersion: '2',
      TargetVersion: '1',
    });
  });

  it('does not deploy when CodeDeploy already rolled the alias back', async () => {
    script.alias = [{ FunctionVersion: '1' }];
    expect(
      await run({ updatePolicy: POLICY, replayingState: true }, host(), PREVIOUS, DESIRED)
    ).toBe('shifted');
    expect(kinds()).toEqual(['GetAlias', 'ListDeployments']);
  });

  it("stops the failed deploy's own running deployment, waits, then reverts", async () => {
    const h = host();
    h.startedAliasDeployments.set(ALIAS_ARN, 'd-OURS');
    script.alias = [{ FunctionVersion: '2' }];
    script.active = [['d-OURS'], [], []];
    expect(await run({ updatePolicy: POLICY, replayingState: true }, h, PREVIOUS, DESIRED)).toBe(
      'shifted'
    );
    expect(of('StopDeployment').map((c) => c.input)).toEqual([
      { deploymentId: 'd-OURS', autoRollbackEnabled: true },
    ]);
    expect(of('CreateDeployment')).toHaveLength(1);
  });

  it('refuses when its own deployment is still running after the stop', async () => {
    const h = host();
    // Bounded: a missing stop-once guard would stop and recurse forever.
    let sleeps = 0;
    h.sleep = (ms: number) => {
      clock += ms;
      return ++sleeps > 200 ? Promise.reject(new Error('unbounded')) : Promise.resolve();
    };
    h.startedAliasDeployments.set(ALIAS_ARN, 'd-OURS');
    script.alias = [{ FunctionVersion: '2' }];
    setResolvedResourceTimeouts({ globalMs: 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.active = [['d-OURS']];
    const error = await run(
      { updatePolicy: POLICY, replayingState: true },
      h,
      PREVIOUS,
      DESIRED
    ).catch((e: unknown) => e);
    // This process started a deployment on the alias: no refused mark.
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(false);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(of('StopDeployment')).toHaveLength(1);
    expect(of('CreateDeployment')).toEqual([]);
  });

  it('a forward deploy never stops a running deployment, even one this process started', async () => {
    const h = host();
    h.startedAliasDeployments.set(ALIAS_ARN, 'd-OURS');
    script.active = [['d-OURS']];
    const error = await run({ updatePolicy: POLICY }, h).catch((e: unknown) => e);
    // This process started a deployment on the alias: no refused mark.
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(false);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(of('StopDeployment')).toEqual([]);
  });

  it("refuses another process's running deployment", async () => {
    script.alias = [{ FunctionVersion: '2' }];
    script.active = [['d-OTHER']];
    const error = await run(
      { updatePolicy: POLICY, replayingState: true },
      host(),
      PREVIOUS,
      DESIRED
    ).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(of('StopDeployment')).toEqual([]);
  });

  it('an unusable policy warns and switches the alias directly', async () => {
    expect(
      await run(
        { updatePolicy: { CodeDeployLambdaAliasUpdate: { ApplicationName: 'a' } }, replayingState: true },
        host(),
        PREVIOUS,
        DESIRED
      )
    ).toBe('none');
    expect(sent).toEqual([]);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'switched directly'
    );
  });
});

describe('Ctrl-C', () => {
  beforeEach(() => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
  });
  afterEach(() => {
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('stops the deployment and throws the interrupt', async () => {
    script.statuses = [{ status: 'InProgress' }];
    const h = host();
    let sleeps = 0;
    h.sleep = (ms: number) => {
      clock += ms;
      sleeps++;
      process.emit('SIGINT');
      return Promise.resolve();
    };
    const error = await run({ updatePolicy: POLICY }, h).catch((e: unknown) => e);
    expect(isInterruptedWaitError(error)).toBe(true);
    expect(of('StopDeployment')).toHaveLength(1);
    // Within a second, not at the next 15-second poll.
    expect(sleeps).toBe(1);
    // C4: then a bounded wait for CodeDeploy's rollback of it, which does not
    // re-read the latched interrupt.
    const stopAt = kinds().indexOf('StopDeployment');
    expect(kinds().slice(stopAt + 1)).toEqual(['ListDeployments']);
  });

  it('C4: the settle after a Ctrl-C stop is bounded by INTERRUPT_SETTLE_MS', async () => {
    script.statuses = [{ status: 'InProgress' }];
    script.active = [[], ['d-ROLLBACK']];
    const h = host();
    let interrupted = false;
    h.sleep = (ms: number) => {
      clock += ms;
      if (!interrupted) {
        interrupted = true;
        process.emit('SIGINT');
      }
      return Promise.resolve();
    };
    const error = await run({ updatePolicy: POLICY }, h).catch((e: unknown) => e);
    expect(isInterruptedWaitError(error)).toBe(true);
    expect(logger.info.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'waiting up to 60 seconds for its rollback'
    );
    const stopAt = kinds().indexOf('StopDeployment');
    // Polls at +0 .. +60 s: five reads, then gives up and throws the interrupt.
    expect(kinds().slice(stopAt + 1)).toEqual(Array.from({ length: 5 }, () => 'ListDeployments'));
  });

  it('ends the rollback-settle wait', async () => {
    script.statuses = [{ status: 'Failed' }];
    script.active = [[], ['d-ROLLBACK']];
    const h = host();
    let sleeps = 0;
    h.sleep = (ms: number) => {
      clock += ms;
      // The deployment wait sleeps 15 times before its first read.
      if (++sleeps > 15) process.emit('SIGINT');
      return Promise.resolve();
    };
    const error = await run({ updatePolicy: POLICY }, h).catch((e: unknown) => e);
    expect(isInterruptedWaitError(error)).toBe(true);
  });
});

describe('round 1 (review) cases', () => {
  it("a revert meeting its own deployment mid-shift stops it instead of reading the alias as moved", async () => {
    const h = host();
    h.startedAliasDeployments.set(ALIAS_ARN, 'd-OURS');
    // Mid-shift the alias still names version 1; 2 takes traffic by weight.
    script.alias = [
      { FunctionVersion: '1', RoutingConfig: { AdditionalVersionWeights: { '2': 0.1 } } },
      { FunctionVersion: '1' },
    ];
    script.active = [['d-OURS'], [], []];
    expect(await run({ updatePolicy: POLICY, replayingState: true }, h, PREVIOUS, DESIRED)).toBe(
      'shifted'
    );
    expect(of('StopDeployment').map((c) => c.input)).toEqual([
      { deploymentId: 'd-OURS', autoRollbackEnabled: true },
    ]);
    expect(of('CreateDeployment')).toEqual([]);
  });

  it('a forward update whose alias already reads as the target still refuses a running deployment', async () => {
    script.alias = [{ FunctionVersion: '2' }];
    script.active = [['d-OTHER']];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
  });

  it('settles the group after stopping a deployment at the cap', async () => {
    setResolvedResourceTimeouts({ globalMs: 10 * 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.statuses = [{ status: 'InProgress' }];
    script.active = [[], ['d-ROLLBACK'], []];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('was stopped');
    const stopAt = kinds().indexOf('StopDeployment');
    expect(kinds().slice(stopAt + 1)).toEqual(['ListDeployments', 'ListDeployments']);
  });

  it('treats DeploymentAlreadyCompletedException on the stop as stopped', async () => {
    setResolvedResourceTimeouts({ globalMs: 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.statuses = [{ status: 'InProgress' }];
    script.stop = Object.assign(new Error('done'), { name: 'DeploymentAlreadyCompletedException' });
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('was stopped');
  });

  it('warns and goes on when the group is still busy at the settle cap, polling through an unreadable list', async () => {
    setResolvedResourceTimeouts({ globalMs: 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.statuses = [{ status: 'Failed' }];
    script.active = [[], new Error('blip'), ['d-ROLLBACK']];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('ended Failed');
    expect(of('ListDeployments').length).toBeGreaterThan(2);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'still runs a deployment'
    );
  });

  it('says when the alias cannot be read after a failed deployment', async () => {
    script.statuses = [{ status: 'Failed' }];
    script.alias = [{ FunctionVersion: '1' }, new Error('AccessDenied')];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('could not read the alias afterwards');
  });

  it("masks the caller's identity in CodeDeploy's failure text", async () => {
    script.statuses = [
      {
        status: 'Failed',
        message: 'User: arn:aws:sts::123456789012:assumed-role/Deployer/session is not authorized',
      },
    ];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    const message = String((error as Error).message);
    expect(message).not.toContain('123456789012');
    expect(message).not.toContain('Deployer');
  });

  it("masks the caller's identity in a rejected CreateDeployment", async () => {
    script.create = [
      Object.assign(
        new Error(
          'User: arn:aws:sts::123456789012:assumed-role/Deployer/session is not authorized to perform: codedeploy:CreateDeployment'
        ),
        { name: 'AccessDeniedException' }
      ),
    ];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    const message = String((error as Error).message);
    expect(message).toContain('CodeDeploy did not start the deployment');
    expect(message).not.toContain('123456789012');
    expect(message).not.toContain('Deployer');
  });

  it('refuses a CreateDeployment that returns no deploymentId', async () => {
    script.create = [''];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(String((error as Error).message)).toContain('returned no deploymentId');
  });

  it('gives up on a CreateDeployment throttled three times', async () => {
    const throttle = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    script.create = [throttle(), throttle(), throttle(), 'd-late'];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(of('CreateDeployment')).toHaveLength(3);
  });

  it.each([
    ['forward: refuses', undefined, 'refused'],
    ['revert: switches directly', true, 'none'],
  ])(
    'an unreadable current version (no live alias, a $LATEST record) %s',
    async (_label, replayingState, expected) => {
      script.alias = [new Error('AccessDenied')];
      const outcome = await run(
        { updatePolicy: POLICY, ...(replayingState && { replayingState }) },
        host(),
        DESIRED,
        { ...PREVIOUS, FunctionVersion: '$LATEST' }
      ).catch((e: unknown) => e);
      if (expected === 'none') expect(outcome).toBe('none');
      else expect(isRefusedBeforeApplying(outcome, 'Alias')).toBe(true);
      expect(of('CreateDeployment')).toEqual([]);
    }
  );

  it('refuses an alias whose Name cannot be read', async () => {
    const error = await run({ updatePolicy: POLICY }, host(), { ...DESIRED, Name: '' }).catch(
      (e: unknown) => e
    );
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(sent).toEqual([]);
  });

  it("names 'run the rollback again' on a revert's refusal, 'deploy again' on a forward one", async () => {
    script.active = [['d-OTHER']];
    script.alias = [{ FunctionVersion: '2' }];
    const forward = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    const revert = await run(
      { updatePolicy: POLICY, replayingState: true },
      host(),
      PREVIOUS,
      DESIRED
    ).catch((e: unknown) => e);
    expect(String((forward as Error).message)).toContain('deploy again');
    expect(String((revert as Error).message)).toContain('run the rollback again');
  });

  it("spells the AppSpec's version 0.0", () => {
    const content = aliasAppSpec('Alias', 'fn', 'live', '1', '2', {
      applicationName: 'a',
      deploymentGroupName: 'g',
    });
    expect(content.startsWith('{"version":0.0,"Resources":')).toBe(true);
    expect(JSON.parse(content).Resources[0].Alias.Properties.TargetVersion).toBe('2');
  });

  it.each([
    ['undefined', () => Promise.resolve(undefined)],
    ['empty', () => Promise.resolve('')],
    ['a rejection', () => Promise.reject(new Error('no region'))],
  ])('buildCodeDeployAliasClients refuses a region that resolves to %s', async (_label, regionOf) => {
    const error = await buildCodeDeployAliasClients(regionOf as () => Promise<string | undefined>).catch(
      (e: unknown) => e
    );
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('settleWaitCapMs keeps the margin minus 30 seconds for the settle', () => {
    expect(settleWaitCapMs(TYPE, 60 * 60_000)).toBe(90_000);
    expect(settleWaitCapMs(TYPE)).toBe(28 * 60_000);
  });
});

describe('round 2 (review) timing', () => {
  it('waits for the stopped deployment\'s rollback inside the reserve, all within the resource timeout', async () => {
    // 10 minutes: margin 60 s, deployment wait 540 s, settle reserve 30 s.
    setResolvedResourceTimeouts({ globalMs: 10 * 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.statuses = [{ status: 'InProgress' }];
    script.active = [[], ['d-ROLLBACK']];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('was stopped');
    const stopAt = kinds().indexOf('StopDeployment');
    // Polls at +0, +15 and +30 s of the 30-second reserve, then gives up.
    expect(kinds().slice(stopAt + 1)).toEqual([
      'ListDeployments',
      'ListDeployments',
      'ListDeployments',
    ]);
    expect(clock).toBeLessThanOrEqual(10 * 60_000);
  });

  it('a deployment that fails near the cap still gets the settle reserve', async () => {
    setResolvedResourceTimeouts({ globalMs: 10 * 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    // 35 reads in progress (525 s of the 540-second wait), then Failed.
    script.statuses = [
      ...Array.from({ length: 35 }, () => ({ status: 'InProgress' })),
      { status: 'Failed' },
    ];
    script.active = [[], ['d-ROLLBACK']];
    await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    const settled = kinds().slice(kinds().lastIndexOf('GetDeployment') + 1);
    // The 30-second reserve (three polls), not the 15 s the wait left over.
    expect(settled.filter((k) => k === 'ListDeployments')).toHaveLength(3);
    expect(clock).toBeLessThanOrEqual(10 * 60_000);
  });

  it('skips the settle when the stop could not be confirmed', async () => {
    setResolvedResourceTimeouts({ globalMs: 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    script.statuses = [{ status: 'InProgress' }];
    script.stop = new Error('AccessDenied');
    await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    const stopAt = kinds().indexOf('StopDeployment');
    expect(kinds().slice(stopAt + 1)).toEqual([]);
  });

  it("counts the revert's second attempt from the first attempt's start", async () => {
    setResolvedResourceTimeouts({ globalMs: 10 * 60_000 });
    // A cap this short leaves no room for the start-up reserve: skip that check.
    script.routing = new Error('config not readable');
    const h = host();
    h.startedAliasDeployments.set(ALIAS_ARN, 'd-OURS');
    script.alias = [{ FunctionVersion: '2' }];
    // Its own deployment keeps running for 20 settle polls (300 s), then ends.
    script.active = [['d-OURS'], ...Array.from({ length: 20 }, () => ['d-OURS']), []];
    script.statuses = [{ status: 'InProgress' }];
    const error = await run(
      { updatePolicy: POLICY, replayingState: true },
      h,
      PREVIOUS,
      DESIRED
    ).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('did not finish within');
    // 300 s of settle + the rest of the 540-second wait, not a fresh 540 s.
    expect(clock).toBeLessThanOrEqual(10 * 60_000);
  });

  it('warns about a split left on an alias that already serves the target', async () => {
    script.alias = [{ FunctionVersion: '2', RoutingConfig: { AdditionalVersionWeights: { '1': 0.5 } } }];
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'still splits traffic'
    );
    expect(of('CreateDeployment')).toEqual([]);
  });
});

describe('round 3 (parent review)', () => {
  const linear = (pct: number, minutes: number) => ({
    type: 'TimeBasedLinear',
    timeBasedLinear: { linearPercentage: pct, linearInterval: minutes },
  });
  const canary = (pct: number, minutes: number) => ({
    type: 'TimeBasedCanary',
    timeBasedCanary: { canaryPercentage: pct, canaryInterval: minutes },
  });

  it('C1: refuses a configuration longer than the wait before creating the deployment', async () => {
    script.routing = linear(10, 10); // 90 minutes
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(String((error as Error).message)).toContain('--resource-timeout AWS::Lambda::Alias=100m');
    expect(of('GetDeploymentGroup').map((c) => c.input)).toEqual([
      { applicationName: 'my-app', deploymentGroupName: 'my-dg' },
    ]);
    expect(of('GetDeploymentConfig').map((c) => c.input)).toEqual([{ deploymentConfigName: 'cfg' }]);
    expect(of('CreateDeployment')).toEqual([]);
  });

  it('C1: deploys a configuration that fits (canary 10% / 5 min)', async () => {
    script.routing = canary(10, 5);
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
    expect(of('CreateDeployment')).toHaveLength(1);
  });

  it('C1: a revert with a configuration too long switches the alias directly', async () => {
    script.alias = [{ FunctionVersion: '2' }];
    script.routing = canary(10, 30);
    setResolvedResourceTimeouts({ globalMs: 20 * 60_000 });
    expect(
      await run({ updatePolicy: POLICY, replayingState: true }, host(), PREVIOUS, DESIRED)
    ).toBe('none');
    expect(of('CreateDeployment')).toEqual([]);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'with its hooks skipped'
    );
  });

  it('C1: an unreadable configuration warns and goes on (the cap still bounds the wait)', async () => {
    script.routing = new Error('AccessDenied');
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
    expect(of('CreateDeployment')).toHaveLength(1);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'could not read deployment group'
    );
  });

  it.each([
    [{ type: 'AllAtOnce' }, 0],
    [{ type: 'TimeBasedCanary', timeBasedCanary: { canaryPercentage: 10, canaryInterval: 5 } }, 5 * 60_000],
    [{ type: 'TimeBasedLinear', timeBasedLinear: { linearPercentage: 10, linearInterval: 10 } }, 90 * 60_000],
    [{ type: 'TimeBasedLinear', timeBasedLinear: { linearPercentage: 10, linearInterval: 3 } }, 27 * 60_000],
    [{ type: 'TimeBasedLinear', timeBasedLinear: { linearPercentage: 33, linearInterval: 1 } }, 3 * 60_000],
    [{ type: 'TimeBasedCanary' }, undefined],
    [undefined, undefined],
  ])('trafficRoutingMs(%j) = %s', (config, expected) => {
    expect(trafficRoutingMs(config as Record<string, unknown> | undefined)).toBe(expected);
  });

  it('C3: a revert clears a split a stopped deployment left, then reads the alias as reverted', async () => {
    script.alias = [{ FunctionVersion: '1', RoutingConfig: { AdditionalVersionWeights: { '2': 0.1 } } }];
    expect(
      await run({ updatePolicy: POLICY, replayingState: true }, host(), PREVIOUS, DESIRED)
    ).toBe('shifted');
    expect(of('UpdateAlias').map((c) => c.input)).toEqual([
      { FunctionName: 'my-fn', Name: 'live', RoutingConfig: { AdditionalVersionWeights: {} } },
    ]);
    expect(of('CreateDeployment')).toEqual([]);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'still splits traffic'
    );
  });

  it('C3: a revert keeps a split the restored state declares', async () => {
    script.alias = [{ FunctionVersion: '1', RoutingConfig: { AdditionalVersionWeights: { '2': 0.1 } } }];
    await run(
      { updatePolicy: POLICY, replayingState: true },
      host(),
      { ...PREVIOUS, RoutingConfig: { AdditionalVersionWeights: { '2': 0.1 } } },
      DESIRED
    );
    expect(of('UpdateAlias')).toEqual([]);
  });

  it('C3: a forward update never clears a split', async () => {
    script.alias = [{ FunctionVersion: '2', RoutingConfig: { AdditionalVersionWeights: { '1': 0.5 } } }];
    await run({ updatePolicy: POLICY });
    expect(of('UpdateAlias')).toEqual([]);
  });

  it('C3: a failed clear fails the revert (non-retryable, not marked refused) before any deployment', async () => {
    script.alias = [{ FunctionVersion: '1', RoutingConfig: { AdditionalVersionWeights: { '2': 0.1 } } }];
    script.updateAlias = Object.assign(
      new Error('User: arn:aws:sts::123456789012:assumed-role/Deployer/s is not authorized'),
      { name: 'AccessDeniedException' }
    );
    const error = await run(
      { updatePolicy: POLICY, replayingState: true },
      host(),
      PREVIOUS,
      DESIRED
    ).catch((e: unknown) => e);
    // R2: the request may have landed (a timeout), so no refused-before-applying mark.
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(false);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(String((error as Error).message)).not.toContain('123456789012');
    expect(of('CreateDeployment')).toEqual([]);
  });

  it('R1: a revert that cannot read the alias still stops its own running deployment first', async () => {
    const h = host();
    h.startedAliasDeployments.set(ALIAS_ARN, 'd-OURS');
    script.alias = [new Error('AccessDenied')];
    script.active = [['d-OURS'], [], []];
    expect(
      await run({ updatePolicy: POLICY, replayingState: true }, h, PREVIOUS, DESIRED)
    ).toBe('none');
    expect(of('StopDeployment').map((c) => c.input)).toEqual([
      { deploymentId: 'd-OURS', autoRollbackEnabled: true },
    ]);
    expect(of('CreateDeployment')).toEqual([]);
  });

  it.each([
    ['a throttle', Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })],
    ['a failure classified by its text', new Error('a concurrent update operation is in progress')],
  ])(
    'R1: a transient GetAlias failure (%s) is left to the update retry, nothing else sent',
    async (_label, failure) => {
      script.alias = [failure];
      const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(isMarkedNonRetryable(error)).toBe(false);
      // withRetry's own classifier retries it (the cause's text counts).
      expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
      // Not marked refused: an earlier attempt of the update may have shifted.
      expect(isRefusedBeforeApplying(error, 'Alias')).toBe(false);
      expect(kinds()).toEqual(['GetAlias']);
    }
  );

  it('nit: no split warning when the state declares the RoutingConfig', async () => {
    script.alias = [{ FunctionVersion: '2', RoutingConfig: { AdditionalVersionWeights: { '1': 0.5 } } }];
    await run({ updatePolicy: POLICY }, host(), {
      ...DESIRED,
      RoutingConfig: { AdditionalVersionWeights: { '1': 0.5 } },
    });
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'still splits traffic'
    );
  });

  it('C1: the refusal names the timeout first, then the flag-free alternative', async () => {
    script.routing = linear(10, 10);
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    const message = String((error as Error).message);
    expect(message).toContain(
      'Raise the timeout with --resource-timeout AWS::Lambda::Alias=100m, or deploy without --update-policy'
    );
    expect(message).not.toContain('Fix the template');
  });

  it('C1: a configuration that fills the wait with the start-up reserve is refused', async () => {
    // 10 minutes: margin 60 s, so the wait is 9 minutes = a 4-minute canary + 5.
    setResolvedResourceTimeouts({ globalMs: 10 * 60_000 });
    script.routing = canary(10, 4);
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
  });

  it('C1: one minute less fits', async () => {
    setResolvedResourceTimeouts({ globalMs: 10 * 60_000 });
    script.routing = canary(10, 3);
    expect(await run({ updatePolicy: POLICY })).toBe('shifted');
  });

  it('C1: LINEAR_10PERCENT_EVERY_3MINUTES (27 min) no longer passes the default 28-minute wait', async () => {
    script.routing = linear(10, 3);
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(String((error as Error).message)).toContain('--resource-timeout AWS::Lambda::Alias=37m');
  });

  it('C1: a group with no configuration name skips the check', async () => {
    const h = host();
    const real = h.codeDeployAliasClients;
    h.codeDeployAliasClients = async () => {
      const c = await real();
      const send = c.codeDeploy.send;
      c.codeDeploy = {
        send: (cmd: unknown) =>
          (cmd as Cmd).kind === 'GetDeploymentGroup'
            ? (sent.push(cmd as Cmd), Promise.resolve({ deploymentGroupInfo: {} }))
            : send(cmd),
      };
      return c;
    };
    script.routing = linear(10, 10);
    expect(await run({ updatePolicy: POLICY }, h)).toBe('shifted');
    expect(of('GetDeploymentConfig')).toEqual([]);
    expect(of('CreateDeployment')).toHaveLength(1);
  });

  it('C3: after clearing the split, a revert still shifts back a version that moved', async () => {
    script.alias = [{ FunctionVersion: '2', RoutingConfig: { AdditionalVersionWeights: { '1': 0.1 } } }];
    expect(
      await run({ updatePolicy: POLICY, replayingState: true }, host(), PREVIOUS, DESIRED)
    ).toBe('shifted');
    const order = kinds();
    expect(order.indexOf('UpdateAlias')).toBeGreaterThan(-1);
    expect(order.indexOf('UpdateAlias')).toBeLessThan(order.indexOf('CreateDeployment'));
  });

  it('a refusal after this process already started a deployment on the alias is not marked refused', async () => {
    const h = host();
    h.startedAliasDeployments.set(ALIAS_ARN, 'd-EARLIER');
    script.active = [['d-OTHER']];
    const error = await run({ updatePolicy: POLICY }, h).catch((e: unknown) => e);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(false);
  });

  it('L1: a listing that never ends reads as unreadable and refuses', async () => {
    script.activePages = Array.from({ length: 25 }, () => ({ deployments: [], nextToken: 'again' }));
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(String((error as Error).message)).toContain('could not list the running deployments');
    expect(of('ListDeployments')).toHaveLength(20);
  });

  it('L1: reads every ListDeployments page', async () => {
    script.activePages = [{ deployments: [], nextToken: 't1' }, { deployments: ['d-PAGE2'] }];
    const error = await run({ updatePolicy: POLICY }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(String((error as Error).message)).toContain('d-PAGE2');
    expect(of('ListDeployments')[1]!.input).toMatchObject({ nextToken: 't1' });
  });
});

describe('helpers', () => {
  it('readAliasDeploymentPolicy', () => {
    expect(readAliasDeploymentPolicy(undefined)).toBeUndefined();
    expect(readAliasDeploymentPolicy(POLICY)).toEqual({
      applicationName: 'my-app',
      deploymentGroupName: 'my-dg',
    });
    expect(readAliasDeploymentPolicy({ CodeDeployLambdaAliasUpdate: 'x' })).toHaveProperty(
      'unusable'
    );
  });

  it('functionNameOf prefers the alias ARN, then the declared name or ARN', () => {
    expect(functionNameOf(ALIAS_ARN, 'ignored')).toBe('my-fn');
    expect(functionNameOf('not-an-arn', 'arn:aws:lambda:us-east-1:1:function:other')).toBe('other');
    expect(functionNameOf('not-an-arn', 'plain')).toBe('plain');
    expect(functionNameOf('not-an-arn', '123456789012:function:partial')).toBe('partial');
    expect(functionNameOf('not-an-arn', 'named:live')).toBe('named');
    expect(functionNameOf('not-an-arn', undefined)).toBeUndefined();
  });

  it('deploymentWaitCapMs keeps a margin inside the resource timeout', () => {
    expect(deploymentWaitCapMs(TYPE)).toBe(28 * 60_000);
    setResolvedResourceTimeouts({ globalMs: 10 * 60_000 });
    expect(deploymentWaitCapMs(TYPE, 60_000)).toBe(8 * 60_000);
  });
});
