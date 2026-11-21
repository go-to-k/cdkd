/**
 * go-to-k/cdkd#6705: the deploy engine's side of the signal receiver
 * (`signal-receiver.ts`): find or create it before the diff, arm this
 * deploy's waiters before the DAG, wait after a covered create is journaled,
 * settle at the deploy's end. Design: docs/design/6705-cloudformation-signal-receiver.md.
 */

import type { DeployEngine } from '../deploy-engine.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../types/state.js';
import { markNonRetryable } from '../retryable-errors.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { isSecretValuedAttribute, isSensitiveAttributeName } from '../../utils/stringify.js';
import { isCustomResourceType } from '../../provisioning/custom-resource-secure-references.js';
import type { UpdateContext } from '../../types/resource.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import { buildResolverContext } from './resolver-context.js';
import { noEchoParameterNamesOf } from './noecho.js';
import { warnUnhonoredCreationPolicy } from './update-policy.js';
import { canReceiveFor, SignalReceiver, signalPlanOf } from './signal-receiver.js';
import { safeMsg } from '../../utils/display-safe.js';

// Built on first use: a module-level construction runs at import time, under
// every test's logger mock.
let parser: TemplateParser | undefined;
const templateParser = (): TemplateParser => (parser ??= new TemplateParser());

/**
 * Before the diff: when the template declares a `CreationPolicy` signal or
 * `cfn-init` metadata, find or create the stack's receiver and record its
 * StackId (`AWS::StackId` resolves to it from here on). A stack that recorded
 * one keeps it even when the template no longer asks. `true` when the record
 * changed (the no-change path must still save it). `--dry-run` makes none.
 */
export async function ensureSignalReceiver(
  engine: DeployEngine,
  stackName: string,
  template: CloudFormationTemplate,
  currentState: StackState
): Promise<boolean> {
  const recorded = currentState.signalReceiverStackId;
  engine.signalReceiverStackId = recorded;
  const { candidates } = signalPlanOf(template);
  if (candidates.size === 0 || engine.options.dryRun || !canReceiveFor(stackName)) {
    return false;
  }
  const receiver = new SignalReceiver(
    stackName,
    candidates,
    () => getAwsClients().cloudFormation,
    engine.logger
  );
  const stackId = await receiver.ensure(recorded);
  if (stackId === undefined) return false;
  engine.signalReceiver = receiver;
  engine.signalReceiverStackId = stackId;
  if (stackId === recorded) return false;
  currentState.signalReceiverStackId = stackId;
  return true;
}

/**
 * Before the DAG: arm a waiter for every CREATE, and every UPDATE the diff
 * already knows replaces, of a resource declaring a `ResourceSignal`.
 */
export async function armSignalReceiver(
  engine: DeployEngine,
  stackName: string,
  template: CloudFormationTemplate,
  changes: ReadonlyMap<string, ResourceChange>,
  stateResources: Record<string, ResourceState>,
  parameterValues: Record<string, unknown> | undefined,
  conditions: Record<string, boolean> | undefined
): Promise<void> {
  const receiver = engine.signalReceiver;
  if (receiver === undefined) return;
  const armIds = new Set<string>();
  // The receiver is updated only for a row creating, replacing or changing a
  // resource it serves: an unrelated change costs no CloudFormation update.
  let touchesCandidate = false;
  for (const change of changes.values()) {
    if (change.changeType !== 'NO_CHANGE' && receiver.candidate(change.logicalId) !== undefined) {
      touchesCandidate = true;
    }
    const creates =
      change.changeType === 'CREATE' ||
      (change.changeType === 'UPDATE' &&
        change.propertyChanges?.some((pc) => pc.requiresReplacement) === true);
    if (creates && (receiver.candidate(change.logicalId)?.count ?? 0) > 0) {
      armIds.add(change.logicalId);
    }
  }
  if (!touchesCandidate) return;
  await receiver.arm(armIds, (id) =>
    resolveTemplateMetadata(
      engine,
      id,
      stateResources,
      stackName,
      template,
      parameterValues,
      conditions
    )
  );
}

/**
 * After a covered resource's create (or replacement) is journaled as
 * completed: wait for its signals. A failure stops the deploy, so the
 * rollback reverts the completed operation (deleting the created resource).
 */
export async function awaitCreationSignals(
  engine: DeployEngine,
  logicalId: string,
  startedAt: number,
  created: boolean
): Promise<void> {
  const receiver = engine.signalReceiver;
  if (receiver === undefined || !receiver.isArmed(logicalId)) return;
  if (!created) {
    receiver.disarm(logicalId);
    return;
  }
  try {
    await receiver.awaitSignals(logicalId, startedAt, () => engine.interrupted);
  } catch (error) {
    engine.interrupted = true;
    engine.interruptCause ??= 'sibling-failure';
    throw error;
  }
}

/** #6437's "CreationPolicy is not honored" warning, unless the receiver waits on it. */
export function warnUnwaitedCreationPolicy(
  engine: DeployEngine,
  logicalId: string,
  template: CloudFormationTemplate | undefined
): void {
  const resource = template?.Resources?.[logicalId];
  if (
    resource?.CreationPolicy === undefined ||
    engine.signalReceiver?.isArmed(logicalId) === true
  ) {
    return;
  }
  if (template !== undefined && signalPlanOf(template).unsigned.includes(logicalId)) {
    engine.logger.warn(
      safeMsg`${logicalId}: CreationPolicy is not honored; its user data calls cfn-init / cfn-signal without credentials, which CloudFormation answers only for its own stacks' instances. Pass --role (CDK: initOptions.includeRole: true) and cdkd waits for the signals.`
    );
    return;
  }
  warnUnhonoredCreationPolicy(engine.logger, logicalId, resource);
}

