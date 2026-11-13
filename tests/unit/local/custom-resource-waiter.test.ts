import { describe, it, expect, vi } from 'vite-plus/test';

import {
  matchWaiterDefinition,
  runWaiterPlan,
  templateDefinitionWithTargets,
  type WaiterPlan,
  type WaiterTaskResult,
} from '../../../src/local/custom-resource-waiter.js';

/**
 * go-to-k/cdkd#6213: the `cr.Provider` waiter state machine run locally — the
 * template / deployed definition match that names each task's function, and
 * the Retry / Catch interpreter.
 */

const IS_COMPLETE_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:App-isComplete-abc';
const ON_TIMEOUT_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:App-onTimeout-def';

/** The `DefinitionString` CDK's `WaiterStateMachine` synthesizes. */
function cdkWaiterTemplate(extra = '') {
  return {
    Type: 'AWS::StepFunctions::StateMachine',
    Properties: {
      DefinitionString: {
        'Fn::Join': [
          '',
          [
            '{"StartAt":"framework-isComplete-task","States":{"framework-isComplete-task":{"End":true,"Retry":[{"ErrorEquals":["States.ALL"],"IntervalSeconds":5,"MaxAttempts":360,"BackoffRate":1}],"Catch":[{"ErrorEquals":["States.ALL"],"Next":"framework-onTimeout-task"}],"Type":"Task"' +
              extra +
              ',"Resource":"',
            { 'Fn::GetAtt': ['PframeworkisComplete', 'Arn'] },
            '"},"framework-onTimeout-task":{"End":true,"Type":"Task","Resource":"',
            { 'Fn::GetAtt': ['PframeworkonTimeout', 'Arn'] },
            '"}}}',
          ],
        ],
      },
    },
  };
}

function deployedDefinition(extra = '') {
  return (
    '{"StartAt":"framework-isComplete-task","States":{"framework-isComplete-task":{"End":true,"Retry":[{"ErrorEquals":["States.ALL"],"IntervalSeconds":5,"MaxAttempts":360,"BackoffRate":1}],"Catch":[{"ErrorEquals":["States.ALL"],"Next":"framework-onTimeout-task"}],"Type":"Task"' +
    extra +
    `,"Resource":"${IS_COMPLETE_ARN}"},"framework-onTimeout-task":{"End":true,"Type":"Task","Resource":"${ON_TIMEOUT_ARN}"}}}`
  );
}

describe('matchWaiterDefinition', () => {
  it("maps each task of CDK's waiter to its template function and deployed ARN", () => {
    const tpl = templateDefinitionWithTargets(cdkWaiterTemplate() as never)!;
    const plan = matchWaiterDefinition(tpl, deployedDefinition());
    expect('reason' in plan).toBe(false);
    const p = plan as WaiterPlan;
    expect(p.startAt).toBe('framework-isComplete-task');
    expect(p.states.get('framework-isComplete-task')).toMatchObject({
      targetLogicalId: 'PframeworkisComplete',
      functionArn: IS_COMPLETE_ARN,
      end: true,
      catch: [{ ErrorEquals: ['States.ALL'], Next: 'framework-onTimeout-task' }],
    });
    expect(p.states.get('framework-onTimeout-task')).toMatchObject({
      targetLogicalId: 'PframeworkonTimeout',
      functionArn: ON_TIMEOUT_ARN,
    });
  });

  it('declines a field it does not run (Parameters / ResultPath)', () => {
    for (const extra of [',"Parameters":{"a":1}', ',"ResultPath":"$.x"']) {
      const tpl = templateDefinitionWithTargets(cdkWaiterTemplate(extra) as never)!;
      expect(matchWaiterDefinition(tpl, deployedDefinition(extra))).toHaveProperty('reason');
    }
  });

  it('declines a deployed definition that differs from the template beyond the ARNs', () => {
    const tpl = templateDefinitionWithTargets(cdkWaiterTemplate() as never)!;
    const changed = deployedDefinition().replace('"MaxAttempts":360', '"MaxAttempts":3');
    expect(matchWaiterDefinition(tpl, changed)).toHaveProperty('reason');
  });

  it('declines a Resource that is not a function ARN (a service integration)', () => {
    const tpl = templateDefinitionWithTargets(cdkWaiterTemplate() as never)!;
    const integration = deployedDefinition().replace(
      IS_COMPLETE_ARN,
      'arn:aws:states:::lambda:invoke'
    );
    expect(matchWaiterDefinition(tpl, integration)).toHaveProperty('reason');
  });

  it('declines a definition with substitutions or another intrinsic', () => {
    const subs = cdkWaiterTemplate();
    (subs.Properties as Record<string, unknown>)['DefinitionSubstitutions'] = { a: 'b' };
    expect(templateDefinitionWithTargets(subs as never)).toBeUndefined();
    expect(
      templateDefinitionWithTargets({
        Type: 'AWS::StepFunctions::StateMachine',
        Properties: { DefinitionString: { 'Fn::Sub': '{}' } },
      } as never)
    ).toBeUndefined();
  });
});

