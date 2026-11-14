/**
 * go-to-k/cdkd#6274: re-spell an un-named SSM parameter's recorded `/<name>`
 * as `<name>`.
 *
 * Before go-to-k/cdkd#6272 cdkd created an un-named `AWS::SSM::Parameter` as
 * `/<generated name>`, and its `Ref` returned that. CDK builds an auto-named
 * parameter's grant ARN as `arn:...:parameter/` + Ref, assuming the slash-less
 * name CloudFormation generates, so `grantRead` / `grantWrite` granted
 * `parameter//<name>` and matched nothing. #6272 fixed new creates; a record
 * written before it keeps `/<name>`.
 *
 * SSM stores a one-level `/x` as `x`, and `x` and `/x` name the SAME parameter
 * (measured in #6272: `put-parameter --name x` after `--name /x` is refused
 * with `ParameterAlreadyExists`, and `delete-parameter --name x` removes it).
 * So the record's physical id is re-spelled in memory, with no AWS call,
 * before the diff: every `Ref` to it then resolves to `<name>`, and the
 * dependents holding the old spelling (an IAM policy, an environment
 * variable, an output) update in the same deploy. `cdkd diff` applies the
 * same heal, so it previews those updates.
 *
 * Only a name cdkd provably GENERATED is touched: the template declares no
 * `Name` (nor does the record), and the id is exactly `/` + the name cdkd
 * generates for this stack and logical id -- the legacy `{stack}-{logicalId}`
 * or, on a stack with an instance id, the suffixed name of the record's own
 * generation. A declared name, a multi-level `/a/b`, or any other spelling is
 * left as recorded. A record `cdkd import` wrote under exactly that name
 * holds a name only cdkd generates, so it is the same case.
 */
import { generatedNameFor, withStackScope } from '../provisioning/resource-name.js';
import { nameGenerationOf } from '../state/name-generation.js';
import { stackInstanceIdOf } from '../state/stack-instance-id.js';
import { safeMsg } from '../utils/display-safe.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState, StackState } from '../types/state.js';

const SSM_PARAMETER = 'AWS::SSM::Parameter';

