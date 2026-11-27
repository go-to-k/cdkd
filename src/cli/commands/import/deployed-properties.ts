import { mentionsDynamicReference } from '../../../deployment/secret-redaction/recorded-secrecy.js';
import { isDeepStrictEqual } from 'node:util';
import {
  DescribeStacksCommand,
  GetTemplateCommand,
  type CloudFormationClient,
} from '@aws-sdk/client-cloudformation';
import { parseCfnTemplate } from '../../yaml-cfn.js';
import { NESTED_STACK_RESOURCE_TYPE, cfnFailureText } from '../retire-cfn-stack.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { defineOwnKey } from '../../../utils/own-keys.js';
import { logicalIdShown, resourceTypeShown } from '../../../provisioning/composite-id.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../types/resource.js';
import type { ConsoleLogger } from '../../../utils/logger.js';

/**
 * go-to-k/cdkd#6840 — the properties a `--migrate-from-cloudformation` import
 * records come from the template CloudFormation last DEPLOYED, not from the
 * synthesized one.
 *
 * The Retain-policy `UpdateStack` reuses CloudFormation's own template
 * (`prepareCloudFormationStackRetirement`), so AWS keeps the configuration of
 * the last `cdk deploy`. When the CDK code changed after that deploy, recording
 * the SYNTHESIZED properties claimed the change was already applied: the next
 * `cdkd diff` said "no changes" and `cdkd deploy` never sent it, while under
 * CloudFormation the next `cdk deploy` would have. Recording the deployed
 * properties makes the next diff show, and the next deploy apply, exactly the
 * change CloudFormation would.
 *
 * Only a resource's `Properties` come from the deployed template. Everything
 * else (`DependsOn`, `DeletionPolicy`, `Metadata`, and the template's
 * `Parameters` / `Conditions` / `Mappings` / `Outputs`) stays the synthesized
 * template's, so parameter binding, the observed-baseline refusal arms and the
 * cross-stack read records are computed exactly as before. A resource keeps its
 * SYNTHESIZED properties, with a warning naming it, whenever the deployed ones
 * cannot be resolved against those sections the way CloudFormation resolved
 * them (see {@link deployedPropertiesBlocker}).
 */

/**
 * Read the template a CloudFormation stack last deployed, with every transform
 * expanded (`TemplateStage: 'Processed'`, which is the submitted template for a
 * stack that declares none). `stackName` may be a stack ARN (a nested child).
 *
 * Throws on any failure, each message ending in `consequence`: what the caller
 * has and has not written at that point.
 */
export async function readDeployedTemplate(
  cfnClient: CloudFormationClient,
  stackName: string,
  consequence: string
): Promise<CloudFormationTemplate> {
  const refuse = (reason: string): Error =>
    new Error(`--migrate-from-cloudformation: ${reason} ${consequence}`);
  let body: string | undefined;
  try {
    const response = await cfnClient.send(
      new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Processed' })
    );
    body = response.TemplateBody;
  } catch (err) {
    throw refuse(
      safeMsg`reading the template CloudFormation last deployed failed: ${cfnFailureText(err)}.`
    );
  }
  if (!body) {
    throw refuse('CloudFormation returned no template body for the stack being migrated.');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCfnTemplate(body);
  } catch (err) {
    // `parseCfnTemplate`'s own message names only an offset and a size, never
    // template text (issue #5254).
    throw refuse(
      safeMsg`the template CloudFormation last deployed could not be parsed: ${describeAwsFailure(err).detail}.`
    );
  }
  const resources = parsed['Resources'];
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) {
    throw refuse('the template CloudFormation last deployed has no Resources section.');
  }
  return parsed as unknown as CloudFormationTemplate;
}

/**
 * go-to-k/cdkd#6887 — the stack tags a CloudFormation stack holds, which
 * CloudFormation propagated to every taggable resource of the stack: what a
 * migration records in each resource's tag property, since that is what AWS
 * holds (the deployed template carries the resources' own tags only). `aws:`
 * keys are CloudFormation's own and never a stack tag a template can pass.
 * `stackName` may be a stack ARN (a nested child).
 *
 * Throws on any failure, the message ending in `consequence`, as
 * {@link readDeployedTemplate} does.
 */
