import { describe, expect, it } from 'vite-plus/test';
import { Command, CommanderError, type Option } from 'commander';

// go-to-k/cdkd#6251: an option parser that threw a plain Error escaped
// commander's parse, so a typo printed `Fatal error:` and a stack trace.
// Every custom `argParser` must reject a bad value as commander's
// `InvalidArgumentError`, which renders as a one-line usage error.

import { createGcCommand } from '../../../src/cli/commands/gc.js';
import { createEventsPruneCommand } from '../../../src/cli/commands/events.js';
import { createPublishAssetsCommand } from '../../../src/cli/commands/publish-assets.js';
import { createLocalInvokeAgentCoreCommand } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import { deployOptions } from '../../../src/cli/options.js';
import { resourceTimeoutOptions } from '../../../src/cli/options/resource-timeout.js';
import {
  allowUnsupportedPropertiesOption,
  allowUnsupportedTypesOption,
  pinCcApiOption,
  preferSdkRouteOption,
  recreateViaCcApiOption,
  recreateViaSdkProviderOption,
} from '../../../src/cli/options/provisioning-route.js';
import {
  cliArgParser,
  parsePositiveIntegerOption,
} from '../../../src/cli/arg-parser.js';

function quiet(cmd: Command): Command {
  return cmd.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
}

function withOptions(options: readonly Option[]): Command {
  const cmd = quiet(new Command('x'));
  for (const o of options) cmd.addOption(o);
  return cmd.action(() => {});
}

/** The error a parse throws, or `undefined`. */
function parseError(cmd: Command, args: string[]): unknown {
  try {
    cmd.parse(args, { from: 'user' });
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectUsageError(cmd: Command, args: string[], message: RegExp): void {
  const error = parseError(cmd, args);
  expect(error).toBeInstanceOf(CommanderError);
  expect((error as CommanderError).code).toBe('commander.invalidArgument');
  expect((error as CommanderError).exitCode).toBe(1);
  expect((error as Error).message).toMatch(message);
}

describe('option parsers reject a bad value as a usage error (#6251)', () => {
  it('gc --older-than', () => {
    expectUsageError(
      quiet(createGcCommand()),
      ['--older-than', '0s'],
      /option '--older-than <duration>' argument '0s' is invalid\. Invalid --older-than "0s"/
    );
    expectUsageError(quiet(createGcCommand()), ['--older-than', '0d'], /greater than zero/);
  });

  it('--resource-timeout / --resource-warn-after (bare and TYPE=duration)', () => {
    expectUsageError(
      withOptions(resourceTimeoutOptions),
      ['--resource-timeout', 'bogus'],
      /'--resource-timeout <duration_or_type=duration>' argument 'bogus' is invalid\. Invalid duration "bogus"/
    );
    expectUsageError(
      withOptions(resourceTimeoutOptions),
      ['--resource-warn-after', 'bogus'],
      /argument 'bogus' is invalid/
    );
    expectUsageError(
      withOptions(resourceTimeoutOptions),
      ['--resource-timeout', 'AWS::S3::Bucket=bogus'],
      /Invalid --resource-timeout value "AWS::S3::Bucket=bogus"/
    );
  });

  it('the deploy concurrency options', () => {
    for (const flag of [
      '--concurrency',
      '--stack-concurrency',
      '--asset-publish-concurrency',
      '--image-build-concurrency',
    ]) {
      for (const bad of ['bogus', '0', '-1', '2.5']) {
        expectUsageError(withOptions(deployOptions), [flag, bad], /Expected a positive integer/);
      }
    }
    expectUsageError(
      quiet(createPublishAssetsCommand()),
      ['--asset-publish-concurrency', 'bogus'],
      /Expected a positive integer/
    );
  });

  it('the provisioning-route options', () => {
    const cmd = (): Command =>
      withOptions([
        allowUnsupportedTypesOption,
        preferSdkRouteOption,
        allowUnsupportedPropertiesOption,
        recreateViaCcApiOption,
        pinCcApiOption,
        recreateViaSdkProviderOption,
      ]);
    expectUsageError(cmd(), ['--allow-unsupported-types', 'bogus'], /Invalid --allow-unsupported-types/);
    expectUsageError(cmd(), ['--prefer-sdk-route', 'bogus'], /Invalid --prefer-sdk-route/);
    expectUsageError(cmd(), ['--recreate-via-cc-api', '1bad'], /Invalid --recreate-via-cc-api/);
    expectUsageError(cmd(), ['--pin-cc-api', '1bad'], /argument '1bad' is invalid/);
    expectUsageError(cmd(), ['--recreate-via-sdk-provider', '1bad'], /argument '1bad' is invalid/);
  });

  it('events prune --keep, local invoke-agentcore --timeout, local start-api --assume-role', () => {
    expectUsageError(quiet(createEventsPruneCommand()), ['S', '--keep', 'bogus'], /Invalid --keep/);
    expectUsageError(
      quiet(createLocalInvokeAgentCoreCommand()),
      ['T', '--timeout', 'bogus'],
      /--timeout must be a positive integer/
    );
    expectUsageError(
      quiet(createLocalStartApiCommand()),
      ['--assume-role', 'bogus'],
      /Invalid --assume-role value "bogus"/
    );
  });

  it('valid values still parse', () => {
    const cmd = withOptions(deployOptions);
    cmd.parse(['--resource-timeout', '5m', '--concurrency', '7'], { from: 'user' });
    expect(cmd.opts()['resourceTimeout']).toEqual({ perTypeMs: {}, globalMs: 300000 });
    expect(cmd.opts()['concurrency']).toBe(7);
  });
});

describe('cliArgParser', () => {
  it('passes the value and the previous one through', () => {
    const parse = cliArgParser((v: string, prev: string[] | undefined) => [...(prev ?? []), v]);
    expect(parse('b', ['a'])).toEqual(['a', 'b']);
  });

  it('keeps a CommanderError as is', () => {
    expect(() => cliArgParser(parsePositiveIntegerOption)('x', undefined)).toThrow(
      /Expected a positive integer/
    );
  });
});
