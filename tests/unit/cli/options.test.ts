import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

import {
  commonOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../../../src/cli/options.js';
import { createBootstrapCommand } from '../../../src/cli/commands/bootstrap.js';
import { createDeployCommand } from '../../../src/cli/commands/deploy.js';
import { createDestroyCommand } from '../../../src/cli/commands/destroy.js';
import { createDiffCommand } from '../../../src/cli/commands/diff.js';
import { createSynthCommand } from '../../../src/cli/commands/synth.js';
import { createListCommand } from '../../../src/cli/commands/list.js';
import { createForceUnlockCommand } from '../../../src/cli/commands/force-unlock.js';
import { createPublishAssetsCommand } from '../../../src/cli/commands/publish-assets.js';
import { createStateCommand } from '../../../src/cli/commands/state.js';

/**
 * Collect every option flag string registered on a command (incl. hidden
 * ones). We use the public `options` array exposed by commander.
 */
function optionFlags(cmd: Command): string[] {
  return cmd.options.map((o) => o.flags);
}

/**
 * True when the command exposes `--region <region>` regardless of where it
 * came from (commonOptions, bootstrap-direct, or deprecated wrapper).
 */
function hasRegionOption(cmd: Command): boolean {
  return optionFlags(cmd).some((f) => /^--region\b/.test(f));
}

describe('cli/options.ts', () => {
  describe('commonOptions', () => {
    it('does not include --region (PR 5: consolidated to bootstrap-only)', () => {
      const flags = commonOptions.map((o) => o.flags);
      expect(flags.some((f) => /^--region\b/.test(f))).toBe(false);
    });

    it('still includes --verbose, --profile, and -y/--yes', () => {
      const flags = commonOptions.map((o) => o.flags);
      expect(flags).toEqual(
        expect.arrayContaining(['--verbose', '--profile <profile>', '-y, --yes'])
      );
    });
  });

  describe('deprecatedRegionOption', () => {
    it('exposes the --region <region> flag and is hidden from --help', () => {
      expect(deprecatedRegionOption.flags).toBe('--region <region>');
      // Commander records hideHelp() by setting `hidden = true` on the option.
      // The exact field is internal but observable.
      expect((deprecatedRegionOption as unknown as { hidden?: boolean }).hidden).toBe(true);
    });
  });

  describe('warnIfDeprecatedRegion', () => {
    // Direct replacement of process.stderr.write — under vitest's output
    // capture, vi.spyOn does not always intercept the stream cleanly.
    let stderrChunks: string[];
    let originalStderrWrite: typeof process.stderr.write;

    beforeEach(() => {
      stderrChunks = [];
      originalStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as typeof process.stderr.write;
    });

    afterEach(() => {
      process.stderr.write = originalStderrWrite;
    });

    it('writes a deprecation warning to stderr when region is set', () => {
      warnIfDeprecatedRegion({ region: 'us-east-1' });
      const all = stderrChunks.join('');
      expect(all).toMatch(/--region is deprecated for this command and has no effect/);
      expect(all).toMatch(/AWS_REGION/);
    });

    it('is silent when region is undefined', () => {
      warnIfDeprecatedRegion({});
      expect(stderrChunks).toEqual([]);
    });

    it('treats empty-string region as set (commander only assigns when the flag is passed)', () => {
      warnIfDeprecatedRegion({ region: '' });
      const all = stderrChunks.join('');
      // Empty string is still a user-supplied value; warn (do not silently ignore).
      expect(all).toMatch(/--region is deprecated/);
    });
  });

  describe('command --region wiring', () => {
    it('bootstrap exposes a non-deprecated --region (bucket creation needs it)', () => {
      const cmd = createBootstrapCommand();
      expect(hasRegionOption(cmd)).toBe(true);
      // bootstrap's --region is NOT the deprecated wrapper — it must be visible
      // in --help.
      const regionOpt = cmd.options.find((o) => /^--region\b/.test(o.flags));
      expect((regionOpt as unknown as { hidden?: boolean }).hidden).toBeFalsy();
    });

    it.each([
      ['deploy', () => createDeployCommand()],
      ['destroy', () => createDestroyCommand()],
      ['diff', () => createDiffCommand()],
      ['synth', () => createSynthCommand()],
      ['list', () => createListCommand()],
      ['force-unlock', () => createForceUnlockCommand()],
      ['publish-assets', () => createPublishAssetsCommand()],
    ])('%s accepts --region but hides it from --help', (_name, build) => {
      const cmd = build();
      expect(hasRegionOption(cmd)).toBe(true);
      const regionOpt = cmd.options.find((o) => /^--region\b/.test(o.flags));
      // Deprecated wrapper is hidden from generated --help text.
      expect((regionOpt as unknown as { hidden?: boolean }).hidden).toBe(true);
    });

    it.each(['list', 'resources', 'show', 'orphan'])(
      'state %s accepts --region but hides it from --help',
      (subcommandName) => {
        const stateCmd = createStateCommand();
        const sub = stateCmd.commands.find((c) => c.name() === subcommandName);
        expect(sub).toBeDefined();
        if (!sub) return;
        expect(hasRegionOption(sub)).toBe(true);
        const regionOpt = sub.options.find((o) => /^--region\b/.test(o.flags));
        expect((regionOpt as unknown as { hidden?: boolean }).hidden).toBe(true);
      }
    );
  });

  describe('parseContextOptions', () => {
    it('parses key=value pairs into a record', () => {
      expect(parseContextOptions(['env=dev', 'flag=true'])).toEqual({
        env: 'dev',
        flag: 'true',
      });
    });

    it('returns an empty record when no args are given', () => {
      expect(parseContextOptions(undefined)).toEqual({});
      expect(parseContextOptions([])).toEqual({});
    });

    it('keeps the first equals sign as the separator (values can contain =)', () => {
      expect(parseContextOptions(['url=https://example.com/?k=v'])).toEqual({
        url: 'https://example.com/?k=v',
      });
    });

    it('skips entries without an equals sign', () => {
      expect(parseContextOptions(['lonely', 'env=dev'])).toEqual({ env: 'dev' });
    });
  });
});