export async function readDeployedStackTags(
  cfnClient: CloudFormationClient,
  stackName: string,
  consequence: string
): Promise<Record<string, string>> {
  let tags: ReadonlyArray<{ Key?: string | undefined; Value?: string | undefined }>;
  try {
    const response = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = response.Stacks?.[0];
    if (stack === undefined) throw new Error('the stack was not returned');
    tags = stack.Tags ?? [];
  } catch (err) {
    throw new Error(
      `--migrate-from-cloudformation: ` +
        safeMsg`reading the stack tags of the CloudFormation stack failed: ${cfnFailureText(err)}.` +
        ` ${consequence}`
    );
  }
  const read: Record<string, string> = {};
  for (const { Key: key, Value: value } of tags) {
    if (typeof key !== 'string' || typeof value !== 'string' || key.startsWith('aws:')) continue;
    defineOwnKey(read, key, value);
  }
  return read;
}

/**
 * go-to-k/cdkd#6887 — the stack tags a migrated nested child records on its
 * resources: its parent's (as recorded) plus each entry of the row's `Tags` in
 * the PARENT's deployed template that is a literal pair, the row's winning, as
 * CloudFormation tags a nested stack. Never the child stack's tags as AWS
 * reports them: an entry CloudFormation resolved (a `Ref` to a `NoEcho`
 * parameter, a dynamic reference) would put the plaintext value in state, so
 * such an entry, and one whose key cannot be read, is not recorded at all (the
 * next deploy then re-sends it, never a secret).
 */
export function nestedChildStackTags(
  parentStackTags: Readonly<Record<string, string>>,
  parentDeployedTemplate: CloudFormationTemplate | undefined,
  rowLogicalId: string
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentStackTags)) defineOwnKey(tags, key, value);
  const resources = parentDeployedTemplate?.Resources;
  const row =
    resources !== undefined && hasOwn(resources, rowLogicalId)
      ? resources[rowLogicalId]
      : undefined;
  const rowTags: unknown = row?.Properties?.['Tags'];
  if (!Array.isArray(rowTags)) return tags;
  for (const entry of rowTags as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { Key: key, Value: value } = entry as Record<string, unknown>;
    if (typeof key !== 'string') continue;
    if (typeof value === 'string' && !mentionsDynamicReference(value)) {
      defineOwnKey(tags, key, value);
    } else {
      // The parent's value for the key is not this stack's any more either.
      delete tags[key];
    }
  }
  return tags;
}

/**
 * go-to-k/cdkd#6900 — a migrated stack's `nestedStackTags` record: per nested
 * row, the tags its child records ({@link nestedChildStackTags}), which is
 * what the child's resources hold. Without it the next deploy reads every
 * tagged row as `{}` and re-runs its child once for nothing. A row with no
 * tags is omitted, and the field with them, as a deploy writes it.
 */
export function migratedNestedStackTags(
  stackTags: Readonly<Record<string, string>>,
  deployedTemplate: CloudFormationTemplate | undefined,
  rowLogicalIds: Iterable<string>
): Record<string, Record<string, string>> | undefined {
  const field: Record<string, Record<string, string>> = {};
  for (const logicalId of rowLogicalIds) {
    const tags = nestedChildStackTags(stackTags, deployedTemplate, logicalId);
    if (Object.keys(tags).length > 0) defineOwnKey(field, logicalId, tags);
  }
  return Object.keys(field).length > 0 ? field : undefined;
}

/**
 * `state` with its `nestedStackTags` replaced by `field` (removed when
 * `undefined`): a migration rebuilds the record, so a carried field is stale.
 */
export function withMigratedNestedStackTags<T extends { nestedStackTags?: unknown }>(
  state: T,
  field: Record<string, Record<string, string>> | undefined
): T {
  if (field === undefined) delete state.nestedStackTags;
  else state.nestedStackTags = field;
  return state;
}

