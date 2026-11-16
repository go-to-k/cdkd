import * as fs from 'node:fs';
import * as path from 'node:path';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { resolveAssemblyPath } from '../../utils/assembly-path.js';
import { displayIdent, displayStackName } from '../../utils/display-safe.js';
import { SynthesisError } from '../../utils/error-handler.js';
import {
  findNestedTemplateTreeDefect,
  renderNestedTemplateTreeDefect,
} from '../../utils/nested-template-cycle.js';

/** The two `StackInfo` fields the pre-flight reads. */
export interface NestedTemplatePreflightStack {
  stackName: string;
  nestedTemplates?: Readonly<Record<string, string>> | undefined;
}

/**
 * Refuse a malformed nested-template tree (a cycle, an absolute
 * `aws:asset:path` below the top level, a chain too deep or a tree too large
 * to deploy) for every SELECTED stack, before `cdkd deploy` does anything a
 * refusal would have to undo (issue go-to-k/cdkd#3449).
 *
 * `NestedStackProvider` runs the same walk per nested-stack row
 * (go-to-k/cdkd#3247), which is the earliest point the provider owns: by then
 * the stack's assets are published, its lock is held, and any root resource
 * that does not depend on the nested row may already be created and must be
 * rolled back. Everything the walk reads is on disk as soon as synth returns,
 * so the CLI asks first and the deploy never starts. The provider call stays
 * as the guard for a context this command did not build.
 *
 * Read-only and synchronous: a few file reads per nested template, none at all
 * for a stack without nested-stack rows. One walk covers all of a stack's
 * top-level rows, so the walker's row budget is per STACK here and per row in
 * the provider; no CDK-generated assembly comes near either.
 *
 * The root template's own path is not seeded into the walk (`StackInfo` does
 * not carry it). Detection does not depend on the seed: a child that points
 * back at the root template is followed once around and refused when the walk
 * re-enters the first nested template it saw.
 *
 * `SynthesisError` because the defect is in the synthesized assembly, like the
 * absolute-path refusal `AssemblyReader` raises for a top-level row.
 * `markNonRetryable` because the message carries template-controlled text the
 * substring-matching retry classifier must never read, wherever the error ends
 * up being caught.
 */
export function refuseMalformedNestedTemplateTrees(
  stacks: readonly NestedTemplatePreflightStack[]
): void {
  for (const stack of stacks) {
    if (!stack.nestedTemplates) continue;
    const defect = findNestedTemplateTreeDefect(stack.nestedTemplates);
    if (!defect) continue;
    throw markNonRetryable(
      new SynthesisError(
        renderNestedTemplateTreeDefect(
          defect,
          stack.stackName,
          'start the deploy; nothing has been published or provisioned'
        )
      )
    );
  }
}

/** The three `StackInfo` fields the remote-template pre-flight reads. */
export interface RemoteNestedStackPreflightStack extends NestedTemplatePreflightStack {
  template: unknown;
}

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';
/** The suffix `AWS::SecretsManager-2024-09-16` appends to a rotation schedule's id. */
const HOSTED_ROTATION_SUFFIX = 'HostedRotationLambda';
/** Ancestor rows rendered in full before the middle of a deep owner is elided. */
const MAX_RENDERED_OWNER_IDS = 8;

/** `Object.entries` over a template's `Resources`, whatever its container shape. */
function resourceEntries(template: unknown): Array<[string, Record<string, unknown>]> {
  if (template === null || typeof template !== 'object') return [];
  const resources = (template as { Resources?: unknown }).Resources;
  if (resources === null || typeof resources !== 'object') return [];
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const [id, row] of Object.entries(resources)) {
    if (row !== null && typeof row === 'object') out.push([id, row as Record<string, unknown>]);
  }
  return out;
}

function readTemplateFile(templatePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  } catch {
    // The site that loads the template reports an unreadable one, with its own message.
    return undefined;
  }
}

