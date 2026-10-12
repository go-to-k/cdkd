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
  DeploymentApprover,
  RequireApprovalLevel,
} from '../../deployment/deploy-engine/options.js';
import { displayIdent } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import { loadCdkJson } from '../config-loader.js';
import { confirmOrRefuse, serializePrompt } from './confirm-prompt.js';

export const REQUIRE_APPROVAL_VALUES = [
  'never',
  'any-change',
  'broadening',
  'destructive',
] as const;

export const requireApprovalOption = new Option(
  '--require-approval <level>',
  'What changes require manual approval before they are deployed: "never" (default), "any-change", "broadening" (a change that broadens IAM permissions or security-group rules), or "destructive" (a change that replaces, deletes or orphans an existing resource). Both "broadening" and "destructive" check nested stacks too. Without a terminal the deploy fails instead of asking, unless --yes is given. Also read from "requireApproval" in cdk.json.'
).choices(REQUIRE_APPROVAL_VALUES);

/**
 * The level for this run: the flag, else cdk.json's top-level `requireApproval`
 * (where the AWS CDK CLI reads it), else `never`. The AWS CDK CLI defaults to
 * `broadening`; cdkd keeps `never`, as it has never asked without being told
 * to. cdk.json's `broadening` is honoured (go-to-k/cdkd#4601).
 */
export function resolveRequireApproval(
  cliValue: RequireApprovalLevel | undefined,
  cdkJson: { requireApproval?: unknown } | null = loadCdkJson()
): RequireApprovalLevel {
  if (cliValue !== undefined) return cliValue;
  const configured = cdkJson?.requireApproval;
  if (configured === undefined) return 'never';
  if ((REQUIRE_APPROVAL_VALUES as readonly unknown[]).includes(configured)) {
    return configured as RequireApprovalLevel;
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
export function createApprovalPrompter(options: { yes: boolean }): DeploymentApprover {
  if (options.yes) {
    // go-to-k/cdkd#4705 review H-3: says so, so the engine knows no one waited.
    return Object.assign(() => Promise.resolve(true), { autoApproves: true as const });
  }
  return (request) => {
    return serializePrompt(() =>
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
  };
}

/** The block printed above the question. Exported for tests. */
export function renderApprovalRequest(request: DeploymentApprovalRequest): string {
  const lines: string[] = [''];
  if (request.securityChanges !== undefined && request.securityChanges !== '') {
    lines.push(request.securityChanges.replace(/\n+$/, ''));
    lines.push('');
  }
  if (request.destructiveChanges.length > 0 && request.level !== 'broadening') {
    lines.push('Destructive changes:');
    for (const change of request.destructiveChanges) {
      lines.push(`  ${formatDestructiveChange(change)}`);
    }
    lines.push('');
  }
  const { create, update, delete: del } = request.counts;
  lines.push(
    request.outputsOnly
      ? `Stack ${displayIdent(request.stackName)}: no resource changes; its Outputs change.`
      : `Stack ${displayIdent(request.stackName)}: ${create} to create, ${update} to update, ${del} to delete.`
  );
  lines.push(
    request.level === 'destructive'
      ? `Stack includes destructive updates and "--require-approval" is set to 'destructive'.`
      : request.level === 'broadening'
        ? `Stack includes security-sensitive updates and "--require-approval" is set to 'broadening'.`
        : `Stack includes updates and "--require-approval" is set to 'any-change'.`
  );
  return `${lines.join('\n')}\n`;
}
