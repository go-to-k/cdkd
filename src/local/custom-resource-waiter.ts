/**
 * The `cr.Provider` waiter state machine (the `isCompleteHandler` path), run
 * on this machine under `--aws-emulator` (go-to-k/cdkd#6213).
 *
 * With `isCompleteHandler`, the framework's `onEvent` function starts a Step
 * Functions execution whose two Lambda tasks (the framework's `isComplete` and
 * `onTimeout` functions) poll the user's handler and submit the response. On
 * AWS Emulator those tasks run in the emulator's embedded runtime, which has
 * no `https` to submit it with. This module reads that state machine and runs
 * it with each task in the official Lambda runtime image.
 *
 * Only the shape CDK's `WaiterStateMachine` synthesizes is accepted: `Task`
 * states whose `Resource` is a function ARN (`Fn::GetAtt [Fn, Arn]` in the
 * template), with `Retry` / `Catch` / `Next` / `End`. Anything else
 * (`Parameters`, `ResultPath`, `Wait`, `Choice`, an integration ARN, ...) is
 * declined and the execution starts on the emulator as before.
 */

import type { TemplateResource } from '../types/resource.js';

/** A `Retry` entry of the accepted shape. */
export interface WaiterRetrier {
  ErrorEquals: string[];
  IntervalSeconds?: number;
  MaxAttempts?: number;
  BackoffRate?: number;
}

/** A `Catch` entry of the accepted shape. */
export interface WaiterCatcher {
  ErrorEquals: string[];
  Next: string;
}

/** One `Task` state, with the template function its `Resource` names. */
export interface WaiterTask {
  /** The function's logical id in the template. */
  targetLogicalId: string;
  /** The deployed function's ARN (the resolved definition's `Resource`). */
  functionArn: string;
  next?: string;
  end: boolean;
  retry: WaiterRetrier[];
  catch: WaiterCatcher[];
}

export interface WaiterPlan {
  startAt: string;
  states: Map<string, WaiterTask>;
}

const TARGET_PREFIX = 'cdkd-local-target:';
const TOP_LEVEL_KEYS = new Set(['StartAt', 'States', 'Comment']);
const STATE_KEYS = new Set(['Type', 'Resource', 'End', 'Next', 'Retry', 'Catch', 'Comment']);
const RETRY_KEYS = new Set(['ErrorEquals', 'IntervalSeconds', 'MaxAttempts', 'BackoffRate']);
const CATCH_KEYS = new Set(['ErrorEquals', 'Next']);

function getAttArnLogicalId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]![0] !== 'Fn::GetAtt') return undefined;
  const getAtt = entries[0]![1];
  if (Array.isArray(getAtt) && getAtt.length === 2 && getAtt[1] === 'Arn') {
    return typeof getAtt[0] === 'string' ? getAtt[0] : undefined;
  }
  if (typeof getAtt === 'string' && getAtt.endsWith('.Arn')) return getAtt.slice(0, -'.Arn'.length);
  return undefined;
}

/**
 * The template's `DefinitionString` as text, each `Fn::GetAtt [Fn, Arn]`
 * replaced by a marker naming `Fn`; `undefined` for any other intrinsic.
 */
export function templateDefinitionWithTargets(stateMachine: TemplateResource): string | undefined {
  const props = stateMachine.Properties ?? {};
  if (props['DefinitionSubstitutions'] !== undefined) return undefined;
  const def = props['DefinitionString'];
  if (typeof def === 'string') return def;
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return undefined;
  const join = (def as Record<string, unknown>)['Fn::Join'];
  if (Object.keys(def).length !== 1 || !Array.isArray(join) || join.length !== 2) return undefined;
  const [sep, parts] = join as [unknown, unknown];
  if (typeof sep !== 'string' || !Array.isArray(parts)) return undefined;
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      out.push(part);
      continue;
    }
    const target = getAttArnLogicalId(part);
    if (target === undefined || !/^[A-Za-z0-9]+$/.test(target)) return undefined;
    out.push(`${TARGET_PREFIX}${target}`);
  }
  return out.join(sep);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function onlyKeys(v: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(v).every((k) => allowed.has(k));
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string');
}