/** One record {@link healSlashedSsmParameterNames} re-spelled. */
export interface SlashedSsmNameHeal {
  logicalId: string;
  /** The recorded `/<name>`. */
  from: string;
  /** `<name>`, what the record now holds. */
  to: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The names cdkd generated for `logicalId` of `stackName` under either scheme. */
function generatedNames(
  logicalId: string,
  stackName: string,
  stackInstanceId: string | undefined,
  record: ResourceState
): string[] {
  const names = [
    withStackScope({ stackName, stackInstanceId: undefined, nameGenerations: undefined }, () =>
      generatedNameFor(SSM_PARAMETER, logicalId)
    ),
  ];
  if (stackInstanceId !== undefined) {
    const generation = nameGenerationOf(record, logicalId);
    names.push(
      withStackScope(
        { stackName, stackInstanceId, nameGenerations: new Map([[logicalId, generation]]) },
        () => generatedNameFor(SSM_PARAMETER, logicalId)
      )
    );
  }
  return names;
}

/** `record` re-spelled to `to`, or `undefined` when it is not a heal candidate. */
function healedRecord(
  logicalId: string,
  record: unknown,
  template: CloudFormationTemplate,
  stackName: string,
  stackInstanceId: string | undefined
): { record: ResourceState; heal: SlashedSsmNameHeal } | undefined {
  if (!isObject(record) || record['resourceType'] !== SSM_PARAMETER) return undefined;
  const physicalId = record['physicalId'];
  if (typeof physicalId !== 'string' || !/^\/[^/]+$/.test(physicalId)) return undefined;
  const declared = template.Resources?.[logicalId];
  if (!isObject(declared) || declared['Type'] !== SSM_PARAMETER) return undefined;
  const properties = declared['Properties'] ?? {};
  // The generated-name fill's own test (`applyDefaultNameForFallback`): a
  // falsy `Name` is generated over, anything else is the template's.
  if (!isObject(properties) || properties['Name']) return undefined;
  const recordedProperties = record['properties'];
  if (isObject(recordedProperties) && recordedProperties['Name']) return undefined;
  const state = record as unknown as ResourceState;
  const to = physicalId.slice(1);
  let names: string[];
  try {
    names = generatedNames(logicalId, stackName, stackInstanceId, state);
  } catch {
    // A malformed name generation: the deploy refuses it on its own; the
    // record is left as recorded.
    return undefined;
  }
  if (!names.includes(to)) return undefined;
  // The live read reports `Name` as the physical id, so a baseline captured
  // under the old spelling moves with it.
  const observed = state.observedProperties;
  const healed: ResourceState = {
    ...state,
    physicalId: to,
    ...(isObject(observed) &&
      observed['Name'] === physicalId && { observedProperties: { ...observed, Name: to } }),
  };
  return { record: healed, heal: { logicalId, from: physicalId, to } };
}

/**
 * `state.resources` with each pre-#6272 generated SSM parameter name
 * re-spelled (see the file comment), and the heals made. Neither input is
 * mutated; with no heal, `resources` is `state.resources` itself.
 */
export function healSlashedSsmParameterNames(
  state: StackState,
  template: CloudFormationTemplate,
  stackName: string
): { resources: Record<string, ResourceState>; heals: SlashedSsmNameHeal[] } {
  const resources = state.resources ?? {};
  const heals: SlashedSsmNameHeal[] = [];
  // A malformed bag is the load checks' to refuse or repair, never rebuilt here.
  if (!isObject(resources)) return { resources, heals };
  let stackInstanceId: string | undefined;
  try {
    stackInstanceId = stackInstanceIdOf(state, stackName);
  } catch {
    // A malformed id is refused by the deploy itself; heal nothing.
    return { resources, heals };
  }
  let healedResources: Record<string, ResourceState> | undefined;
  for (const [logicalId, record] of Object.entries(resources)) {
    const result = healedRecord(logicalId, record, template, stackName, stackInstanceId);
    if (result === undefined) continue;
    healedResources ??= { ...resources };
    healedResources[logicalId] = result.record;
    heals.push(result.heal);
  }
  return { resources: healedResources ?? resources, heals };
}

/** The line `cdkd deploy` and `cdkd diff` print for one heal. */
export function slashedSsmNameHealNote(heal: SlashedSsmNameHeal): string {
  return (
    safeMsg`SSM parameter ${heal.logicalId}: its recorded name ${heal.from} is ` +
    safeMsg`re-spelled ${heal.to} (the same parameter in SSM), so Ref and CDK's ` +
    `grantRead / grantWrite ARN name it; resources referencing it update to the new spelling ` +
    `(go-to-k/cdkd#6274)`
  );
}

/**
 * The line `cdkd diff` prints for a nested child's record the deploy will not
 * heal yet: the child's engine runs only when its parent's row changes.
 */
export function slashedSsmNameHealPendingNote(heal: SlashedSsmNameHeal, stackName: string): string {
  return (
    safeMsg`SSM parameter ${heal.logicalId} of nested stack ${stackName}: its recorded name ` +
    safeMsg`${heal.from} is re-spelled ${heal.to} on the next deploy that updates this nested ` +
    `stack, not on this one (go-to-k/cdkd#6274)`
  );
}

/** Whether `value` reads `logicalId` through `Ref`, `Fn::GetAtt` or `Fn::Sub`. */
function reads(value: unknown, logicalId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => reads(item, logicalId));
  if (!isObject(value)) return false;
  if (value['Ref'] === logicalId) return true;
  const getAtt = value['Fn::GetAtt'];
  if (Array.isArray(getAtt) && getAtt[0] === logicalId) return true;
  if (typeof getAtt === 'string' && getAtt.split('.')[0] === logicalId) return true;
  const sub = value['Fn::Sub'];
  const subText = Array.isArray(sub) ? sub[0] : sub;
  if (
    typeof subText === 'string' &&
    (subText.includes(`\${${logicalId}}`) || subText.includes(`\${${logicalId}.`))
  ) {
    return true;
  }
  return Object.values(value).some((child) => reads(child, logicalId));
}

/**
 * The heals an exported output of `template` reads: the re-spellings that can
 * be why an export changes value with no template change.
 */
export function healsReadByExports(
  heals: readonly SlashedSsmNameHeal[],
  template: CloudFormationTemplate
): SlashedSsmNameHeal[] {
  const exported = Object.values(template.Outputs ?? {}).filter(
    (output) => isObject(output) && output['Export'] !== undefined
  );
  return heals.filter((heal) => exported.some((output) => reads(output.Value, heal.logicalId)));
}