/** The names a properties tree refers to, by kind. */
interface ReferencedNames {
  /** `Ref`, `Fn::GetAtt` and `Fn::Sub` targets: a parameter, resource or pseudo parameter. */
  targets: Set<string>;
  conditions: Set<string>;
  mappings: Set<string>;
  /** A `Fn::FindInMap` whose map name is itself an intrinsic: every mapping counts. */
  anyMapping: boolean;
  /** `{Condition: <name>}` objects: a condition only when some template declares the name. */
  conditionKeys: Set<string>;
  /**
   * Intrinsic nodes whose value comes from OUTSIDE this stack's templates
   * (`Fn::ImportValue`, `Fn::GetStackOutput`) or that the resolver does not
   * model at all, verbatim.
   */
  external: unknown[];
}

function newNames(): ReferencedNames {
  return {
    targets: new Set(),
    conditions: new Set(),
    mappings: new Set(),
    anyMapping: false,
    conditionKeys: new Set(),
    external: [],
  };
}

/**
 * The intrinsics a value is resolved by from this stack's own templates, state
 * and pseudo parameters alone. Any other `Fn::` key either reads another stack
 * (`Fn::ImportValue`, `Fn::GetStackOutput`) or is not one the resolver knows.
 */
const STACK_LOCAL_INTRINSICS: ReadonlySet<string> = new Set([
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Cidr',
]);

/** The `${X}` / `${X.Attr}` targets of a `Fn::Sub` string, minus its own variables. */
function subTargets(text: string, localVariables: ReadonlySet<string>, out: Set<string>): void {
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
    const inner = match[1] ?? '';
    if (inner.startsWith('!')) continue;
    const name = inner.split('.')[0]!.trim();
    if (name.length === 0 || localVariables.has(name)) continue;
    out.add(name);
  }
}

function collectNames(value: unknown, out: ReferencedNames): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const key = keys[0]!;
    const arg = obj[key];
    if (key === 'Ref' && typeof arg === 'string') {
      out.targets.add(arg);
      return;
    }
    if (key === 'Condition' && typeof arg === 'string') {
      // A literal `{"Condition": "x"}` (an SSM document's content, say) is not
      // a reference; the blocker counts only a name some template declares.
      out.conditionKeys.add(arg);
      return;
    }
    if (key === 'Fn::GetAtt') {
      if (typeof arg === 'string') {
        out.targets.add(arg.split('.')[0]!);
        return;
      }
      if (Array.isArray(arg) && typeof arg[0] === 'string') {
        out.targets.add(arg[0]);
        collectNames(arg.slice(1), out);
        return;
      }
    }
    if (key === 'Fn::Sub') {
      if (typeof arg === 'string') {
        subTargets(arg, new Set(), out.targets);
        return;
      }
      if (Array.isArray(arg) && typeof arg[0] === 'string') {
        const variables =
          arg[1] !== null && typeof arg[1] === 'object' && !Array.isArray(arg[1])
            ? (arg[1] as Record<string, unknown>)
            : {};
        subTargets(arg[0], new Set(Object.keys(variables)), out.targets);
        collectNames(arg.slice(1), out);
        return;
      }
    }
    if (key === 'Fn::If' && Array.isArray(arg) && typeof arg[0] === 'string') {
      out.conditions.add(arg[0]);
      collectNames(arg.slice(1), out);
      return;
    }
    if (key === 'Fn::FindInMap' && Array.isArray(arg)) {
      if (typeof arg[0] === 'string') out.mappings.add(arg[0]);
      else out.anyMapping = true;
      collectNames(arg, out);
      return;
    }
    if (key.startsWith('Fn::') && !STACK_LOCAL_INTRINSICS.has(key)) {
      out.external.push(obj);
      collectNames(arg, out);
      return;
    }
  }
  for (const child of Object.values(obj)) collectNames(child, out);
}