function optionalNumber(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

/**
 * Match the template's definition (with target markers) against the
 * deployed one (with resolved ARNs). Every field but `Resource` must be
 * identical, and only the accepted shape passes. Returns the plan, or a
 * reason it was declined.
 */
export function matchWaiterDefinition(
  templateDefinition: string,
  deployedDefinition: string
): WaiterPlan | { reason: string } {
  let tpl: unknown;
  let dep: unknown;
  try {
    tpl = JSON.parse(templateDefinition);
    dep = JSON.parse(deployedDefinition);
  } catch {
    return { reason: 'its definition is not JSON' };
  }
  if (!isRecord(tpl) || !isRecord(dep)) return { reason: 'its definition is not an object' };
  if (!onlyKeys(tpl, TOP_LEVEL_KEYS) || !onlyKeys(dep, TOP_LEVEL_KEYS)) {
    return { reason: 'its definition uses a field cdkd does not run locally' };
  }
  if (typeof tpl['StartAt'] !== 'string' || tpl['StartAt'] !== dep['StartAt']) {
    return { reason: 'its StartAt does not match the deployed one' };
  }
  const tplStates = tpl['States'];
  const depStates = dep['States'];
  if (!isRecord(tplStates) || !isRecord(depStates)) return { reason: 'it has no States' };
  const names = Object.keys(tplStates);
  if (names.length !== Object.keys(depStates).length) {
    return { reason: 'its states do not match the deployed ones' };
  }
  const states = new Map<string, WaiterTask>();
  for (const name of names) {
    const t = tplStates[name];
    const d = Object.hasOwn(depStates, name) ? depStates[name] : undefined;
    if (!isRecord(t) || !isRecord(d))
      return { reason: 'its states do not match the deployed ones' };
    if (!onlyKeys(t, STATE_KEYS) || t['Type'] !== 'Task') {
      return { reason: `state ${name} is not a plain Lambda Task` };
    }
    const resource = t['Resource'];
    if (typeof resource !== 'string' || !resource.startsWith(TARGET_PREFIX)) {
      return {
        reason: `state ${name} does not name a function of the template`,
      };
    }
    const arn = d['Resource'];
    // cdkd-arn-display: a function ARN tested, never printed.
    if (typeof arn !== 'string' || !/^arn:[^:]+:lambda:[^:]*:[^:]*:function:[^:]+$/.test(arn)) {
      return { reason: `state ${name} does not run a function` };
    }
    const { Resource: _t, ...tRest } = t;
    const { Resource: _d, ...dRest } = d;
    if (JSON.stringify(tRest) !== JSON.stringify(dRest)) {
      return { reason: `state ${name} does not match the deployed one` };
    }
    const retry = t['Retry'] ?? [];
    const catchers = t['Catch'] ?? [];
    if (!Array.isArray(retry) || !Array.isArray(catchers)) {
      return { reason: `state ${name} has a malformed Retry or Catch` };
    }
    for (const r of retry) {
      if (
        !isRecord(r) ||
        !onlyKeys(r, RETRY_KEYS) ||
        !isStringArray(r['ErrorEquals']) ||
        !optionalNumber(r['IntervalSeconds']) ||
        !optionalNumber(r['MaxAttempts']) ||
        !optionalNumber(r['BackoffRate'])
      ) {
        return {
          reason: `state ${name} has a Retry cdkd does not run locally`,
        };
      }
    }
    for (const c of catchers) {
      if (
        !isRecord(c) ||
        !onlyKeys(c, CATCH_KEYS) ||
        !isStringArray(c['ErrorEquals']) ||
        typeof c['Next'] !== 'string'
      ) {
        return {
          reason: `state ${name} has a Catch cdkd does not run locally`,
        };
      }
    }
    const end = t['End'] === true;
    const next = t['Next'];
    if (end === (typeof next === 'string')) {
      return { reason: `state ${name} must have exactly one of End and Next` };
    }
    states.set(name, {
      targetLogicalId: resource.slice(TARGET_PREFIX.length),
      functionArn: arn,
      end,
      ...(typeof next === 'string' && { next }),
      retry: retry as WaiterRetrier[],
      catch: catchers as WaiterCatcher[],
    });
  }
  for (const [name, task] of states) {
    const targets = [task.next, ...task.catch.map((c) => c.Next)].filter(
      (n): n is string => n !== undefined
    );
    if (targets.some((n) => !states.has(n))) {
      return { reason: `state ${name} moves to a state that does not exist` };
    }
  }
  if (!states.has(tpl['StartAt'])) return { reason: 'its StartAt names no state' };
  return { startAt: tpl['StartAt'], states };
}

/** One task attempt: the function's answer, or its error. */
export type WaiterTaskResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string; cause: string };

export type WaiterOutcome =
  | { status: 'SUCCEEDED'; output: unknown }
  | { status: 'FAILED'; error: string; cause: string };

function errorMatches(errorEquals: readonly string[], error: string): boolean {
  return errorEquals.some(
    (e) =>
      e === 'States.ALL' || e === error || (e === 'States.TaskFailed' && error !== 'States.Timeout')
  );
}

/** Upper bound on transitions, so a definition that loops cannot run forever. */
const MAX_TRANSITIONS = 100_000;

/**
 * Run the plan as Step Functions would: each `Task` passes its input to the
 * function and its answer on; a failed attempt is retried by the first
 * matching `Retry` entry (`IntervalSeconds` × `BackoffRate`^n, up to
 * `MaxAttempts`, counts kept per entry and reset on a state change), then
 * caught by the first matching `Catch` entry, whose `Next` state gets
 * `{ Error, Cause }` (the default `ResultPath` of `$`).
 */
export async function runWaiterPlan(
  plan: WaiterPlan,
  input: unknown,
  runTask: (stateName: string, task: WaiterTask, input: unknown) => Promise<WaiterTaskResult>,
  sleep: (ms: number) => Promise<void>
): Promise<WaiterOutcome> {
  let stateName = plan.startAt;
  let stateInput = input;
  let attempts = new Map<WaiterRetrier, number>();
  for (let transitions = 0; transitions < MAX_TRANSITIONS; transitions++) {
    const task = plan.states.get(stateName)!;
    const result = await runTask(stateName, task, stateInput);
    if (result.ok) {
      if (task.end) return { status: 'SUCCEEDED', output: result.output };
      stateName = task.next!;
      stateInput = result.output;
      attempts = new Map();
      continue;
    }
    const retrier = task.retry.find((r) => errorMatches(r.ErrorEquals, result.error));
    if (retrier !== undefined) {
      const done = attempts.get(retrier) ?? 0;
      if (done < (retrier.MaxAttempts ?? 3)) {
        attempts.set(retrier, done + 1);
        const interval = retrier.IntervalSeconds ?? 1;
        const backoff = retrier.BackoffRate ?? 2;
        await sleep(interval * Math.pow(backoff, done) * 1000);
        continue;
      }
    }
    const catcher = task.catch.find((c) => errorMatches(c.ErrorEquals, result.error));
    if (catcher === undefined)
      return { status: 'FAILED', error: result.error, cause: result.cause };
    stateName = catcher.Next;
    stateInput = { Error: result.error, Cause: result.cause };
    attempts = new Map();
  }
  return {
    status: 'FAILED',
    error: 'States.Runtime',
    cause: 'too many state transitions',
  };
}