/**
 * A resource's template `Metadata`, resolved against the deploy's state, for
 * the receiver (a CloudFormation TEMPLATE, readable through GetTemplate). No
 * secret may be resolved into it: a secret `{{resolve:...}}` reference stays
 * a token, as CloudFormation keeps it in its own template, and metadata
 * reading a `NoEcho` parameter or attribute is refused (the resource is then
 * not covered). Throws when a reference does not resolve yet.
 */
export async function resolveTemplateMetadata(
  engine: DeployEngine,
  logicalId: string,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template: CloudFormationTemplate,
  parameterValues: Record<string, unknown> | undefined,
  conditions: Record<string, boolean> | undefined
): Promise<unknown> {
  const metadata = template.Resources?.[logicalId]?.Metadata;
  if (metadata === undefined) return undefined;
  const noEchoParameters = noEchoParameterNamesOf(template);
  const noEchoAttributes = engine.noEchoRun.noEchoAttributeResources;
  for (const ref of templateParser().extractReferences(metadata)) {
    if (noEchoParameters.has(ref) || noEchoAttributes.has(ref)) {
      throw new Error(`${logicalId}'s Metadata reads a NoEcho value`);
    }
  }
  // A credential attribute (an access key's `SecretAccessKey`, a client
  // secret, an API key) is recorded in plaintext and carries no NoEcho mark,
  // and a custom resource's `Data` certifies nothing: CloudFormation keeps
  // such a read unresolved in its template, so cdkd refuses to resolve one.
  for (const [ref, attribute] of getAttReadsOf(metadata)) {
    const type = template.Resources?.[ref]?.Type;
    if (
      isSensitiveAttributeName(attribute) ||
      isSecretValuedAttribute(type, attribute) ||
      (type !== undefined && isCustomResourceType(type))
    ) {
      throw new Error(`${logicalId}'s Metadata reads a credential-bearing attribute`);
    }
  }
  const context = buildResolverContext(
    engine.resolverContextDeps(),
    {
      template,
      resources: stateResources,
      ...(parameterValues && { parameters: parameterValues }),
      ...(conditions && { conditions }),
    },
    stackName
  );
  return engine.resolver.resolve(metadata, { ...context, skipDynamicReferences: true });
}

/**
 * Run the resource DAG, then settle the receiver (cancel an update a failed
 * or interrupted deploy left waiting), whatever the DAG's outcome.
 */
export async function settledAfter<T>(engine: DeployEngine, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    await engine.signalReceiver?.settle();
  }
}

/**
 * A `CreationPolicy`-signalled `AWS::CloudFormation::WaitCondition` (no
 * `Handle`) exists only to wait: one the receiver does not wait on this
 * deploy is refused before it is created, as before go-to-k/cdkd#6705, rather
 * than letting its dependents pass an unenforced gate.
 */
export function refuseUnservedSignalWait(
  engine: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  template: CloudFormationTemplate | undefined
): void {
  if (change.changeType !== 'CREATE' && change.changeType !== 'UPDATE') return;
  const resource = template?.Resources?.[logicalId];
  if (resource?.Type !== 'AWS::CloudFormation::WaitCondition') return;
  const handle = (resource.Properties as Record<string, unknown> | undefined)?.['Handle'];
  if (handle !== undefined && handle !== null) return;
  if (engine.signalReceiver?.isArmed(logicalId) === true) return;
  if (
    change.changeType === 'UPDATE' &&
    change.propertyChanges?.some((pc) => pc.requiresReplacement) !== true
  ) {
    return;
  }
  throw markNonRetryable(
    new ProvisioningError(
      `WaitCondition ${logicalId} has no Handle, and no CloudFormation signal receiver waits on ` +
        'it this deploy (a nested stack, or a receiver that could not be used), so its ' +
        'CreationPolicy signals cannot be received.',
      'AWS::CloudFormation::WaitCondition',
      logicalId
    )
  );
}

/** Every `[logicalId, attribute]` an `Fn::GetAtt` or `Fn::Sub` in `value` reads. */
export function getAttReadsOf(value: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
      if (key === 'Fn::GetAtt') {
        const parts =
          typeof inner === 'string'
            ? [inner.slice(0, inner.indexOf('.')), inner.slice(inner.indexOf('.') + 1)]
            : Array.isArray(inner)
              ? inner
              : [];
        if (typeof parts[0] === 'string' && typeof parts[1] === 'string') {
          out.push([parts[0], parts[1]]);
        }
      } else if (key === 'Fn::Sub') {
        const text =
          typeof inner === 'string' ? inner : Array.isArray(inner) ? inner[0] : undefined;
        if (typeof text === 'string') {
          for (const m of text.matchAll(/\$\{([^!}.][^}.]*)\.([^}]+)\}/g)) out.push([m[1]!, m[2]!]);
        }
      }
      walk(inner);
    }
  };
  walk(value);
  return out;
}

/**
 * go-to-k/cdkd#6706: the `UpdateContext.rollingSignals` watch for a rolling
 * update the receiver armed, or nothing. The wait stops with the deploy.
 */
export function rollingSignalsFor(
  engine: DeployEngine,
  logicalId: string
): Pick<UpdateContext, 'rollingSignals'> {
  const receiver = engine.signalReceiver;
  if (receiver?.candidate(logicalId)?.rollingPauseMs === undefined) return {};
  let since = Date.now();
  return {
    rollingSignals: {
      arm: async (count) => {
        since = Date.now();
        return receiver.armRolling(logicalId, count);
      },
      failure: () => receiver.failureOf(logicalId, since),
      awaitAll: (withinMs) =>
        receiver.awaitSignals(logicalId, since, () => engine.interrupted, Date.now() + withinMs),
    },
  };
}
