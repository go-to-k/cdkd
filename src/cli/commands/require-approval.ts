/**
 * `cdkd deploy --require-approval` (AWS CDK CLI parity, aws/aws-cdk-cli#2021).
 *
 * The level is resolved here (CLI flag, then `requireApproval` in cdk.json);
 * the engine decides WHEN to ask, on the diff it is about to execute, and calls
 * the prompter built here to ask.
 */
import { Option } from 'commander';
import { formatDestructiveChange } from '../../analyzer/destructive-changes.js';
import type {
  DeploymentApprovalRequest,
  RequireApprovalLevel,
} from '../../deployment/deploy-engine/options.js';
import { displayIdent } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import type { Logger } from '../../types/config.js';
import { loadCdkJson } from '../config-loader.js';
import { confirmOrRefuse } from './confirm-prompt.js';

export const REQUIRE_APPROVAL_VALUES = ['never', 'any-change', 'destructive'] as const;

export const requireApprovalOption = new Option(
  '--require-approval <level>',
  'What changes require manual approval before they are deployed: "never" (default), "any-change", or "destructive" (a change that replaces, deletes or orphans an existing resource, including in nested stacks). Without a terminal the deploy fails instead of asking, unless --yes is given. Also read from "requireApproval" in cdk.json.'
).choices(REQUIRE_APPROVAL_VALUES);

/**
 * The level for this run: the flag, else cdk.json's top-level `requireApproval`
 * (where the AWS CDK CLI reads it), else `never` — cdkd has never asked.
 *
 * cdk.json's `broadening` (the AWS CDK CLI's own default, often written out
 * explicitly) is IGNORED with a warning rather than refused: cdkd has no
 * security diff to decide it, and cdkd read no `requireApproval` before, so
 * refusing would break deploys of apps that already carry it. The flag has no
 * such history, so `--require-approval broadening` is refused by its choices.
 */
export function resolveRequireApproval(
  cliValue: RequireApprovalLevel | undefined,
  logger: Pick<Logger, 'warn'>,
  cdkJson: { requireApproval?: unknown } | null = loadCdkJson()
): RequireApprovalLevel {
  if (cliValue !== undefined) return cliValue;
  const configured = cdkJson?.requireApproval;
  if (configured === undefined) return 'never';
  if ((REQUIRE_APPROVAL_VALUES as readonly unknown[]).includes(configured)) {
    return configured as RequireApprovalLevel;
  }
  if (configured === 'broadening') {
    logger.warn(
      `cdk.json "requireApproval": "broadening" is ignored: cdkd does not detect security-broadening changes, so no approval is asked. Use "any-change" or "destructive" to have cdkd ask.`
    );
    return 'never';
  }
  throw new CdkdError(
    `cdk.json "requireApproval" must be one of ${REQUIRE_APPROVAL_VALUES.join(', ')}, got: ${displayIdent(typeof configured === 'string' ? configured : JSON.stringify(configured))}`,
    'INVALID_REQUIRE_APPROVAL'
  );
}

/**
 * The engine's `approveDeployment`. `--yes` approves without asking. Otherwise
 * the changes are listed and the operator is asked; a non-interactive stdin is
 * refused (`confirmOrRefuse`), so CI fails instead of hanging. Stacks deploy
 * concurrently, so prompts are SERIALIZED, and the live progress area is taken
 * off the terminal while one is open. Output is written straight to the
 * terminal rather than through the logger, whose per-stack buffer would hold
 * it until that stack's deploy ends — after the question it explains.
 */
export function createApprovalPrompter(options: {
  yes: boolean;
}): (request: DeploymentApprovalRequest) => Promise<boolean> {
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    if (options.yes) return Promise.resolve(true);
    const asked = queue.then(() =>
      getLiveRenderer().suspendWhile(async () => {
        process.stdout.write(renderApprovalRequest(request));
        return confirmOrRefuse('Do you wish to deploy these changes?', {
          refusal:
            `Deployment of stack ${displayIdent(request.stackName)} requires approval ` +
            `(--require-approval=${request.level}), but stdin is not interactive. ` +
            `Re-run with --yes to deploy without asking, or review the changes with 'cdkd diff'.`,
          suffix: ' (y/n) ',
        });
      })
    );
    // The next prompt waits for this one to settle, whichever way.
    queue = asked.catch(() => undefined);
    return asked;
  };
}

/** The block printed above the question. Exported for tests. */
export function renderApprovalRequest(request: DeploymentApprovalRequest): string {
  const lines: string[] = [''];
  if (request.destructiveChanges.length > 0) {
    lines.push('Destructive changes:');
    for (const change of request.destructiveChanges) {
      lines.push(`  ${formatDestructiveChange(change)}`);
    }
    lines.push('');
  }
  const { create, update, delete: del } = request.counts;
  lines.push(
    `Stack ${displayIdent(request.stackName)}: ${create} to create, ${update} to update, ${del} to delete.`
  );
  lines.push(
    request.level === 'destructive'
      ? `Stack includes destructive updates and "--require-approval" is set to 'destructive'.`
      : `Stack includes updates and "--require-approval" is set to 'any-change'.`
  );
  return `${lines.join('\n')}\n`;
}