/** `Root~A~B`, elided in the middle like the tree refusal's owner. */
function renderOwner(stackName: string, ancestorIds: readonly string[]): string {
  if (ancestorIds.length <= MAX_RENDERED_OWNER_IDS) {
    return displayStackName([stackName, ...ancestorIds].join('~'));
  }
  const keep = MAX_RENDERED_OWNER_IDS / 2;
  const head = displayStackName([stackName, ...ancestorIds.slice(0, keep)].join('~'));
  const tail = displayStackName(ancestorIds.slice(-keep).join('~'));
  return `${head}~...${ancestorIds.length - 2 * keep} more...~${tail}`;
}

/**
 * The hosted-rotation shape: `AWS::SecretsManager-2024-09-16` expands a
 * `HostedRotation.*` into `<schedule id>HostedRotationLambda`, a nested stack
 * whose `TemplateURL` is an AWS-hosted Serverless Application Repository
 * template, beside the `AWS::SecretsManager::RotationSchedule` it serves.
 */
function hostedRotationScheduleId(
  logicalId: string,
  rows: ReadonlyMap<string, Record<string, unknown>>
): string | undefined {
  if (!logicalId.endsWith(HOSTED_ROTATION_SUFFIX)) return undefined;
  const scheduleId = logicalId.slice(0, -HOSTED_ROTATION_SUFFIX.length);
  return rows.get(scheduleId)?.['Type'] === 'AWS::SecretsManager::RotationSchedule'
    ? scheduleId
    : undefined;
}

/**
 * Refuse an `AWS::CloudFormation::Stack` with no local template (a remote
 * `TemplateURL`, or a `cdk.NestedStack` synthesized with asset metadata
 * disabled) anywhere in a SELECTED stack's tree, before `cdkd deploy`
 * publishes or provisions anything (issue go-to-k/cdkd#6385).
 *
 * `NestedStackProvider` deploys a nested stack only from the template file
 * `Metadata['aws:asset:path']` names, so such a row always fails at its own
 * create, after every sibling that does not depend on it has been created and
 * then rolled back. The commonest route is a CDK `HostedRotation.*`: its row
 * exists only after the `AWS::SecretsManager-2024-09-16` transform expands, so
 * this runs AFTER macro expansion, unlike `refuseMalformedNestedTemplateTrees`
 * — whose earlier walk also guarantees the tree followed here is acyclic and
 * contained. The provider's own refusal stays as the backstop for a context
 * this command did not build.
 *
 * The top level is judged against `nestedTemplates` (what the provider looks
 * up); a child level against its rows' `aws:asset:path`, which is what the
 * provider indexes a grandchild by. Nested templates are not macro-expanded,
 * so a child template's row is judged as synthesized.
 *
 * A row carrying a `Condition`, and everything below it, is left to the
 * backstop: when the condition is false the row (and so its subtree) is never
 * created and the deploy succeeds today, so refusing it here would turn a
 * working deploy into a refusal. `onConditionalRow` hears one line per such
 * row that has no local template.
 *
 * Read-only and synchronous; no file read for a stack without nested rows,
 * and each child template is read once however many rows reach it.
 */
