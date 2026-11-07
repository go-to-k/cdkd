import type {
  CloudFormationTemplate,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  CreateContext,
  DeleteContext,
  UpdateContext,
} from '../../types/resource.js';
import type { NestedStackProviderContext } from '../nested-stack-context.js';
import type { AssetRedirectMap } from '../../assets/asset-redirect.js';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import {
  requireContext,
  requireDeployContext,
  deriveChildStackName,
  synthesizeArn,
} from './nested-stack/shared.js';
import { create, update, revertFromChildJournal } from './nested-stack/create-update.js';
import { deleteImpl } from './nested-stack/delete.js';
import { runChildDeploy } from './nested-stack/child-deploy.js';
import {
  getAttribute,
  readChildOutputsAsAttributes,
  outputAttributeName,
  buildOutputsAttributes,
} from './nested-stack/outputs.js';
import {
  refuseMalformedNestedTemplateTree,
  extractParameters,
  refuseNonScalarParameter,
  readChildTemplate,
  indexGrandchildTemplates,
} from './nested-stack/template.js';

export { isAbsoluteCrossPlatform } from './nested-stack/template.js';
export { PENDING_CHILD_DELETES_KEY } from './nested-stack/shared.js';

/**
 * Provider for `AWS::CloudFormation::Stack` — cdkd's recursive nested-stack
 * adapter. Issue [#459](https://github.com/go-to-k/cdkd/issues/459); see
 * [docs/design/459-nested-stacks.md](../../../docs/design/459-nested-stacks.md)
 * for the full design.
 *
 * A ROLLBACK revert of this row (`update` with `UpdateContext.replayingState`)
 * is the exception: it replays the child's own rollback journal for the run
 * being rolled back and deploys no template (issue #3754,
 * `src/deployment/nested-child-journal.ts`).
 *
 * On `create` / `update`, the provider builds a child {@link DeployEngine}
 * against the same shared state backend / lock manager / provider registry,
 * deploys the child template recursively, and surfaces the child's outputs
 * as `attributes['Outputs.<Key>']` so the parent's
 * `Fn::GetAtt: [<NestedStack>, 'Outputs.<Key>']` references resolve via
 * the existing flat-key fast path in {@link IntrinsicFunctionResolver}.
 *
 * On `delete`, the provider loads the child's state and routes it through
 * {@link runDestroyForStack} for a regular reverse-DAG destroy — the same
 * code `cdkd destroy` uses on a top-level stack.
 *
 * The child's state file lives at
 * `cdkd/<parentStackName>~<NestedStackLogicalId>/<region>/state.json`
 * (the `~` separator is rare in CDK logical ids; verified safe against
 * CDK Stage paths which use `/`). The synthesized `physicalId` is a fake
 * ARN with `cdkd-local` partition so any downstream consumer that
 * accidentally uses it as a real AWS ARN fails loudly.
 */
export class NestedStackProvider implements ResourceProvider {
  logger: ConsoleLogger = getLogger().child('NestedStackProvider');

  /**
   * Opt out of the deploy engine's outer transient-error retry loop. A
   * nested-stack `create` recursively spawns a child {@link DeployEngine}
   * that has its own retry / rollback machinery; an outer retry would
   * re-enter the entire child deploy on a transient error and produce
   * duplicate AWS resources before the second attempt's per-resource
   * state save settles. The child engine handles transient errors
   * internally — mirroring the same opt-out the Custom Resource provider
   * uses for the same reason.
   */
  readonly disableOuterRetry = true;

  /**
   * The CC API fallback path for `AWS::CloudFormation::Stack` would call
   * CloudFormation's own `CreateStack` — defeating cdkd's whole "no CFn"
   * approach for the nested children. Refuse the fallback so any future
   * regression that drops a real property from `handledProperties`
   * surfaces as an explicit "unhandled property" deploy error instead of
   * silently round-tripping through CloudFormation.
   */
  readonly disableCcApiFallback = true;

