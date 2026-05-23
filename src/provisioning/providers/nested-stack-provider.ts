import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CloudFormationTemplate,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  DeleteContext,
} from '../../types/resource.js';
import { DeployEngine } from '../../deployment/deploy-engine.js';
import { runDestroyForStack } from '../../cli/commands/destroy-runner.js';
import {
  withNestedStackContext,
  getCurrentNestedStackContext,
  type NestedStackProviderContext,
} from '../nested-stack-context.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Provider for `AWS::CloudFormation::Stack` — cdkd's recursive nested-stack
 * adapter. Issue [#459](https://github.com/go-to-k/cdkd/issues/459); see
 * [docs/design/459-nested-stacks.md](../../../docs/design/459-nested-stacks.md)
 * for the full design.
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
  private logger = getLogger().child('NestedStackProvider');

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
  disableOuterRetry = true;

  /**
   * The CC API fallback path for `AWS::CloudFormation::Stack` would call
   * CloudFormation's own `CreateStack` — defeating cdkd's whole "no CFn"
   * approach for the nested children. Refuse the fallback so any future
   * regression that drops a real property from `handledProperties`
   * surfaces as an explicit "unhandled property" deploy error instead of
   * silently round-tripping through CloudFormation.
   */
  disableCcApiFallback = true;

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
        [
          'NotificationARNs',
          'CFn-only SNS-on-stack-event surface — cdkd has no equivalent (issue #459 design §9)',
        ],
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
          'CFn-only stack-create deadline — cdkd uses per-resource --resource-timeout instead (issue #459 design §9)',
        ],
      ]),
    ],
  ]);

  async create(
    logicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    const ctx = this.requireContext();
    this.requireDeployContext(ctx, 'create');

    const childTemplatePath = ctx.nestedTemplates![logicalId];
    if (!childTemplatePath) {
      throw new Error(
        `Nested template file not found for AWS::CloudFormation::Stack '${logicalId}' under parent ` +
          `'${ctx.parentStackName}'. Verify the synth output emits Metadata['aws:asset:path'] ` +
          `on this resource (CDK 2.x cdk.NestedStack does so by default).`
      );
    }

    const childTemplate = this.readChildTemplate(childTemplatePath);
    const childStackName = this.deriveChildStackName(ctx.parentStackName, logicalId);
    const childRegion = ctx.parentRegion;
    const childParameters = this.extractParameters(properties);
    const grandchildTemplates = this.indexGrandchildTemplates(childTemplate, childTemplatePath);

    const resourceCount = Object.keys(childTemplate.Resources ?? {}).length;
    this.logger.info(
      `Deploying nested stack ${childStackName} (logicalId=${logicalId}, ${resourceCount} resource(s))`
    );

    await this.runChildDeploy(
      ctx,
      logicalId,
      childStackName,
      childRegion,
      childTemplate,
      childParameters,
      grandchildTemplates
    );

    const attributes = await this.readChildOutputsAsAttributes(ctx, childStackName, childRegion);

    return {
      physicalId: this.synthesizeArn(
        ctx.accountId,
        ctx.parentRegion,
        ctx.parentStackName,
        logicalId
      ),
      attributes,
    };
  }

  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const ctx = this.requireContext();
    this.requireDeployContext(ctx, 'update');

    const childTemplatePath = ctx.nestedTemplates![logicalId];
    if (!childTemplatePath) {
      throw new Error(
        `Nested template file not found for AWS::CloudFormation::Stack '${logicalId}' on update.`
      );
    }

    const childTemplate = this.readChildTemplate(childTemplatePath);
    const childStackName = this.deriveChildStackName(ctx.parentStackName, logicalId);
    const childRegion = ctx.parentRegion;
    const childParameters = this.extractParameters(properties);
    const grandchildTemplates = this.indexGrandchildTemplates(childTemplate, childTemplatePath);

    const resourceCount = Object.keys(childTemplate.Resources ?? {}).length;
    this.logger.info(
      `Updating nested stack ${childStackName} (logicalId=${logicalId}, ${resourceCount} resource(s))`
    );

    // The child's own DeployEngine handles CREATE / UPDATE / DELETE per
    // resource based on its diff against the child's state — so calling
    // `deploy()` here naturally covers add / remove / mutate inside the
    // child. The parent's physicalId (synthesized ARN) is stable as long
    // as the parent stack name + nested logical id don't change.
    await this.runChildDeploy(
      ctx,
      logicalId,
      childStackName,
      childRegion,
      childTemplate,
      childParameters,
      grandchildTemplates
    );

    const attributes = await this.readChildOutputsAsAttributes(ctx, childStackName, childRegion);

    return {
      physicalId,
      wasReplaced: false,
      attributes,
    };
  }

  async delete(
    logicalId: string,
    _physicalId: string,
    _resourceType: string,
    _properties?: Record<string, unknown>,
    deleteContext?: DeleteContext
  ): Promise<void> {
    const ctx = this.requireContext();
    const childStackName = this.deriveChildStackName(ctx.parentStackName, logicalId);
    const childRegion = ctx.parentRegion;

    // Treat a missing child state file as idempotent success — the child
    // was never deployed or was already destroyed out-of-band. Mirrors
    // every other provider's "not found = already gone" delete semantic.
    const childStateData = await ctx.stateBackend.getState(childStackName, childRegion);
    if (!childStateData) {
      this.logger.debug(
        `Nested stack ${childStackName} has no state — treating delete as idempotent success.`
      );
      return;
    }

    const resourceCount = Object.keys(childStateData.state.resources).length;
    this.logger.info(
      `Destroying nested stack ${childStackName} (logicalId=${logicalId}, ${resourceCount} resource(s))`
    );

    // Switch the ALS context so any grandchildren the child contains
    // resolve against the right "parent" (the child) when their own
    // NestedStackProvider.delete fires from inside runDestroyForStack.
    const childCtx: NestedStackProviderContext = {
      ...ctx,
      parentStackName: childStackName,
      parentRegion: childRegion,
      nestedTemplates: undefined,
    };

    await withNestedStackContext(childCtx, () =>
      runDestroyForStack(childStackName, childStateData.state, {
        stateBackend: ctx.stateBackend,
        lockManager: ctx.lockManager,
        providerRegistry: ctx.providerRegistry,
        baseAwsClients: ctx.awsClients,
        baseRegion: childRegion,
        stateBucket: ctx.stateBucket,
        // Parent has already confirmed the cascading destroy — children
        // are not separately confirmable per design §7.
        skipConfirmation: true,
        ...(ctx.exportIndexStore && { exportIndexStore: ctx.exportIndexStore }),
        ...(ctx.destroyOptions?.profile && { profile: ctx.destroyOptions.profile }),
        ...(deleteContext?.removeProtection === true && { removeProtection: true }),
        ...(ctx.destroyOptions?.resourceWarnAfterMs !== undefined && {
          resourceWarnAfterMs: ctx.destroyOptions.resourceWarnAfterMs,
        }),
        ...(ctx.destroyOptions?.resourceTimeoutMs !== undefined && {
          resourceTimeoutMs: ctx.destroyOptions.resourceTimeoutMs,
        }),
        ...(ctx.destroyOptions?.resourceWarnAfterByType && {
          resourceWarnAfterByType: ctx.destroyOptions.resourceWarnAfterByType,
        }),
        ...(ctx.destroyOptions?.resourceTimeoutByType && {
          resourceTimeoutByType: ctx.destroyOptions.resourceTimeoutByType,
        }),
      })
    );
  }

  async getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // The intrinsic-function resolver fast-paths `Fn::GetAtt: [<NestedStack>, 'Outputs.<Key>']`
    // via the resource's recorded `attributes['Outputs.<Key>']` (populated in
    // create / update). Reaching this method means the resolver fell through
    // the flat-key lookup — only happens when the user references an
    // attribute name cdkd did not record. Surface a clear error rather
    // than returning undefined silently.
    throw new Error(
      `AWS::CloudFormation::Stack: attribute '${attributeName}' is not in the recorded Outputs map. ` +
        `Only 'Outputs.<Key>' references to declared Output names on the child template are supported.`
    );
  }

  // ----- private helpers -----

  private async runChildDeploy(
    parentCtx: NestedStackProviderContext,
    logicalId: string,
    childStackName: string,
    childRegion: string,
    childTemplate: CloudFormationTemplate,
    childParameters: Record<string, string>,
    grandchildTemplates: Record<string, string>
  ): Promise<void> {
    const childEngine = new DeployEngine(
      parentCtx.stateBackend,
      parentCtx.lockManager,
      parentCtx.dagBuilder!,
      parentCtx.diffCalculator!,
      parentCtx.providerRegistry,
      {
        ...(parentCtx.options ?? {}),
        ...(Object.keys(childParameters).length > 0 && { parameters: childParameters }),
        parentStackInfo: {
          parentStack: parentCtx.parentStackName,
          parentLogicalId: logicalId,
          parentRegion: parentCtx.parentRegion,
        },
      },
      childRegion,
      parentCtx.exportIndexStore
    );

    const childCtx: NestedStackProviderContext = {
      ...parentCtx,
      parentStackName: childStackName,
      parentRegion: childRegion,
      nestedTemplates: grandchildTemplates,
    };

    await withNestedStackContext(childCtx, () => childEngine.deploy(childStackName, childTemplate));
  }

  private async readChildOutputsAsAttributes(
    ctx: NestedStackProviderContext,
    childStackName: string,
    childRegion: string
  ): Promise<Record<string, unknown>> {
    const childStateData = await ctx.stateBackend.getState(childStackName, childRegion);
    if (!childStateData) {
      throw new Error(
        `Child stack state '${childStackName}' not found after deploy — NestedStackProvider invariant violated.`
      );
    }
    return this.buildOutputsAttributes(childStateData.state.outputs ?? {});
  }

  private requireContext(): NestedStackProviderContext {
    const ctx = getCurrentNestedStackContext();
    if (!ctx) {
      throw new Error(
        'NestedStackProvider invoked outside withNestedStackContext() scope. ' +
          'The deploy / destroy CLI entry point must wrap its DeployEngine.deploy / ' +
          'runDestroyForStack call in withNestedStackContext(ctx, () => ...).'
      );
    }
    return ctx;
  }

  private requireDeployContext(ctx: NestedStackProviderContext, op: 'create' | 'update'): void {
    if (!ctx.nestedTemplates || !ctx.dagBuilder || !ctx.diffCalculator) {
      throw new Error(
        `NestedStackProvider.${op}: deploy-mode context fields (nestedTemplates / dagBuilder / diffCalculator) ` +
          `are missing. This usually means a destroy-mode entry point called into create/update by mistake.`
      );
    }
  }

  private deriveChildStackName(parentStackName: string, nestedLogicalId: string): string {
    // `~` separator avoids ambiguity with CDK Stage paths (which use `/`).
    return `${parentStackName}~${nestedLogicalId}`;
  }

  private synthesizeArn(
    accountId: string,
    region: string,
    parentStackName: string,
    logicalId: string
  ): string {
    // Per design §3: partition `cdkd-local` is load-bearing — any consumer
    // that misuses this value as a real AWS ARN fails loudly with
    // `Invalid ARN partition: cdkd-local` rather than silently using a
    // non-ARN string.
    return `arn:cdkd-local:${region}:${accountId}:nested-stack/${parentStackName}/${logicalId}`;
  }

  private extractParameters(properties: Record<string, unknown>): Record<string, string> {
    const params = properties['Parameters'];
    if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      // Intrinsics in Parameter values were already resolved by the
      // parent's IntrinsicFunctionResolver before reaching the provider,
      // so the value here is a literal — cast non-string scalars to string
      // (matches CFn's own coercion of NumberParameter to string at boundary).
      result[k] = typeof v === 'string' ? v : String(v);
    }
    return result;
  }

  private readChildTemplate(templatePath: string): CloudFormationTemplate {
    let raw: string;
    try {
      raw = fs.readFileSync(templatePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read nested template at ${templatePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      return JSON.parse(raw) as CloudFormationTemplate;
    } catch (err) {
      throw new Error(
        `Failed to parse nested template at ${templatePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private indexGrandchildTemplates(
    childTemplate: CloudFormationTemplate,
    childTemplatePath: string
  ): Record<string, string> {
    const dir = path.dirname(childTemplatePath);
    const result: Record<string, string> = {};
    for (const [grandLogicalId, resource] of Object.entries(childTemplate.Resources ?? {})) {
      if (resource?.Type !== 'AWS::CloudFormation::Stack') continue;
      const meta = resource.Metadata as Record<string, unknown> | undefined;
      const assetPath = meta?.['aws:asset:path'];
      if (typeof assetPath === 'string' && assetPath.length > 0) {
        result[grandLogicalId] = path.join(dir, assetPath);
      }
    }
    return result;
  }

  private buildOutputsAttributes(outputs: Record<string, unknown>): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(outputs)) {
      attributes[`Outputs.${key}`] = value;
    }
    return attributes;
  }
}
