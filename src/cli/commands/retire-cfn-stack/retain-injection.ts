import { CloudFormationClient, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { uploadCfnTemplate, type CfnUploadS3ClientOpts } from '../../upload-cfn-template.js';
import {
  detectTemplateFormat,
  parseCfnTemplate,
  stringifyCfnTemplate,
  type TemplateFormat,
} from '../../yaml-cfn.js';
import {
  NESTED_STACK_RESOURCE_TYPE,
  type CfnStackResourceTree,
  TEMPLATE_URL_LIMIT,
  type RetireCloudFormationStackOptions,
} from './types.js';

/**
 * Upload the Retain-injected template body to the cdkd state bucket and
 * return both a virtual-hosted-style HTTPS URL CloudFormation can fetch via
 * `UpdateStack TemplateURL` and a `cleanup` callback that deletes the object
 * (and destroys the S3 client).
 *
 * The state bucket's actual region is resolved via `GetBucketLocation`
 * (cached per-process) so the upload client and the URL match the bucket's
 * region — the `cdkd import` CLI's profile region is irrelevant here.
 *
 * Cleanup is the caller's responsibility: invoke `cleanup` in a `finally`
 * around the UpdateStack call. CloudFormation copies the template into its
 * own internal storage during the synchronous UpdateStack API call, so the
 * S3 object is no longer needed after that call returns (success or
 * failure).
 *
 * Exported for unit testing.
 */
export async function uploadTemplateForUpdateStack(args: {
  bucket: string;
  body: string;
  cfnStackName: string;
  /**
   * Source template format. Drives the S3 key extension and `Content-Type`
   * so a YAML-authored template stays YAML in the transient upload and
   * CloudFormation reads it as such.
   */
  format?: TemplateFormat;
  s3ClientOpts?: RetireCloudFormationStackOptions['s3ClientOpts'];
}): Promise<{ url: string; cleanup: () => Promise<void> }> {
  // Thin wrapper over the shared {@link uploadCfnTemplate} helper. Kept as
  // a named export so the legacy retire-cfn-stack call sites and tests
  // continue to work unchanged; the upload + cleanup contract lives in
  // `src/cli/upload-cfn-template.ts` and is also consumed by `cdkd
  // export`'s phase-1 / phase-2 changeset call paths. The optional
  // `format` argument is forwarded so YAML-authored templates stay YAML
  // on the transient S3 object (`.yaml` key + `application/x-yaml`).
  return uploadCfnTemplate({
    bucket: args.bucket,
    body: args.body,
    stackName: args.cfnStackName,
    ...(args.format && { format: args.format }),
    ...(args.s3ClientOpts && { s3ClientOpts: args.s3ClientOpts }),
  });
}

/**
 * Parse a CloudFormation template body (JSON or YAML), set
 * `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` on every
 * resource that doesn't already have those exact values, and re-serialize
 * in the SAME format as the input. Returns the resulting body, a
 * `modified` flag, and the detected source format so callers can stamp
 * the right content type / S3 key extension on follow-up uploads.
 *
 * YAML templates are routed through cdkd's CFn-aware YAML codec
 * (`src/cli/yaml-cfn.ts`), which preserves every CFn shorthand intrinsic
 * (`!Ref`, `!GetAtt`, `!Sub`, etc.) on round-trip. JSON templates take
 * the canonical two-space-indented JSON path.
 *
 * Exported for unit testing (the AWS round-trips are mocked, but the
 * mutation logic itself is pure and worth exercising directly).
 */
export function injectRetainPolicies(
  templateBody: string,
  cfnStackName: string
): { body: string; modified: boolean; format: TemplateFormat } {
  const format = detectTemplateFormat(templateBody);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCfnTemplate(templateBody);
  } catch (err) {
    throw new Error(
      `Template for '${cfnStackName}' is not a valid CloudFormation template. ` +
        `cdkd's --migrate-from-cloudformation flow supports both JSON and YAML templates ` +
        `(YAML via a CFn-aware codec that preserves !Ref / !GetAtt / !Sub shorthand). ` +
        `Cause: ${describeAwsFailure(err).detail}`
    );
  }
  if (
    !('Resources' in parsed) ||
    typeof parsed['Resources'] !== 'object' ||
    parsed['Resources'] === null ||
    Array.isArray(parsed['Resources'])
  ) {
    throw new Error(
      `Template for '${cfnStackName}' has no Resources section — refusing to retire.`
    );
  }

  const modified = injectRetainPoliciesOnParsedResources(
    parsed['Resources'] as Record<string, unknown>
  );
  return { body: stringifyCfnTemplate(parsed, format), modified, format };
}