export function refuseRemoteNestedStackRows(
  stacks: readonly RemoteNestedStackPreflightStack[],
  onConditionalRow?: (message: string) => void
): void {
  for (const stack of stacks) {
    const visited = new Set<string>();
    const check = (
      template: unknown,
      templateDir: string | undefined,
      ancestorIds: readonly string[]
    ): void => {
      const entries = resourceEntries(template);
      const rows = new Map(entries);
      for (const [logicalId, row] of entries) {
        if (row['Type'] !== NESTED_STACK_TYPE) continue;
        let childPath: string | undefined;
        if (templateDir === undefined) {
          const index = stack.nestedTemplates;
          const entry =
            index && Object.prototype.hasOwnProperty.call(index, logicalId)
              ? index[logicalId]
              : undefined;
          childPath = typeof entry === 'string' && entry.length > 0 ? entry : undefined;
        } else {
          const meta = row['Metadata'] as Record<string, unknown> | null | undefined;
          const assetPath = meta?.['aws:asset:path'];
          if (typeof assetPath === 'string' && assetPath.length > 0) {
            const resolved = resolveAssemblyPath(templateDir, assetPath);
            // An uncontained path was refused by the tree pre-flight already.
            if (!resolved.contained) continue;
            childPath = resolved.path;
          }
        }
        if (row['Condition'] !== undefined) {
          // Not descended either: a false condition creates nothing below it.
          // Not marked visited, so a later unconditional row still walks it.
          if (childPath === undefined) {
            onConditionalRow?.(conditionalRowNote(stack.stackName, ancestorIds, logicalId));
          }
          continue;
        }
        if (childPath !== undefined) {
          const key = path.resolve(childPath);
          if (visited.has(key)) continue;
          visited.add(key);
          check(readTemplateFile(childPath), path.dirname(childPath), [...ancestorIds, logicalId]);
          continue;
        }
        throw markNonRetryable(
          new SynthesisError(renderRemoteNestedStack(stack.stackName, ancestorIds, logicalId, rows))
        );
      }
    };
    check(stack.template, undefined, []);
  }
}

function renderRemoteNestedStack(
  stackName: string,
  ancestorIds: readonly string[],
  logicalId: string,
  rows: ReadonlyMap<string, Record<string, unknown>>
): string {
  const where =
    ancestorIds.length === 0
      ? `stack ${displayStackName(stackName)}`
      : `nested stack ${renderOwner(stackName, ancestorIds)} (under stack ${displayStackName(stackName)})`;
  // The row is judged by its MISSING metadata only; TemplateURL is never read.
  // So the plain arm names both causes: a remote template, or a real
  // cdk.NestedStack synthesized with asset metadata turned off.
  const base =
    `${NESTED_STACK_TYPE} ${displayIdent(logicalId)} in ${where} has no template in the cloud ` +
    `assembly (no Metadata['aws:asset:path']), and cdkd deploys a nested stack only from the ` +
    `template file that metadata names.`;
  const scheduleId = hostedRotationScheduleId(logicalId, rows);
  const remedy =
    scheduleId !== undefined
      ? ` It is the nested stack the AWS::SecretsManager-2024-09-16 transform generates for the ` +
        `hosted rotation of AWS::SecretsManager::RotationSchedule ${displayIdent(scheduleId)} ` +
        `(a CDK HostedRotation.*), whose TemplateURL is a remote template. A nested stack with a ` +
        `remote TemplateURL is not supported. To deploy this stack with cdkd, rotate the secret ` +
        `with a function the app owns instead (addRotationSchedule's rotationLambda), or deploy ` +
        `it with the AWS CDK CLI.`
      : ` If it is a cdk.NestedStack synthesized with asset metadata disabled (the context ` +
        `aws:cdk:enable-asset-metadata set to false, or an assembly from cdk synth ` +
        `--no-asset-metadata), re-enable asset metadata and deploy again. If its TemplateURL is ` +
        `a remote template, that is not supported: deploy this stack with the AWS CDK CLI.`;
  return `${base}${remedy} Refusing to start the deploy; nothing has been published or provisioned.`;
}

function conditionalRowNote(
  stackName: string,
  ancestorIds: readonly string[],
  logicalId: string
): string {
  const where =
    ancestorIds.length === 0
      ? `stack ${displayStackName(stackName)}`
      : `nested stack ${renderOwner(stackName, ancestorIds)}`;
  return (
    `${NESTED_STACK_TYPE} ${displayIdent(logicalId)} in ${where} has no local template and a ` +
    `Condition; left to the deploy; a real deploy refuses it if the condition is true.`
  );
}
