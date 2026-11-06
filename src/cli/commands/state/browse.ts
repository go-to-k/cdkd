import { Command } from 'commander';
import { commonOptions, deprecatedRegionOption, stateOptions } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { formatError, withErrorHandling } from '../../../utils/error-handler.js';
import { isInteractiveTerminal, type SelectStreams } from '../../interactive-select.js';
import { type BrowseDeps, nonInteractiveBrowseRefusal, runStateBrowse } from '../state-browse.js';
import { formatStackRefSafe, legacyRecordRefusal } from './refs.js';
import { type StateSetup, setupStateBackend, sortRefs } from './setup.js';
import { printStackResources } from './resources.js';
import { printStackShow } from './show.js';

/**
 * `cdkd state browse` (go-to-k/cdkd#5199): the interactive picker over the
 * views `state resources` / `state show` print. Refused without a terminal
 * BEFORE any AWS call, naming the commands that work there.
 */
async function stateBrowseCommand(options: {
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');
  const streams = { input: process.stdin, output: process.stdout };
  if (!isInteractiveTerminal(streams)) throw nonInteractiveBrowseRefusal();

  const setup = await setupStateBackend(options);
  try {
    await runStateBrowse(stateBrowseDeps(setup, options, streams));
  } finally {
    setup.dispose();
  }
}

/**
 * What `cdkd state browse` runs against `setup`: the listing `cdkd state
 * list` sorts, and each view printed by its command's own printer. Exported
 * for its unit tests.
 */
export function stateBrowseDeps(
  setup: StateSetup,
  options: {
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    profile?: string;
    roleArn?: string;
    verbose: boolean;
  },
  streams: SelectStreams
): BrowseDeps {
  return {
    streams,
    listStacks: async () => sortRefs(await setup.stateBackend.listStacks()),
    label: formatStackRefSafe,
    printView: async (view, ref) => {
      if (!ref.region) throw legacyRecordRefusal(ref.stackName);
      const base = { ...options, stackRegion: ref.region, json: false };
      if (view === 'show') {
        await printStackShow(ref.stackName, { ...base, showNested: false }, setup);
      } else {
        await printStackResources(
          ref.stackName,
          { ...base, long: view === 'resources-long' },
          setup
        );
      }
    },
    reportError: (error) => getLogger().error(formatError(error)),
  };
}

export function createStateBrowseCommand(): Command {
  const cmd = new Command('browse')
    .description(
      'Pick a stack with the keyboard and view its resources or state record (needs a terminal)'
    )
    .action(withErrorHandling(stateBrowseCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