/**
 * Cheap sniff: does the template body contain any `AWS::CloudFormation::Stack`
 * resource rows? Parses + walks `Resources` once (no recursive descent),
 * tolerating parse failures by returning `false` (the caller's downstream
 * parse step will surface the same error with a richer message). Used by
 * `prepareCloudFormationStackRetirement` to decide whether to lazily build the
 * recursive {@link CfnStackResourceTree} — non-nested templates skip the
 * extra `DescribeStackResources` round-trip entirely.
 */
export function templateContainsNestedStackRows(templateBody: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCfnTemplate(templateBody);
  } catch {
    return false;
  }
  const resources = parsed['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return false;
  for (const resource of Object.values(resources as Record<string, unknown>)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    if ((resource as Record<string, unknown>)['Type'] === NESTED_STACK_RESOURCE_TYPE) {
      return true;
    }
  }
  return false;
}

/**
 * Mutate an already-parsed `Resources` map in place: set `DeletionPolicy: Retain`
 * and `UpdateReplacePolicy: Retain` on every leaf resource that doesn't
 * already have them. Returns the `modified` flag so the caller can decide
 * whether the round-trip is worth a `stringifyCfnTemplate` re-serialization
 * (and whether `UpdateStack` is needed at all).
 *
 * `AWS::CloudFormation::Stack` resources are **intentionally skipped** — see
 * issue [#464](https://github.com/go-to-k/cdkd/issues/464) and the design at
 * [docs/design/464-nested-stacks-export-import.md](../../../docs/design/464-nested-stacks-export-import.md)
 * §3.4. Retain on a nested-stack row tells AWS CFn's parent-side `DeleteStack`
 * to NOT cascade-delete the child stack record at all, which would leave a
 * stranded child stack record on AWS that the user has to clean up manually.
 * We want the cascade to descend (so child stack records get deleted as the
 * tree unwinds) while every child's own leaf resources stay because THEIR
 * Retain was injected on the previous recursion level — the recursive
 * Retain injection in {@link injectRetainPoliciesRecursive} relies on this
 * skip rule to behave correctly.
 *
 * `UpdateReplacePolicy: Retain` matters only when the Retain update REPLACES
 * a resource (issue #4873): the superseded copy is then kept rather than
 * deleted by an update the operator did not author, and the import reports it.
 *
 * Shared between the single-template path ({@link injectRetainPolicies}) and
 * the per-level walk inside {@link injectRetainPoliciesRecursive} so both
 * sites apply the exact same skip rule with no risk of drift.
 */