function plan(): WaiterPlan {
  const tpl = templateDefinitionWithTargets(cdkWaiterTemplate() as never)!;
  const p = matchWaiterDefinition(tpl, deployedDefinition());
  if ('reason' in p) throw new Error(p.reason);
  // A short retry budget keeps the test small.
  p.states.get('framework-isComplete-task')!.retry = [
    { ErrorEquals: ['States.ALL'], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 1.5 },
  ];
  return p;
}

describe('runWaiterPlan', () => {
  it('retries a failing task with the backoff, then succeeds', async () => {
    const results: WaiterTaskResult[] = [
      { ok: false, error: 'Retry', cause: '{}' },
      { ok: false, error: 'Retry', cause: '{}' },
      { ok: true, output: { done: 1 } },
    ];
    const runTask = vi.fn(() => Promise.resolve(results.shift()!));
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runWaiterPlan(plan(), { in: 1 }, runTask, sleep);
    expect(outcome).toEqual({ status: 'SUCCEEDED', output: { done: 1 } });
    expect(runTask).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([2000, 3000]);
    expect(runTask.mock.calls.every((c) => (c as unknown[])[0] === 'framework-isComplete-task')).toBe(
      true
    );
  });

  it('after MaxAttempts, catches into the onTimeout task with { Error, Cause }', async () => {
    const cause = JSON.stringify({ errorType: 'Retry', errorMessage: '{"RequestType":"Create"}' });
    const runTask = vi.fn((state: string, _task: unknown, _input: unknown) =>
      Promise.resolve<WaiterTaskResult>(
        state === 'framework-isComplete-task'
          ? { ok: false, error: 'Retry', cause }
          : { ok: true, output: null }
      )
    );
    const outcome = await runWaiterPlan(plan(), { in: 1 }, runTask, () => Promise.resolve());
    expect(outcome.status).toBe('SUCCEEDED');
    // 1 attempt + 3 retries, then onTimeout once.
    expect(runTask).toHaveBeenCalledTimes(5);
    expect(runTask.mock.calls[4]![0]).toBe('framework-onTimeout-task');
    expect(runTask.mock.calls[4]![2]).toEqual({ Error: 'Retry', Cause: cause });
  });

  it('fails the execution when no Catch matches', async () => {
    const p = plan();
    p.states.get('framework-isComplete-task')!.catch = [];
    p.states.get('framework-isComplete-task')!.retry = [];
    const outcome = await runWaiterPlan(
      p,
      {},
      () => Promise.resolve<WaiterTaskResult>({ ok: false, error: 'Boom', cause: 'c' }),
      () => Promise.resolve()
    );
    expect(outcome).toEqual({ status: 'FAILED', error: 'Boom', cause: 'c' });
  });
});
