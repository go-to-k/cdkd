import { readFileSync } from 'node:fs';
import {
  cdkdRemedy,
  commandHole,
  pasteableCommand,
  type CommandArg,
} from '../../../utils/pasteable-command.js';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { confirmOrRefuse } from '../confirm-prompt.js';
import { isAwsCliLiteral } from '../../../provisioning/replacement-protection-advice.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { parseCfnTemplateWithFormat, type TemplateFormat } from '../../yaml-cfn.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';
import { quotedOrNotShown, quotedRegion, safeDetail } from './render.js';
import { fsReadErrorCause } from './stack-tree.js';

/**
 * The `--stack-name` argument of an `aws cloudformation ...` command this file
 * prints. The shared shell gate (`pasteableCommand`) decides what a SHELL does
 * with the value; the aws CLI acts on some inert values itself — a `file://`
 * or `https://` prefix reads a file or URL, `@=` is shorthand, a leading `-`
 * is a flag — so such a name becomes the `'<stack-name>'` hole too
 * (`isAwsCliLiteral`, go-to-k/cdkd#4199). The name is `--cfn-stack-name` or
 * the synthesized stack's, which nothing validates on the flat path.
 * Exported for unit testing.
 */
export function awsStackNameArg(value: string): CommandArg {
  return isAwsCliLiteral(value)
    ? { flag: '--stack-name', value, hole: 'stack-name' }
    : { flag: '--stack-name', hole: 'stack-name' };
}

/**
 * The by-hand phase-2 UPDATE a failed single-stack export prints
 * (go-to-k/cdkd#3371). The CloudFormation stack name is `--cfn-stack-name` or
 * the synthesized stack's, neither validated against CloudFormation's grammar
 * on this path, so it goes through the shared gate and becomes the
 * `'<stack-name>'` hole when it is not inert on a command line. The template
 * placeholder is QUOTED: a bare `<full-template.json>` is two shell
 * redirections when pasted. Exported for unit testing.
 */
export function phase2RetryCommand(cfnStackName: string): string {
  return pasteableCommand(withPasteableAwsProfile('aws cloudformation create-change-set'), [
    awsStackNameArg(cfnStackName),
    { literal: '--change-set-name cdkd-phase2-retry --change-set-type UPDATE' },
    { literal: "--template-body 'file://<full-template.json>'" },
  ]).command;
}

/**
 * One `listStacks` region for a `', '`-joined list: `(legacy)` for a
 * region-less legacy record — cdkd's own label, never a record value — and
 * {@link quotedOrNotShown} otherwise, since each region is an S3 key segment
 * or a legacy body's field (go-to-k/cdkd#3371).
 */
function regionListMember(region: string | undefined): string {
  return region === undefined ? '(legacy)' : quotedRegion(region);
}

/**
 * Decide which region's state to operate on. Mirrors the disambiguation
 * logic shared with `state resources` / `state show` / `orphan`. Exported for
 * unit testing.
 */
export async function pickStackRegion(
  stateBackend: S3StateBackend,
  stackName: string,
  synthRegion: string | undefined,
  flag: string | undefined
): Promise<string> {
  const refs = (await stateBackend.listStacks()).filter((r) => r.stackName === stackName);
  if (refs.length === 0) {
    if (flag) return flag;
    if (synthRegion) return synthRegion;
    throw new Error(
      `No state found for stack ${quotedOrNotShown(stackName)}. Run '${cdkdRemedy('cdkd state list')}' to see available stacks.`
    );
  }
  if (flag) {
    const found = refs.find((r) => r.region === flag);
    if (!found) {
      // Each element is an S3 KEY SEGMENT `listStacks` split out, so it is
      // bucket-plantable in its own right (go-to-k/cdkd#3328 round 7), and
      // `--stack-region` is the operator's own argument; both through
      // `quotedOrNotShown` (go-to-k/cdkd#3371), since a raw value runs once a
      // pasted selection reaches it (go-to-k/cdkd#4205).
      const seen = refs.map((r) => regionListMember(r.region)).join(', ');
      throw new Error(
        `No state found for stack ${quotedOrNotShown(stackName)} in region ` +
          `${quotedOrNotShown(flag)}. Available regions: ${seen}.`
      );
    }
    return flag;
  }
  if (synthRegion) {
    const found = refs.find((r) => r.region === synthRegion);
    if (found) return synthRegion;
  }
  if (refs.length === 1) {
    return refs[0]!.region ?? synthRegion ?? '';
  }
  const regions = refs.map((r) => regionListMember(r.region)).join(', ');
  throw new Error(
    `Stack ${quotedOrNotShown(stackName)} has state in multiple regions: ${regions}. ` +
      `Re-run with --stack-region ${commandHole('region')} to disambiguate.`
  );
}

export function parseTemplateFile(path: string): {
  template: Record<string, unknown>;
  format: TemplateFormat;
} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      // The fs CODE only: the error's message repeats the path verbatim, which
      // would undo the boundary on the path one clause earlier.
      `Failed to read template file ${quotedOrNotShown(path)}: ${fsReadErrorCause(err)}`
    );
  }
  try {
    const { template, format } = parseCfnTemplateWithFormat(raw);
    return { template, format };
  } catch (err) {
    throw new Error(
      `Template file ${quotedOrNotShown(path)} is not a valid CloudFormation template. ` +
        `cdkd export accepts JSON and YAML (YAML via a CFn-aware codec that ` +
        `preserves !Ref / !GetAtt / !Sub shorthand). Cause: ${safeDetail(err)}`
    );
  }
}

