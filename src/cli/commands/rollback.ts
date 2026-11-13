import { Command, Option } from 'commander';
import {
  commonOptions,
  stateOptions,
  deprecatedRegionOption,
  skipFinalSnapshotOption,
  noLocalCustomResourcesOption,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { removeProtectionTypeList } from '../../provisioning/remove-protection-types.js';
import { stackRegionOption } from './rollback/options.js';
import { rollbackCommand } from './rollback/command.js';

export { rerunRollback, backendErrorText, confirm } from './rollback/render.js';
export { rollbackCommand } from './rollback/command.js';

export function createRollbackCommand(): Command {
  const cmd = new Command('rollback')
    .description(
      'Revert a stack to its pre-deploy state after a failed --no-rollback / interrupted deploy ' +
        'or a partially-failed automatic rollback (state-driven, no synth needed).'
    )
    .argument('[stack]', 'Stack name to roll back (defaults to the single journaled stack)')
    .addOption(new Option('--force', 'Skip the confirmation prompt').default(false))
    .addOption(
      new Option(
        '--orphan <logicalId>',
        'Skip the given resource during replay (repeatable). Mirrors cdk rollback --orphan.'
      ).argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
    )
    .addOption(
      new Option(
        '--revert-failed',
        'Also attempt to revert the resource whose operation FAILED mid-deploy. Off by ' +
          'default: the remote state of the failed resource is unknown, so force-applying ' +
          'its previous state is opt-in.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--drop-failed <logicalId>',
        'Remove ONE journaled failed CREATE (a resource cdkd proved it made, journaled as its only ' +
          'record) from the rollback journal, after checking that resource by hand. Replays nothing ' +
          'and deletes nothing in AWS; every other entry is kept.'
      )
    )
    .addOption(skipFinalSnapshotOption)
    .addOption(noLocalCustomResourcesOption)
    .addOption(
      new Option(
        '--remove-protection',
        "Turn deletion protection off before this stack's rollback deletes a resource the " +
          'failed deploy left: one its state records from a completed CREATE, or one a failed ' +
          'CREATE left behind (a journaled orphan, or under --revert-failed the failed CREATE ' +
          'itself) when cdkd can prove it is that resource and no other stack holds it. A nested ' +
          "stack it deletes cascades the flag to that child's resources, and a nested stack it " +
          "reverts carries it into that child's revert. Covers " +
          `${removeProtectionTypeList()}.`
      ).default(false)
    )
    .addOption(stackRegionOption())
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  cdkd rollback MyStack',
        '  cdkd rollback                       # single journaled stack',
        '  cdkd rollback MyStack --force',
        '  cdkd rollback MyStack --orphan MyBucket --orphan MyTable',
        '  cdkd rollback MyStack --revert-failed   # also revert the failed in-flight resource',
        '  cdkd rollback MyStack --skip-final-snapshot  # DeletionPolicy Snapshot → delete without the snapshot',
        '  cdkd rollback MyStack --remove-protection   # also delete protected resources the failed deploy left',
        '  cdkd rollback MyStack --stack-region us-west-2',
        '  cdkd rollback MyStack --drop-failed MyQueuePolicy  # forget one undeletable failed CREATE',
        '',
        'Exit codes: 0 = clean, 2 = partial (journal kept for re-run), 1 = hard error.',
      ].join('\n')
    )
    .action(withErrorHandling(rollbackCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
