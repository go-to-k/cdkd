import type { Option } from 'commander';
import { destroyOptions } from '../../../src/cli/options.js';
import { createStateCommand } from '../../../src/cli/commands/state.js';

function removeProtection(options: readonly Option[], where: string): string {
  const option = options.find((o) => o.long === '--remove-protection');
  if (!option) throw new Error(`${where} no longer declares --remove-protection`);
  return option.description;
}

/** The `--remove-protection` description `cdkd destroy` prints. */
export function destroyRemoveProtectionHelp(): string {
  return removeProtection(destroyOptions, 'destroyOptions');
}

/** The `--remove-protection` description `cdkd state destroy` prints. */
export function stateDestroyRemoveProtectionHelp(): string {
  const destroy = createStateCommand().commands.find((c) => c.name() === 'destroy');
  if (!destroy) throw new Error('cdkd state has no destroy subcommand');
  return removeProtection(destroy.options, 'cdkd state destroy');
}