/**
 * The first path (`A.B.0`) at which `synth` holds a string spelling a dynamic
 * reference while `deployed` holds anything but such a string, or `undefined`.
 * Paths only, never values.
 */
function dynamicReferenceDowngradePath(
  synth: unknown,
  deployed: unknown,
  path: string
): string | undefined {
  if (typeof synth === 'string') {
    if (!mentionsDynamicReference(synth)) return undefined;
    return typeof deployed === 'string' && mentionsDynamicReference(deployed)
      ? undefined
      : path || '(the whole bag)';
  }
  if (synth === null || typeof synth !== 'object') return undefined;
  const deployedNode =
    deployed !== null && typeof deployed === 'object' ? (deployed as Record<string, unknown>) : {};
  for (const [key, child] of Object.entries(synth as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    const next = hasOwn(deployedNode, key) ? deployedNode[key] : undefined;
    const found = dynamicReferenceDowngradePath(child, next, childPath);
    if (found !== undefined) return found;
  }
  return undefined;
}

function section(template: CloudFormationTemplate, name: string): Record<string, unknown> {
  const value = (template as unknown as Record<string, unknown>)[name];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Why the DEPLOYED `properties` of one resource cannot be resolved against the
 * synthesized template's sections the way CloudFormation resolved them, or
 * `undefined` when they can:
 *
 *  - a `Ref` / `Fn::GetAtt` / `Fn::Sub` target that is neither a pseudo
 *    parameter nor a parameter or resource the synthesized template declares
 *    (a renamed sibling, or a LegacyStackSynthesizer asset parameter whose
 *    hash changed);
 *  - a condition, reached directly or through another condition, whose
 *    definition differs between the two templates or is missing from either;
 *  - a mapping whose content differs or is missing (every mapping, for a
 *    `Fn::FindInMap` naming its map through an intrinsic).
 *
 * A parameter is checked by NAME only: its value is whatever the import binds
 * for it, the same binding the synthesized properties get (and the
 * deployed-parameter comparison of issue #2854 refuses a baseline over).
 */
export function deployedPropertiesBlocker(
  deployedProperties: unknown,
  synthProperties: unknown,
  synthTemplate: CloudFormationTemplate,
  deployedTemplate: CloudFormationTemplate
): string | undefined {
  // A dynamic reference the code now spells where the deployed template held
  // something else (a literal, typically a secret pasted in before): recording
  // the deployed bag would persist that value, and the import's redaction
  // pairs against the bag it records, which spells no reference there. Keep
  // the synthesized bag, whose reference the redaction does see.
  const downgraded = dynamicReferenceDowngradePath(synthProperties, deployedProperties, '');
  if (downgraded !== undefined) {
    return safeMsg`the synthesized properties hold a dynamic reference at ${downgraded} where the deployed ones do not`;
  }

  const names = newNames();
  collectNames(deployedProperties, names);

  const synthParameters = section(synthTemplate, 'Parameters');
  const synthResources = section(synthTemplate, 'Resources');
  const deployedResources = section(deployedTemplate, 'Resources');
  const deployedParameters = section(deployedTemplate, 'Parameters');
  for (const target of names.targets) {
    if (target.startsWith('AWS::')) continue;
    // The same logical id as a parameter on one side and a resource on the
    // other answers `Ref` with a different kind of value.
    if (
      (hasOwn(synthParameters, target) && hasOwn(deployedResources, target)) ||
      (hasOwn(synthResources, target) && hasOwn(deployedParameters, target))
    ) {
      return safeMsg`they reference ${logicalIdShown(target)}, which changed between a parameter and a resource`;
    }
    if (hasOwn(synthParameters, target)) continue;
    if (hasOwn(synthResources, target)) {
      // A sibling whose TYPE changed answers `Ref` / `Fn::GetAtt` as the new type.
      const was = hasOwn(deployedResources, target)
        ? (deployedResources[target] as { Type?: unknown } | null)?.Type
        : undefined;
      const now = (synthResources[target] as { Type?: unknown } | null)?.Type;
      if (was === undefined || was === now) continue;
      return safeMsg`they reference ${logicalIdShown(target)}, whose type changed in the synthesized template`;
    }
    return safeMsg`they reference ${logicalIdShown(target)}, which the synthesized template does not declare`;
  }

  // A cross-stack read (or an intrinsic the resolver does not model) is
  // vouched for only when the synthesized properties make the SAME read: the
  // value it named may be gone (a CDK auto-export the code stopped using is
  // removed from the producer too) and the import has nothing else to resolve
  // it from.
  if (names.external.length > 0) {
    const synthNames = newNames();
    collectNames(synthProperties, synthNames);
    for (const node of names.external) {
      if (!synthNames.external.some((other) => isDeepStrictEqual(node, other))) {
        return 'they read a value from another stack that the synthesized properties no longer read';
      }
    }
  }

  const synthConditions = section(synthTemplate, 'Conditions');
  const deployedConditions = section(deployedTemplate, 'Conditions');
  for (const name of names.conditionKeys) {
    if (hasOwn(synthConditions, name) || hasOwn(deployedConditions, name)) {
      names.conditions.add(name);
    }
  }
  const pending = [...names.conditions];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const condition = pending.pop()!;
    if (seen.has(condition)) continue;
    seen.add(condition);
    if (
      !hasOwn(synthConditions, condition) ||
      !hasOwn(deployedConditions, condition) ||
      !isDeepStrictEqual(synthConditions[condition], deployedConditions[condition])
    ) {
      return safeMsg`they use condition ${logicalIdShown(condition)}, which the synthesized template defines differently`;
    }
    const inner = newNames();
    collectNames(deployedConditions[condition], inner);
    pending.push(...inner.conditions, ...inner.conditionKeys);
  }

  const synthMappings = section(synthTemplate, 'Mappings');
  const deployedMappings = section(deployedTemplate, 'Mappings');
  if (names.anyMapping) {
    if (!isDeepStrictEqual(synthMappings, deployedMappings)) {
      return 'they look up a mapping by a computed name, and the mappings differ from the synthesized template';
    }
  } else {
    for (const mapping of names.mappings) {
      if (
        !hasOwn(synthMappings, mapping) ||
        !hasOwn(deployedMappings, mapping) ||
        !isDeepStrictEqual(synthMappings[mapping], deployedMappings[mapping])
      ) {
        return safeMsg`they use mapping ${logicalIdShown(mapping)}, which the synthesized template defines differently`;
      }
    }
  }
  return undefined;
}

/**
 * The template whose `Properties` an import records: `synthTemplate` with each
 * resource's `Properties` replaced by the ones `deployedTemplate` holds for the
 * same logical id. Pure apart from the log lines; neither input is mutated.
 *
 * Kept as the synthesized properties, by design:
 *  - a resource the deployed template does not hold (it was added to the code
 *    after the last deploy, so nothing in AWS is CloudFormation's for it);
 *  - an `AWS::CloudFormation::Stack` row: its properties are the child's
 *    template location and parameters, and a migrated child records its own
 *    resources' deployed properties in its own state;
 *  - a resource whose type changed, or whose deployed properties
 *    {@link deployedPropertiesBlocker} cannot vouch for — both WARNED, naming
 *    the resource, because the record then claims the synthesized
 *    configuration whatever AWS holds.
 *
 * A deployed resource the synthesized template no longer declares is not
 * imported at all, which is unchanged.
 */
export function overlayDeployedProperties(
  synthTemplate: CloudFormationTemplate,
  deployedTemplate: CloudFormationTemplate,
  logger: ConsoleLogger,
  stackLabel: string
): DeployedPropertiesOverlay {
  const deployedResources = section(deployedTemplate, 'Resources');
  const resources: Record<string, TemplateResource> = {};
  const pending: string[] = [];
  for (const [logicalId, resource] of Object.entries(synthTemplate.Resources)) {
    // Own-key writes: a logical id is template text, and `__proto__` assigned
    // with `=` would become the bag's prototype.
    defineOwnKey(resources, logicalId, resource);
    if (resource.Type === NESTED_STACK_RESOURCE_TYPE) continue;
    if (!hasOwn(deployedResources, logicalId)) continue;
    const deployed = deployedResources[logicalId] as Partial<TemplateResource> | null;
    if (deployed === null || typeof deployed !== 'object') continue;
    const synthProperties = resource.Properties ?? {};
    const deployedProperties = deployed.Properties ?? {};
    if (isDeepStrictEqual(synthProperties, deployedProperties)) continue;
    const blocker =
      deployed.Type !== resource.Type
        ? safeMsg`CloudFormation deployed it as ${resourceTypeShown(String(deployed.Type))}`
        : deployedPropertiesBlocker(
            deployedProperties,
            synthProperties,
            synthTemplate,
            deployedTemplate
          );
    if (blocker !== undefined) {
      logger.warn(
        safeMsg`--migrate-from-cloudformation: ${logicalIdShown(logicalId)} (${resourceTypeShown(resource.Type)}) ` +
          safeMsg`in ${stackLabel} is recorded with the synthesized template's properties, not the ones ` +
          safeMsg`CloudFormation last deployed, because ${blocker}. If the code changed this resource after the ` +
          `last 'cdk deploy', the next 'cdkd diff' does not show that change and 'cdkd deploy' does not ` +
          `apply it: compare the resource in AWS with the template before relying on the record.`
      );
      continue;
    }
    defineOwnKey(resources, logicalId, {
      ...resource,
      Properties: structuredClone(deployedProperties) as Record<string, unknown>,
    });
    pending.push(logicalId);
  }
  if (pending.length > 0) {
    logger.info(
      safeMsg`${pending.length} resource(s) in ${stackLabel} differ from the template CloudFormation last ` +
        safeMsg`deployed (${pending.map((id) => logicalIdShown(id)).join(', ')}): state records what ` +
        `CloudFormation deployed, so the next 'cdkd diff' shows the change and 'cdkd deploy' applies it.`
    );
  }
  return { template: { ...synthTemplate, Resources: resources }, overlaid: new Set(pending) };
}

/**
 * The `Properties` `deployedTemplate` holds for `logicalId`, or `undefined`
 * when it holds no such row (or no object there).
 */
export function deployedPropertiesOf(
  deployedTemplate: CloudFormationTemplate | undefined,
  logicalId: string
): Record<string, unknown> | undefined {
  if (deployedTemplate === undefined) return undefined;
  const rows = section(deployedTemplate, 'Resources');
  if (!hasOwn(rows, logicalId)) return undefined;
  const row = rows[logicalId] as { Properties?: unknown } | null;
  if (row === null || typeof row !== 'object') return undefined;
  const props = row.Properties;
  return props !== null && typeof props === 'object' && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : {};
}

/** {@link overlayDeployedProperties}' answer. */
export interface DeployedPropertiesOverlay {
  /** The template whose `Properties` the import records. */
  template: CloudFormationTemplate;
  /**
   * The logical ids whose `Properties` are the DEPLOYED ones. The dispatch
   * hands a provider's `import()` these, since they are what AWS holds (an
   * `AWS::IAM::Policy` records its deployed `PolicyName`, not a renamed one).
   */
  overlaid: ReadonlySet<string>;
}

/**
 * The dispatch's resource list with each overlaid resource's definition taken
 * from `overlay.template`, the rest unchanged (in cdkd-assets mode the
 * unchanged ones keep the asset-rewritten definition `provider.import()` got
 * before go-to-k/cdkd#6840).
 */
export function withDeployedDefinitions<
  T extends { logicalId: string; resource: TemplateResource },
>(resources: readonly T[], overlay: DeployedPropertiesOverlay): T[] {
  return resources.map((entry) =>
    overlay.overlaid.has(entry.logicalId)
      ? { ...entry, resource: overlay.template.Resources[entry.logicalId]! }
      : entry
  );
}
