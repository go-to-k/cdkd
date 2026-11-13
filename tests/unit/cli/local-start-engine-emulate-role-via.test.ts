import { describe, expect, it } from 'vite-plus/test';
import type { Command } from 'commander';
import { createLocalStartAgentCoreCommand } from '../../../src/cli/commands/local-start-agentcore.js';
import { createLocalStartAlbCommand } from '../../../src/cli/commands/local-start-alb.js';
import { createLocalStartCloudFrontCommand } from '../../../src/cli/commands/local-start-cloudfront.js';
import { createLocalStartMicrovmCommand } from '../../../src/cli/commands/local-start-microvm.js';
import { createLocalStartServiceCommand } from '../../../src/cli/commands/local-start-service.js';
import { createLocalStartWebFunctionCommand } from '../../../src/cli/commands/local-start-web-function.js';

/**
 * The six engine `local start-*` commands take `--emulate-role-via <arn>` from
 * cdk-local (0.166.0), which owns their assume path; cdkd registers nothing
 * for them. This pins that the flag stays registered exactly once on each and
 * parses to a value.
 */
const ARN = 'arn:aws:iam::123456789012:role/Via';

const COMMANDS: Array<[string, () => Command]> = [
  ['start-service', createLocalStartServiceCommand],
  ['start-alb', createLocalStartAlbCommand],
  ['start-cloudfront', createLocalStartCloudFrontCommand],
  ['start-agentcore', createLocalStartAgentCoreCommand],
  ['start-web-function', createLocalStartWebFunctionCommand],
  ['start-microvm', createLocalStartMicrovmCommand],
];

describe('--emulate-role-via on the engine local start-* commands', () => {
  it.each(COMMANDS)('%s registers the flag once and parses its value', (_name, create) => {
    const cmd = create();
    expect(cmd.options.filter((o) => o.long === '--emulate-role-via')).toHaveLength(1);
    cmd.parseOptions(['--emulate-role-via', ARN]);
    expect(cmd.opts().emulateRoleVia).toBe(ARN);
  });
});