function injectRetainPoliciesOnParsedResources(resources: Record<string, unknown>): boolean {
  let modified = false;
  for (const [, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    if (r['Type'] === NESTED_STACK_RESOURCE_TYPE) continue;
    if (r['DeletionPolicy'] !== 'Retain') {
      r['DeletionPolicy'] = 'Retain';
      modified = true;
    }
    if (r['UpdateReplacePolicy'] !== 'Retain') {
      r['UpdateReplacePolicy'] = 'Retain';
      modified = true;
    }
  }
  return modified;
}

/**
 * Recursive variant of {@link injectRetainPolicies} that handles a parent
 * template containing one or more `AWS::CloudFormation::Stack` rows. Issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464); see
 * [docs/design/464-nested-stacks-export-import.md](../../../docs/design/464-nested-stacks-export-import.md)
 * §3.4 for the design rationale.
 *
 * For each nested-stack row in the parent template:
 *   1. `GetTemplate` Original-stage on the corresponding child stack ARN (read
 *      from the supplied {@link CfnStackResourceTree}, populated up front by
 *      `getCloudFormationResourceTree`).
 *   2. Recursively process the child template — Retain injection on its
 *      leaves AND further recursion into any grandchildren.
 *   3. If the recursion produced a modified child body, upload the modified
 *      body to the cdkd state bucket via the shared {@link uploadCfnTemplate}
 *      helper and rewrite the parent's `Properties.TemplateURL` for that
 *      row to the uploaded URL — so the parent's eventual `UpdateStack`
 *      cascades into the child with the Retain-bearing template.
 *
 * After all nested-stack rows are processed, the parent's own leaf
 * resources get Retain injected via {@link injectRetainPoliciesOnParsedResources}
 * — the SAME helper the single-template path uses, applying the same
 * "skip `AWS::CloudFormation::Stack` rows" rule (those rows must NOT have
 * Retain or cascade-delete won't descend — see the helper's doc-comment).
 *
 * The returned `cleanups` array carries one S3 delete callback per
 * transient child-template upload made anywhere in the recursive walk.
 * The caller drains it in a `finally` block around the parent
 * `UpdateStack` call — CFn fetches each child template synchronously
 * during `UpdateStack`, so the transient objects can be reaped as soon
 * as that call returns (success OR failure). When the helper itself
 * throws mid-walk, the partial uploads accumulated so far are returned
 * via a thrown {@link RecursiveRetainInjectionError} so the outer
 * `finally` can still reap them — losing the throw stack vs. the
 * cleanups would have leaked transient S3 objects.
 *
 * Exported so the recursive call can be unit-tested end-to-end (the AWS
 * round-trips are mocked at the SDK boundary, but the recursion shape
 * itself is the load-bearing piece).
 */
export async function injectRetainPoliciesRecursive(
  rootTemplateBody: string,
  rootCfnStackName: string,
  rootTree: CfnStackResourceTree,
  deps: {
    cfnClient: CloudFormationClient;
    stateBucket: string;
    s3ClientOpts?: CfnUploadS3ClientOpts;
  }
): Promise<{
  body: string;
  modified: boolean;
  format: TemplateFormat;
  cleanups: (() => Promise<void>)[];
}> {
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const result = await injectRetainPoliciesRecursiveInternal(
      rootTemplateBody,
      rootCfnStackName,
      rootTree,
      deps,
      cleanups
    );
    return { ...result, cleanups };
  } catch (err) {
    throw new RecursiveRetainInjectionError(
      describeAwsFailure(err).detail,
      cleanups,
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * Thrown by {@link injectRetainPoliciesRecursive} when the recursive walk
 * fails partway through. Carries the array of cleanup callbacks for every
 * successful transient S3 upload made BEFORE the failure so the outer
 * `finally` in `prepareCloudFormationStackRetirement` can still reap them.
 *
 * Without this, a mid-walk error would lose every accumulated cleanup —
 * the error path would skip the parent's `finally` block that drains
 * `nestedCleanups`, leaking N transient S3 objects per failed retire.
 */
export class RecursiveRetainInjectionError extends Error {
  readonly cleanups: (() => Promise<void>)[];
  override readonly cause?: Error;
  constructor(message: string, cleanups: (() => Promise<void>)[], cause?: Error) {
    super(message);
    this.name = 'RecursiveRetainInjectionError';
    this.cleanups = cleanups;
    if (cause) this.cause = cause;
  }
}

async function injectRetainPoliciesRecursiveInternal(
  templateBody: string,
  cfnStackName: string,
  tree: CfnStackResourceTree,
  deps: {
    cfnClient: CloudFormationClient;
    stateBucket: string;
    s3ClientOpts?: CfnUploadS3ClientOpts;
  },
  cleanups: (() => Promise<void>)[]
): Promise<{ body: string; modified: boolean; format: TemplateFormat }> {
  const format = detectTemplateFormat(templateBody);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCfnTemplate(templateBody);
  } catch (err) {
    throw new Error(
      `Template for '${cfnStackName}' is not a valid CloudFormation template. ` +
        `cdkd's --migrate-from-cloudformation flow supports both JSON and YAML templates ` +
        `(YAML via a CFn-aware codec that preserves !Ref / !GetAtt / !Sub shorthand). ` +
        `Cause: ${describeAwsFailure(err).detail}`
    );
  }
  if (
    !('Resources' in parsed) ||
    typeof parsed['Resources'] !== 'object' ||
    parsed['Resources'] === null ||
    Array.isArray(parsed['Resources'])
  ) {
    throw new Error(
      `Template for '${cfnStackName}' has no Resources section — refusing to retire.`
    );
  }
  const resources = parsed['Resources'] as Record<string, unknown>;
  let modified = false;

  // 1. Recurse into each nested-stack row first. Done before the leaf-level
  //    Retain injection so we can rewrite `Properties.TemplateURL` and
  //    flip `modified` to true via the same `modified` accumulator the
  //    leaf injection uses below.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    if (r['Type'] !== NESTED_STACK_RESOURCE_TYPE) continue;

    const childNode = tree.nested.get(logicalId);
    if (!childNode) {
      throw new Error(
        `Template for '${cfnStackName}' has nested-stack '${logicalId}' (Type: ` +
          `${NESTED_STACK_RESOURCE_TYPE}) but the CloudFormation resource tree has no ` +
          `matching child entry. AWS may have removed the child since DescribeStackResources ` +
          `ran, or the template was hand-edited mid-flight — re-run \`cdkd import --migrate-from-cloudformation\` ` +
          `to refresh.`
      );
    }

    const childTpl = await deps.cfnClient.send(
      new GetTemplateCommand({ StackName: childNode.physicalId, TemplateStage: 'Original' })
    );
    if (!childTpl.TemplateBody) {
      throw new Error(
        `GetTemplate returned no body for nested stack '${logicalId}' ` +
          `(physicalId='${childNode.physicalId}', parent='${cfnStackName}').`
      );
    }

    const childResult = await injectRetainPoliciesRecursiveInternal(
      childTpl.TemplateBody,
      childNode.stackName,
      childNode,
      deps,
      cleanups
    );

    if (childResult.modified) {
      // Upload the modified child body and rewrite the parent's
      // TemplateURL to point at it. Done only when the child was actually
      // mutated — an already-fully-Retain'd child needs no re-upload, and
      // the parent's pre-existing TemplateURL (pointing at the CDK
      // asset bucket) is fine as-is. Per-child upload size is bounded by
      // the same 51,200-byte inline ceiling AND the 1 MB CloudFormation
      // TemplateURL ceiling that the parent enforces — overflow surfaces
      // the same hard error.
      if (childResult.body.length > TEMPLATE_URL_LIMIT) {
        throw new Error(
          `Modified nested-stack template for '${logicalId}' is ${childResult.body.length} ` +
            `bytes, exceeds the CloudFormation TemplateURL limit (${TEMPLATE_URL_LIMIT}). ` +
            `cdkd state has not been written; shrink the child template and retry, or ` +
            `retire the stack manually: (1) UpdateStack with Retain policies on the ` +
            `parent and each child, (2) cdkd import, (3) DeleteStack on the parent.`
        );
      }
      const uploaded = await uploadCfnTemplate({
        bucket: deps.stateBucket,
        body: childResult.body,
        // Include both parent + child in the S3 key prefix so leftover
        // transient objects (cleanup failures) are still traceable to the
        // exact migration call by humans grepping the bucket.
        stackName: `${cfnStackName}__nested__${logicalId}`,
        format: childResult.format,
        ...(deps.s3ClientOpts && { s3ClientOpts: deps.s3ClientOpts }),
      });
      cleanups.push(uploaded.cleanup);

      const propsRaw = r['Properties'];
      const props =
        propsRaw && typeof propsRaw === 'object' && !Array.isArray(propsRaw)
          ? (propsRaw as Record<string, unknown>)
          : ((r['Properties'] = {}) as Record<string, unknown>);
      props['TemplateURL'] = uploaded.url;
      modified = true;
    }
  }

  // 2. Inject Retain on every non-nested-stack resource at THIS level.
  //    Uses the shared helper so the skip rule for `AWS::CloudFormation::Stack`
  //    rows (must NOT have Retain — see the helper's doc-comment) lives in
  //    one place.
  if (injectRetainPoliciesOnParsedResources(resources)) {
    modified = true;
  }

  return { body: stringifyCfnTemplate(parsed, format), modified, format };
}