export async function assertCfnStackAbsent(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string
): Promise<void> {
  try {
    const resp = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = resp.Stacks?.[0];
    if (!stack) return;
    // REVIEW_IN_PROGRESS comes from a failed CreateChangeSet IMPORT that
    // was never deleted; surfacing it lets the user clean up before retry.
    throw new Error(
      `CloudFormation stack ${quotedOrNotShown(stackName)} already exists ` +
        `(status: ${stack.StackStatus ?? 'unknown'}). cdkd export ` +
        `only creates new stacks via IMPORT — delete or rename the existing stack first, ` +
        `or pass --cfn-stack-name to choose a different name.`
    );
  } catch (err) {
    const msg = describeAwsFailure(err).detail;
    if (/does not exist/i.test(msg)) {
      // Expected: stack does not exist, we can proceed.
      return;
    }
    throw err;
  }
}

/**
 * Refuse to proceed when the user passed CLI `-c key=value` overrides
 * without `--accept-transient-context`. The CLI form is not persisted
 * to `cdk.json` / `cdk.context.json`, so a subsequent `cdk deploy`
 * invoked without the same `-c` flags will synthesize a different
 * template — and CFn will see drift / replace resources on first
 * post-migration deploy.
 *
 * The escape hatch (`--accept-transient-context`) is intentionally
 * loud at runtime: a warn is emitted that names every override and
 * tells the user to keep them around for future `cdk deploy` runs.
 *
 * Exported for unit testing.
 */
export function refuseTransientContextIfUnsafe(options: {
  context?: string[];
  acceptTransientContext: boolean;
}): void {
  const overrides = options.context ?? [];
  if (overrides.length === 0) return;

  if (!options.acceptTransientContext) {
    // Each value through `quotedOrNotShown` (go-to-k/cdkd#3371): the operator's
    // own `-c` values, printed in a command-shaped block.
    const indented = overrides.map((v) => `    -c ${quotedOrNotShown(v)}`).join('\n');
    throw new Error(
      `Refusing to export: ${overrides.length} CLI context override(s) supplied via -c are ` +
        `not persisted to cdk.json / cdk.context.json, so subsequent \`cdk deploy\` ` +
        `invocations will synthesize a different template and CFn will see drift or ` +
        `replace resources.\n\n` +
        `Supplied:\n${indented}\n\n` +
        `Choose one:\n` +
        `  (recommended) Move these values into cdk.json's "context": { ... } field, then re-run\n` +
        `                cdkd export without -c. CDK CLI reads cdk.json on every synth, so they\n` +
        `                will be picked up automatically.\n` +
        `  (escape)      Pass --accept-transient-context to proceed. You will then need to\n` +
        `                pass the SAME -c flags to every future \`cdk deploy\` for this stack.`
    );
  }

  const logger = getLogger();
  logger.warn(
    `--accept-transient-context: ${overrides.length} CLI context override(s) will not be ` +
      `persisted to cdk.json / cdk.context.json. Remember to pass the same -c flags to every ` +
      `future \`cdk deploy\` for this stack, or move them to cdk.json before then.`
  );
  for (const v of overrides) {
    logger.warn(`  -c ${quotedOrNotShown(v)}`);
  }
}

/**
 * Print a final "next steps" block listing the exact `cdk deploy` /
 * `cdk diff` commands the user should run to verify the migration and
 * to manage the stack going forward. Always emitted on successful
 * export — this is the load-bearing "handoff" message that lets a user
 * who runs `cdkd export` once a year find their way without consulting
 * the docs.
 *
 * When CLI `-c` overrides were used (with `--accept-transient-context`),
 * the printed `cdk deploy` and `cdk diff` commands include them, so a
 * copy-paste keeps the synth deterministic — except a value that is not
 * inert on a command line (JSON, a space): it is withheld everywhere (the
 * quoted hole `'<context>'` here, a description in the warning), and the
 * operator has it from their own command line. Exported for unit testing.
 */
export function printNextSteps(args: {
  cfnStackName: string;
  cdkStackName: string;
  contextOverrides: string[];
}): void {
  const logger = getLogger();
  // Through the shared gate (go-to-k/cdkd#3371): the stack name comes from the
  // synthesized app and each `-c` value from the command line, and both were
  // printed raw, so a value that is not inert on a command line ran when the
  // line was pasted. Such a value becomes a quoted hole.
  const cdkCommand = (verb: string): string =>
    pasteableCommand(verb, [
      { value: args.cdkStackName, hole: 'stack' },
      ...args.contextOverrides.map((v) => ({ flag: '-c', value: v, hole: 'context' })),
    ]).command;
  logger.info('');
  logger.info('Next steps — manage the stack with CDK CLI from now on:');
  logger.info(`  ${cdkCommand('cdk diff')}    # verify synth matches what CFn now holds`);
  logger.info(`  ${cdkCommand('cdk deploy')}  # subsequent updates`);
  if (args.contextOverrides.length > 0) {
    logger.info('');
    logger.info(
      '  NOTE: the -c flags above were captured from this export run. They MUST be ' +
        'passed on every future cdk invocation, or moved into cdk.json\'s "context" field.'
    );
  }
  logger.info('');
}

/**
 * `cdkd export`'s confirmation prompt, shared by its THREE call sites (the
 * rollback-journal override, the single-stack migration confirm, and the
 * nested-stack tree-wide confirm in `runPerStackImportLoop`). Every one of
 * them sits inside an `if (!options.yes ...)` block, which is what keeps
 * `confirmOrRefuse`'s non-interactive refusal (issue #2275) from firing on a
 * `--yes` run.
 *
 * Exported for unit testing — internal to the export flow otherwise.
 */
export async function confirmPrompt(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The cdkd export confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass -y / --yes to confirm, or run the command from a real ' +
      'terminal.',
  });
}