  /**
   * Properties this provider actually wires through to the child deploy.
   * `TemplateURL` is the asset-published S3 URL of the child template
   * (cdkd reads the local template file via `Metadata['aws:asset:path']`,
   * so the URL itself is informational here); `Parameters` is the typed
   * parameter map forwarded as `DeployEngineOptions.parameters` to the
   * child engine.
   */
  handledProperties: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['AWS::CloudFormation::Stack', new Set<string>(['TemplateURL', 'Parameters'])],
  ]);

  /**
   * Every other property on `AWS::CloudFormation::Stack` is intentionally
   * not threaded through — cdkd does not go through CloudFormation, so
   * CFn-only inputs (rollback / capability / role / notification /
   * termination-protection / stack-update policy / per-stack timeout /
   * tags) have no equivalent. The synthesized `Ref` ARN is a placeholder,
   * not a real AWS resource — so `Tags` and `Description` similarly
   * have nothing to attach to. `StackName` is replaced by cdkd's derived
   * `<parent>~<logicalId>` key per design §3, and `TemplateBody` is
   * superseded by the local `Metadata['aws:asset:path']` lookup.
   */
  unhandledByDesign: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
    [
      'AWS::CloudFormation::Stack',
      new Map<string, string>([
        [
          'TemplateBody',
          "CFn-only inline template — cdkd reads the child template from the synth output via Metadata['aws:asset:path'] instead of accepting it inline",
        ],
        [
          'Capabilities',
          'CFn-only IAM capability declaration — cdkd does not go through CloudFormation so capabilities have no equivalent',
        ],
        ['Description', 'CFn-only informational — no semantic effect on the recursive deploy'],
        [
          'DisableRollback',
          'CFn-only — cdkd controls rollback via the top-level deploy-engine --no-rollback flag, not per nested stack',
        ],
        [
          'EnableTerminationProtection',
          'CFn-only per-nested-stack flag — cdkd records stack-level terminationProtection at CDK synth time (parent only) and `cdkd destroy` consults that for refusal',
        ],
        ['NotificationARNs', 'CFn-only SNS-on-stack-event surface — cdkd has no equivalent'],
        [
          'RoleARN',
          'CFn-only role-assumption — cdkd uses the caller credentials directly, no per-resource role assumption',
        ],
        [
          'StackName',
          'cdkd derives the child stack name as `<parent>~<logicalId>` per design §3 (state-key uniqueness); a user-provided StackName has no effect',
        ],
        [
          'StackPolicyBody',
          'CFn-only stack-update policy — cdkd has no equivalent (per-resource diff replaces stack-level policy)',
        ],
        ['StackPolicyURL', 'CFn-only stack-update policy URL — cdkd has no equivalent'],
        ['StackStatusReason', 'CFn-only read-only output — never a real input property'],
        [
          'Tags',
          'CFn-only — cdkd does not tag the synthesized "stack" (the parent\'s synthesized ARN is a cdkd-local placeholder, not a real AWS resource)',
        ],
        [
          'TimeoutInMinutes',
          'CFn-only stack-create deadline — cdkd uses per-resource --resource-timeout instead',
        ],
      ]),
    ],
  ]);

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      _resourceType,
      properties,
      _previousProperties,
      context
    );
  }

  revertFromChildJournal(
    ctx: NestedStackProviderContext,
    logicalId: string,
    physicalId: string
  ): Promise<ResourceUpdateResult> {
    return revertFromChildJournal.call(this, ctx, logicalId, physicalId);
  }

  delete(
    logicalId: string,
    _physicalId: string,
    _resourceType: string,
    _properties?: Record<string, unknown>,
    deleteContext?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, _physicalId, _resourceType, _properties, deleteContext);
  }

  getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    return getAttribute.call(this, _physicalId, _resourceType, attributeName);
  }

  runChildDeploy(
    parentCtx: NestedStackProviderContext,
    logicalId: string,
    childStackName: string,
    childRegion: string,
    childTemplate: CloudFormationTemplate,
    childParameters: Record<string, string>,
    grandchildTemplates: Record<string, string>
  ): Promise<number> {
    return runChildDeploy.call(
      this,
      parentCtx,
      logicalId,
      childStackName,
      childRegion,
      childTemplate,
      childParameters,
      grandchildTemplates
    );
  }

  readChildOutputsAsAttributes(
    ctx: NestedStackProviderContext,
    childStackName: string,
    childRegion: string
  ): Promise<{
    attributes: Record<string, unknown>;
    noEchoAttributeNames: string[];
    secretNamedAttributeNames: string[];
  }> {
    return readChildOutputsAsAttributes.call(this, ctx, childStackName, childRegion);
  }

  requireContext(): NestedStackProviderContext {
    return requireContext.call(this);
  }

  requireDeployContext(ctx: NestedStackProviderContext, op: 'create' | 'update'): void {
    return requireDeployContext.call(this, ctx, op);
  }

  refuseMalformedNestedTemplateTree(
    ctx: NestedStackProviderContext,
    logicalId: string,
    childTemplatePath: string
  ): void {
    return refuseMalformedNestedTemplateTree.call(this, ctx, logicalId, childTemplatePath);
  }

  deriveChildStackName(parentStackName: string, nestedLogicalId: string): string {
    return deriveChildStackName.call(this, parentStackName, nestedLogicalId);
  }

  synthesizeArn(
    accountId: string,
    childRegion: string,
    parentStackName: string,
    logicalId: string
  ): string {
    return synthesizeArn.call(this, accountId, childRegion, parentStackName, logicalId);
  }

  extractParameters(properties: Record<string, unknown>): Record<string, string> {
    return extractParameters.call(this, properties);
  }

  refuseNonScalarParameter(k: string, offender: unknown, where: string): never {
    return refuseNonScalarParameter.call(this, k, offender, where);
  }

  readChildTemplate(
    templatePath: string,
    assetRedirect?: AssetRedirectMap
  ): { template: CloudFormationTemplate; grandchildTemplates: Record<string, string> } {
    return readChildTemplate.call(this, templatePath, assetRedirect);
  }

  indexGrandchildTemplates(
    childTemplate: CloudFormationTemplate,
    childTemplatePath: string
  ): Record<string, string> {
    return indexGrandchildTemplates.call(this, childTemplate, childTemplatePath);
  }

  outputAttributeName(outputKey: string): string {
    return outputAttributeName.call(this, outputKey);
  }

  buildOutputsAttributes(outputs: Record<string, unknown>): Record<string, unknown> {
    return buildOutputsAttributes.call(this, outputs);
  }
}
