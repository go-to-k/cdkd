import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { Command, InvalidArgumentError, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  commonOptions,
  deprecatedRegionOption,
  effectiveResourceTimeoutMs,
  parseContextOptions,
  parseDuration,
  parseStackRegion,
  resourceTimeoutOptions,
  validateResourceTimeouts,
  warnIfDeprecatedRegion,
  type ResourceTimeoutOption,
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
import { buildProgram } from '../../../src/cli/program.js';
import { getLogger } from '../../../src/utils/logger.js';

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

    it('help text does NOT claim the flag has no effect (issue #818)', () => {
      // The flag IS still honored on every non-bootstrap command (it feeds the
      // SDK client region / AWS_REGION injection); the description must not
      // falsely advertise it as a no-op.
      expect(deprecatedRegionOption.description).not.toMatch(/no effect/i);
      expect(deprecatedRegionOption.description).toMatch(/still honored/i);
      expect(deprecatedRegionOption.description).toMatch(/AWS_REGION/);
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
      expect(all).toMatch(/--region is deprecated and will be removed in a future release/);
      expect(all).toMatch(/AWS_REGION/);
    });

    it('does NOT claim the flag has no effect (issue #818)', () => {
      // The warning must steer users toward AWS_REGION / profile WITHOUT
      // falsely telling them the flag they just passed did nothing: deploy /
      // destroy / diff / list / etc. all consume options.region as the
      // highest-precedence region source, so "has no effect" was a lie.
      warnIfDeprecatedRegion({ region: 'eu-west-1' });
      const all = stderrChunks.join('');
      expect(all).not.toMatch(/no effect/i);
      expect(all).toMatch(/still honored/i);
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

  describe('annotation-message flag wiring (issue #1230)', () => {
    // Guards the shared annotationMessageOptions spread in each command's
    // option array — a merge-conflict resolution dropping the spread would
    // otherwise surface only as a runtime `unknown option '--strict'`.
    it.each([
      ['synth', () => createSynthCommand()],
      ['deploy', () => createDeployCommand()],
    ])('%s registers --strict and --ignore-errors', (_name, build) => {
      const cmd = build();
      expect(cmd.options.some((o) => /^--strict$/.test(o.flags))).toBe(true);
      expect(cmd.options.some((o) => /^--ignore-errors$/.test(o.flags))).toBe(true);
    });
  });

  describe('parseDuration', () => {
    it.each([
      ['5s', 5_000],
      ['30s', 30_000],
      ['90s', 90_000],
      ['1m', 60_000],
      ['5m', 300_000],
      ['30m', 1_800_000],
      ['1h', 3_600_000],
      ['2h', 7_200_000],
      ['1.5h', 5_400_000],
    ])('parses %s into %d ms', (input, expected) => {
      expect(parseDuration(input)).toBe(expected);
    });

    it.each([
      ['', 'empty string'],
      ['30', 'no unit'],
      ['30x', 'unknown unit'],
      ['m', 'no number'],
      ['abc', 'malformed'],
      ['  ', 'whitespace only'],
    ])('rejects %j (%s)', (input) => {
      expect(() => parseDuration(input)).toThrow();
    });

    it('rejects zero values', () => {
      expect(() => parseDuration('0s')).toThrow(/greater than zero/);
      expect(() => parseDuration('0m')).toThrow(/greater than zero/);
      expect(() => parseDuration('0h')).toThrow(/greater than zero/);
    });

    it('rejects negative values', () => {
      // The regex forbids the leading '-' so the rejection comes from
      // the format check, not the numeric check — both are valid behaviors.
      expect(() => parseDuration('-5m')).toThrow();
      expect(() => parseDuration('-1s')).toThrow();
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(parseDuration('  5m  ')).toBe(300_000);
    });

    it('rejects non-string inputs gracefully', () => {
      // commander.argParser always passes strings, but defend against
      // direct callers passing something odd.
      expect(() => parseDuration(undefined as unknown as string)).toThrow();
      expect(() => parseDuration(null as unknown as string)).toThrow();
    });
  });

  describe('validateResourceTimeouts', () => {
    const opt = (
      globalMs?: number,
      perTypeMs: Record<string, number> = {}
    ): ResourceTimeoutOption => ({
      ...(globalMs !== undefined && { globalMs }),
      perTypeMs,
    });

    it('accepts warn < timeout (globals only)', () => {
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(5 * 60_000),
          resourceTimeout: opt(30 * 60_000),
        })
      ).not.toThrow();
    });

    it('rejects global warn == timeout', () => {
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(30 * 60_000),
          resourceTimeout: opt(30 * 60_000),
        })
      ).toThrow(/--resource-warn-after .* must be less than --resource-timeout/);
    });

    it('rejects global warn > timeout', () => {
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(60 * 60_000),
          resourceTimeout: opt(30 * 60_000),
        })
      ).toThrow(/--resource-warn-after .* must be less than --resource-timeout/);
    });

    it('is a no-op when either side is undefined (commander default not yet applied)', () => {
      expect(() => validateResourceTimeouts({})).not.toThrow();
      expect(() =>
        validateResourceTimeouts({ resourceWarnAfter: opt(5 * 60_000) })
      ).not.toThrow();
      expect(() =>
        validateResourceTimeouts({ resourceTimeout: opt(30 * 60_000) })
      ).not.toThrow();
    });

    it('rejects per-type warn >= per-type timeout', () => {
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(undefined, { 'AWS::S3::Bucket': 10 * 60_000 }),
          resourceTimeout: opt(undefined, { 'AWS::S3::Bucket': 5 * 60_000 }),
        })
      ).toThrow(/AWS::S3::Bucket/);
    });

    it('rejects per-type warn >= global timeout when per-type timeout is missing', () => {
      // --resource-warn-after AWS::X=20m without --resource-timeout AWS::X=...
      // means the per-type warn is compared against the global timeout.
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(undefined, { 'AWS::S3::Bucket': 20 * 60_000 }),
          resourceTimeout: opt(10 * 60_000),
        })
      ).toThrow(/AWS::S3::Bucket/);
    });

    it('accepts per-type warn < global timeout when per-type timeout is missing', () => {
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(undefined, { 'AWS::S3::Bucket': 5 * 60_000 }),
          resourceTimeout: opt(30 * 60_000),
        })
      ).not.toThrow();
    });

    it('accepts per-type override raising both sides above the global', () => {
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(5 * 60_000, { 'AWS::CloudFront::Distribution': 10 * 60_000 }),
          resourceTimeout: opt(30 * 60_000, { 'AWS::CloudFront::Distribution': 60 * 60_000 }),
        })
      ).not.toThrow();
    });

    it('skips comparison when neither global nor per-type sides are resolvable', () => {
      // Per-type warn for AWS::X but no global warn and no per-type timeout
      // for AWS::X means we fall back to the v1 compile-time defaults
      // (warn 5m, timeout 30m), which are ordered correctly.
      expect(() =>
        validateResourceTimeouts({
          resourceWarnAfter: opt(undefined, { 'AWS::S3::Bucket': 5 * 60_000 }),
          resourceTimeout: opt(undefined, {}),
        })
      ).not.toThrow();
    });

    describe('auto-lowering inherited warn-after when timeout is shortened', () => {
      let logger: ReturnType<typeof getLogger>;
      let warnSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        logger = getLogger();
        warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {
          /* swallow log output during the test */
        });
      });

      afterEach(() => {
        warnSpy.mockRestore();
      });

      it('auto-lowers global warn when --resource-timeout < 5m default and warn is not set', () => {
        // The exact scenario from the negative-test in
        // tests/integration/remove-protection/verify.sh: --resource-timeout 2m
        // with no --resource-warn-after. Pre-fix this exploded at runtime
        // every time a resource provisioning call started.
        const opts: {
          resourceWarnAfter?: ResourceTimeoutOption;
          resourceTimeout?: ResourceTimeoutOption;
        } = {
          resourceTimeout: opt(2 * 60_000),
        };
        expect(() => validateResourceTimeouts(opts)).not.toThrow();
        expect(opts.resourceWarnAfter?.globalMs).toBeDefined();
        expect(opts.resourceWarnAfter!.globalMs).toBeLessThan(2 * 60_000);
        expect(opts.resourceWarnAfter!.globalMs).toBeLessThanOrEqual(60_000); // 0.5 * 2m
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0]![0]);
        expect(message).toMatch(/--resource-warn-after defaulted to/);
        expect(message).toMatch(/--resource-timeout/);
      });

      it('does not auto-lower or warn when --resource-timeout matches the 30m default', () => {
        const opts: {
          resourceWarnAfter?: ResourceTimeoutOption;
          resourceTimeout?: ResourceTimeoutOption;
        } = {
          resourceTimeout: opt(30 * 60_000),
        };
        expect(() => validateResourceTimeouts(opts)).not.toThrow();
        expect(opts.resourceWarnAfter).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('does not auto-lower or warn when --resource-timeout is set above 5m default', () => {
        const opts: {
          resourceWarnAfter?: ResourceTimeoutOption;
          resourceTimeout?: ResourceTimeoutOption;
        } = {
          resourceTimeout: opt(10 * 60_000),
        };
        expect(() => validateResourceTimeouts(opts)).not.toThrow();
        expect(opts.resourceWarnAfter).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('auto-lowers per-type warn when --resource-timeout TYPE=<2m> and warn for that type is inherited', () => {
        const opts: {
          resourceWarnAfter?: ResourceTimeoutOption;
          resourceTimeout?: ResourceTimeoutOption;
        } = {
          resourceTimeout: opt(undefined, { 'AWS::EC2::Instance': 2 * 60_000 }),
        };
        expect(() => validateResourceTimeouts(opts)).not.toThrow();
        expect(opts.resourceWarnAfter?.perTypeMs?.['AWS::EC2::Instance']).toBeDefined();
        expect(opts.resourceWarnAfter!.perTypeMs!['AWS::EC2::Instance']).toBeLessThan(
          2 * 60_000
        );
        expect(opts.resourceWarnAfter!.perTypeMs!['AWS::EC2::Instance']).toBeLessThanOrEqual(
          60_000
        );
        // Other types stay at the inherited 5m default — no entry written.
        expect(opts.resourceWarnAfter?.perTypeMs?.['AWS::S3::Bucket']).toBeUndefined();
        expect(opts.resourceWarnAfter?.globalMs).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0]![0]);
        expect(message).toMatch(/AWS::EC2::Instance/);
        expect(message).toMatch(/defaulted/);
      });

      it('hard-rejects when both --resource-timeout and --resource-warn-after are explicitly reversed (global)', () => {
        // Explicit user values must NEVER be silently rewritten — the
        // auto-lower path is for the inherited-default case only.
        expect(() =>
          validateResourceTimeouts({
            resourceWarnAfter: opt(3 * 60_000),
            resourceTimeout: opt(2 * 60_000),
          })
        ).toThrow(/--resource-warn-after .* must be less than --resource-timeout/);
      });

      it('hard-rejects when both per-type values are explicitly reversed', () => {
        expect(() =>
          validateResourceTimeouts({
            resourceWarnAfter: opt(undefined, { 'AWS::EC2::Instance': 3 * 60_000 }),
            resourceTimeout: opt(undefined, { 'AWS::EC2::Instance': 2 * 60_000 }),
          })
        ).toThrow(/AWS::EC2::Instance/);
      });

      it('hard-rejects when --resource-warn-after is set above the 30m default timeout with no --resource-timeout', () => {
        // Auto-raising the timeout would silently grant the user more
        // budget than they asked for; reject instead.
        expect(() =>
          validateResourceTimeouts({
            resourceWarnAfter: opt(45 * 60_000),
          })
        ).toThrow(/must be less than --resource-timeout/);
      });
    });
  });

  describe('parseResourceTimeoutToken (via Commander)', () => {
    /**
     * Run `--resource-timeout` arguments through a minimal Commander
     * pipeline so the test exercises the same parser the real CLI does.
     */
    function runTimeoutFlag(args: string[]): ResourceTimeoutOption | undefined {
      const cmd = new Command();
      cmd.exitOverride();
      const opt = resourceTimeoutOptions.find((o) => o.flags.startsWith('--resource-timeout'));
      if (!opt) throw new Error('--resource-timeout option not found');
      cmd.addOption(opt);
      cmd.action(() => {
        // no-op; we read opts off the parsed command below
      });
      cmd.parse(['node', 'cdkd', ...args], { from: 'user' });
      return cmd.opts<{ resourceTimeout?: ResourceTimeoutOption }>().resourceTimeout;
    }

    it('parses a bare duration into globalMs', () => {
      const got = runTimeoutFlag(['--resource-timeout', '30m']);
      expect(got).toEqual({ globalMs: 30 * 60_000, perTypeMs: {} });
    });

    it('parses TYPE=DURATION into perTypeMs', () => {
      const got = runTimeoutFlag([
        '--resource-timeout',
        'AWS::CloudFront::Distribution=1h',
      ]);
      expect(got).toEqual({
        perTypeMs: { 'AWS::CloudFront::Distribution': 60 * 60_000 },
      });
    });

    it('accepts a mix of bare and TYPE=DURATION across repeated flags (last bare wins)', () => {
      const got = runTimeoutFlag([
        '--resource-timeout',
        '30m',
        '--resource-timeout',
        'AWS::CloudFront::Distribution=1h',
        '--resource-timeout',
        'AWS::RDS::DBCluster=1.5h',
      ]);
      expect(got).toEqual({
        globalMs: 30 * 60_000,
        perTypeMs: {
          'AWS::CloudFront::Distribution': 60 * 60_000,
          'AWS::RDS::DBCluster': 90 * 60_000,
        },
      });
    });

    it('rejects malformed TYPE (missing scope)', () => {
      expect(() => runTimeoutFlag(['--resource-timeout', 's3:bucket=30m'])).toThrow(
        /CloudFormation resource type/
      );
    });

    it('rejects malformed TYPE (lower-case service)', () => {
      expect(() =>
        runTimeoutFlag(['--resource-timeout', 'aws::s3::Bucket=30m'])
      ).toThrow(/CloudFormation resource type/);
    });

    it('rejects malformed duration after TYPE=', () => {
      expect(() =>
        runTimeoutFlag(['--resource-timeout', 'AWS::S3::Bucket=potato'])
      ).toThrow(/Invalid/);
    });

    it('rejects empty duration after TYPE=', () => {
      expect(() => runTimeoutFlag(['--resource-timeout', 'AWS::S3::Bucket='])).toThrow(
        /missing duration/
      );
    });
  });

  describe('effectiveResourceTimeoutMs', () => {
    const fallback = 30 * 60_000;

    it('returns fallback when option is undefined', () => {
      expect(effectiveResourceTimeoutMs('AWS::S3::Bucket', undefined, fallback)).toBe(fallback);
    });

    it('returns globalMs when no per-type entry matches', () => {
      const opt: ResourceTimeoutOption = { globalMs: 10 * 60_000, perTypeMs: {} };
      expect(effectiveResourceTimeoutMs('AWS::S3::Bucket', opt, fallback)).toBe(10 * 60_000);
    });

    it('per-type entry supersedes globalMs', () => {
      const opt: ResourceTimeoutOption = {
        globalMs: 10 * 60_000,
        perTypeMs: { 'AWS::CloudFront::Distribution': 60 * 60_000 },
      };
      expect(
        effectiveResourceTimeoutMs('AWS::CloudFront::Distribution', opt, fallback)
      ).toBe(60 * 60_000);
      // Non-matching type still falls through to global.
      expect(effectiveResourceTimeoutMs('AWS::S3::Bucket', opt, fallback)).toBe(10 * 60_000);
    });

    it('falls back to fallback when neither global nor per-type is set', () => {
      const opt: ResourceTimeoutOption = { perTypeMs: {} };
      expect(effectiveResourceTimeoutMs('AWS::S3::Bucket', opt, fallback)).toBe(fallback);
    });
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

describe('parseAllowUnsupportedTypesToken', () => {
  it('parses a single AWS:: resource type', async () => {
    const { parseAllowUnsupportedTypesToken } = await import('../../../src/cli/options.js');
    expect(parseAllowUnsupportedTypesToken('AWS::AppMesh::Mesh', undefined)).toEqual([
      'AWS::AppMesh::Mesh',
    ]);
  });

  it('splits a comma-separated value', async () => {
    const { parseAllowUnsupportedTypesToken } = await import('../../../src/cli/options.js');
    expect(
      parseAllowUnsupportedTypesToken('AWS::AppMesh::Mesh,AWS::Budgets::Budget', undefined)
    ).toEqual(['AWS::AppMesh::Mesh', 'AWS::Budgets::Budget']);
  });

  it('accumulates across repeated invocations (commander --flag x --flag y)', async () => {
    const { parseAllowUnsupportedTypesToken } = await import('../../../src/cli/options.js');
    const first = parseAllowUnsupportedTypesToken('AWS::AppMesh::Mesh', undefined);
    const second = parseAllowUnsupportedTypesToken('AWS::Budgets::Budget', first);
    expect(second).toEqual(['AWS::AppMesh::Mesh', 'AWS::Budgets::Budget']);
  });

  it('accepts the Custom:: namespace', async () => {
    const { parseAllowUnsupportedTypesToken } = await import('../../../src/cli/options.js');
    expect(parseAllowUnsupportedTypesToken('Custom::Foo', undefined)).toEqual(['Custom::Foo']);
  });

  it('rejects a typo with no :: separator', async () => {
    const { parseAllowUnsupportedTypesToken } = await import('../../../src/cli/options.js');
    expect(() => parseAllowUnsupportedTypesToken('justaname', undefined)).toThrow(
      /Invalid --allow-unsupported-types value/
    );
  });

  it('rejects a hyphenated typo (not a valid CFn type segment)', async () => {
    const { parseAllowUnsupportedTypesToken } = await import('../../../src/cli/options.js');
    expect(() => parseAllowUnsupportedTypesToken('AppMesh::Mesh-typo', undefined)).toThrow(
      /Invalid --allow-unsupported-types value/
    );
  });

  it('trims whitespace around tokens', async () => {
    const { parseAllowUnsupportedTypesToken } = await import('../../../src/cli/options.js');
    expect(
      parseAllowUnsupportedTypesToken(' AWS::AppMesh::Mesh , AWS::Budgets::Budget ', undefined)
    ).toEqual(['AWS::AppMesh::Mesh', 'AWS::Budgets::Budget']);
  });
});

describe('parseAllowUnsupportedPropertiesToken', () => {
  it('parses a single <Type>:<Prop> token', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(
      parseAllowUnsupportedPropertiesToken('AWS::Lambda::Function:LoggingConfig', undefined)
    ).toEqual(['AWS::Lambda::Function:LoggingConfig']);
  });

  it('splits a comma-separated value', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(
      parseAllowUnsupportedPropertiesToken(
        'AWS::Lambda::Function:LoggingConfig,AWS::Lambda::Function:SnapStart',
        undefined
      )
    ).toEqual([
      'AWS::Lambda::Function:LoggingConfig',
      'AWS::Lambda::Function:SnapStart',
    ]);
  });

  it('accumulates across repeated invocations (commander --flag x --flag y)', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    const first = parseAllowUnsupportedPropertiesToken(
      'AWS::Lambda::Function:LoggingConfig',
      undefined
    );
    const second = parseAllowUnsupportedPropertiesToken(
      'AWS::RDS::DBInstance:CACertificateIdentifier',
      first
    );
    expect(second).toEqual([
      'AWS::Lambda::Function:LoggingConfig',
      'AWS::RDS::DBInstance:CACertificateIdentifier',
    ]);
  });

  it('rejects a token missing the property segment', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(() =>
      parseAllowUnsupportedPropertiesToken('AWS::Lambda::Function', undefined)
    ).toThrow(/Invalid --allow-unsupported-properties value/);
  });

  it('rejects a token missing the type segment', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(() =>
      parseAllowUnsupportedPropertiesToken('LoggingConfig', undefined)
    ).toThrow(/Invalid --allow-unsupported-properties value/);
  });

  it('rejects a hyphenated property typo (not a valid CFn property name)', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(() =>
      parseAllowUnsupportedPropertiesToken('AWS::Lambda::Function:Logging-Config', undefined)
    ).toThrow(/Invalid --allow-unsupported-properties value/);
  });

  it('rejects a lowercase-initial property name (CFn property names are PascalCase)', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(() =>
      parseAllowUnsupportedPropertiesToken(
        'AWS::Lambda::Function:loggingConfig',
        undefined
      )
    ).toThrow(/PascalCase/);
  });

  it('rejects Custom:: tokens (Custom resources have no Tier-1 silent drop)', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(() =>
      parseAllowUnsupportedPropertiesToken('Custom::Foo:Bar', undefined)
    ).toThrow(/Custom:: resources are routed through cfn-response/);
  });

  it('trims whitespace around tokens', async () => {
    const { parseAllowUnsupportedPropertiesToken } = await import(
      '../../../src/cli/options.js'
    );
    expect(
      parseAllowUnsupportedPropertiesToken(
        ' AWS::Lambda::Function:LoggingConfig , AWS::Lambda::Function:SnapStart ',
        undefined
      )
    ).toEqual([
      'AWS::Lambda::Function:LoggingConfig',
      'AWS::Lambda::Function:SnapStart',
    ]);
  });
});

describe('validateWaitFlags (issue #1275)', () => {
  it('rejects --no-wait --full-wait', async () => {
    const { validateWaitFlags } = await import('../../../src/cli/options.js');
    // Commander surfaces `--no-wait` as `wait === false`, not as a `noWait` key.
    expect(() => validateWaitFlags({ wait: false, fullWait: true })).toThrow(
      /--no-wait and --full-wait cannot be combined/
    );
  });

  it('accepts each flag on its own and the default', async () => {
    const { validateWaitFlags } = await import('../../../src/cli/options.js');
    expect(() => validateWaitFlags({ wait: false })).not.toThrow();
    expect(() => validateWaitFlags({ wait: true, fullWait: true })).not.toThrow();
    expect(() => validateWaitFlags({ wait: true })).not.toThrow();
    expect(() => validateWaitFlags({})).not.toThrow();
  });

  it('is wired into the deploy command surface', async () => {
    const cmd = createDeployCommand();
    const flags = cmd.options.map((o) => o.flags);
    expect(flags).toContain('--full-wait');
    expect(flags).toContain('--no-wait');
  });
});

// Issue #1291 item 6: the env projection lived inline in deploy.ts's action
// with no unit coverage -- deleting either `process.env` line kept every test
// green. The projection now lives in applyWaitFlagEnv so validation, the two
// mode envs, and the availability marker are covered together.
describe('applyWaitFlagEnv (issue #1291 items 1 + 6)', () => {
  const ENVS = ['CDKD_NO_WAIT', 'CDKD_FULL_WAIT', 'CDKD_WAIT_FLAGS_AVAILABLE'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('rejects --no-wait --full-wait before touching any env', async () => {
    const { applyWaitFlagEnv } = await import('../../../src/cli/options.js');
    expect(() => applyWaitFlagEnv({ wait: false, fullWait: true })).toThrow(
      /--no-wait and --full-wait cannot be combined/
    );
    expect(process.env['CDKD_NO_WAIT']).toBeUndefined();
    expect(process.env['CDKD_FULL_WAIT']).toBeUndefined();
    expect(process.env['CDKD_WAIT_FLAGS_AVAILABLE']).toBeUndefined();
  });

  it('sets CDKD_NO_WAIT for --no-wait, plus the availability marker', async () => {
    const { applyWaitFlagEnv } = await import('../../../src/cli/options.js');
    applyWaitFlagEnv({ wait: false });
    expect(process.env['CDKD_NO_WAIT']).toBe('true');
    expect(process.env['CDKD_FULL_WAIT']).toBeUndefined();
    expect(process.env['CDKD_WAIT_FLAGS_AVAILABLE']).toBe('true');
  });

  it('sets CDKD_FULL_WAIT for --full-wait, plus the availability marker', async () => {
    const { applyWaitFlagEnv } = await import('../../../src/cli/options.js');
    applyWaitFlagEnv({ wait: true, fullWait: true });
    expect(process.env['CDKD_FULL_WAIT']).toBe('true');
    expect(process.env['CDKD_NO_WAIT']).toBeUndefined();
    expect(process.env['CDKD_WAIT_FLAGS_AVAILABLE']).toBe('true');
  });

  it('default mode sets ONLY the availability marker', async () => {
    const { applyWaitFlagEnv } = await import('../../../src/cli/options.js');
    applyWaitFlagEnv({ wait: true });
    expect(process.env['CDKD_NO_WAIT']).toBeUndefined();
    expect(process.env['CDKD_FULL_WAIT']).toBeUndefined();
    expect(process.env['CDKD_WAIT_FLAGS_AVAILABLE']).toBe('true');
  });

  it('is the helper the deploy command actually calls (wiring pin)', () => {
    // A source-level pin: deploy.ts must route through applyWaitFlagEnv (not
    // hand-rolled env writes), so the projection cannot silently fork again.
    const deploySrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../src/cli/commands/deploy.ts'),
      'utf8'
    );
    expect(deploySrc).toMatch(/applyWaitFlagEnv\(options\)/);
    expect(deploySrc).not.toMatch(/process\.env\['CDKD_(NO_WAIT|FULL_WAIT|WAIT_FLAGS_AVAILABLE)'\]\s*=/);
  });
});

describe('parseStackRegion (issue #2556)', () => {
  // `--stack-region ''` is falsy, so every consumer that tested the option for
  // truthiness read it as ABSENT. Absent means "all regions" on the commands
  // that take `--all`, so a flag passed to NARROW a destructive operation
  // silently WIDENED it — `drift --all --revert --stack-region ''` wrote state
  // values into AWS across every stack in every region. The guard lives at
  // parse time so no consumer has to know.
  it('rejects an empty value', () => {
    // Commander prefixes its own `option '--stack-region <region>' argument
    // '' is invalid.` — the helper supplies only the reason, which is why the
    // assertion does not name the flag.
    expect(() => parseStackRegion('')).toThrow(/expected a region name/);
    expect(() => parseStackRegion('')).toThrow(/an empty value/);
  });

  it('rejects a whitespace-only value, and says which it was', () => {
    // Truthy, so it would take the filter branch and match no ref — which
    // reads as "no state in that region" rather than as the typo it is. The
    // message distinguishes it from the empty case so the user can see the
    // difference their shell hid.
    expect(() => parseStackRegion('   ')).toThrow(/whitespace only/);
    expect(() => parseStackRegion('   ')).not.toThrow(/an empty value/);
  });

  it('names the remedy, since omitting the flag is what the user meant', () => {
    expect(() => parseStackRegion('')).toThrow(/Omit the flag entirely/);
  });

  it('throws commander\'s InvalidArgumentError, not a bare Error', () => {
    // A bare Error escapes parseAsync to the top-level handler, which prints
    // `Fatal error:` and a Node stack trace at the user. InvalidArgumentError
    // is what commander converts into a one-line `... is invalid` and exit 1.
    expect(() => parseStackRegion('')).toThrow(InvalidArgumentError);
  });

  it('passes a real region through unchanged', () => {
    expect(parseStackRegion('us-east-1')).toBe('us-east-1');
  });

  it('does not trim — a padded value is the caller\'s, not ours to reinterpret', () => {
    expect(parseStackRegion(' us-east-1')).toBe(' us-east-1');
  });

  describe('is wired to every --stack-region in the built program', () => {
    // A TREE WALK, not a table of commands. The first version of this fence
    // drove five `state` subcommands — which all share one `stackRegionOption()`
    // factory, so it proved one declaration five times while ten others,
    // including four the CLI inherits from cdk-local and never declares here,
    // had no parser at all and no case to say so. Enumerating what the program
    // actually carries is the only form that can catch a declaration nobody
    // wrote in this repo.
    const collect = (cmd: Command, path: string[] = []): Array<[string, Option]> => {
      const here = [...path, cmd.name()];
      const found: Array<[string, Option]> = cmd.options
        .filter((o) => o.long === '--stack-region')
        .map((o) => [here.join(' '), o]);
      return [...found, ...cmd.commands.flatMap((sub) => collect(sub, here))];
    };

    it('leaves no --stack-region unguarded', () => {
      const unguarded = collect(buildProgram())
        .filter(([, o]) => o.parseArg !== parseStackRegion)
        .map(([where]) => where);
      expect(unguarded).toEqual([]);
    });

    it('leaves no --stack-region carrying a default value', () => {
      // A parser only runs on a value the user supplied. An option declared
      // with `.default('')` would hand every consumer the empty string
      // without `parseArg` ever being called, so the attachment fence would
      // stay green while the hole was open. Nothing declares one today; this
      // fails if something starts to.
      const defaulted = collect(buildProgram())
        .filter(([, o]) => o.defaultValue !== undefined)
        .map(([where]) => where);
      expect(defaulted).toEqual([]);
    });

    it('finds enough declarations for that to mean something', () => {
      // Guards the guard: an `expect([]).toEqual([])` over an empty walk would
      // pass on a broken collector. The floor is deliberately well under the
      // real count so adding a command does not fail the suite.
      expect(collect(buildProgram()).length).toBeGreaterThanOrEqual(12);
    });
  });

  describe('refuses an empty value on the real commands', () => {
    // The walk above proves the parser is ATTACHED; these prove it fires
    // through commander's own parsing, including the `--flag=` spelling a
    // `--stack-region=$UNSET_VAR` script produces.
    const argvs: Array<[string, string[]]> = [
      ['space-separated', ['state', 'show', 'Foo', '--stack-region', '']],
      ['equals form', ['state', 'show', 'Foo', '--stack-region=']],
      ['whitespace only', ['state', 'show', 'Foo', '--stack-region', '   ']],
    ];

    for (const [name, argv] of argvs) {
      it(`rejects the ${name} spelling`, () => {
        const program = buildProgram();
        program.exitOverride();
        // `parse` RUNS the registered handler, so stub every action: a lost
        // parser must surface as the missing throw, not as the real handler's
        // rejection crashing the worker.
        const stub = (cmd: Command): void => {
          cmd.exitOverride();
          cmd.action(() => {});
          cmd.commands.forEach(stub);
        };
        program.commands.forEach(stub);
        expect(() => program.parse(argv, { from: 'user' })).toThrow(/is invalid/);
      });
    }

    it('passes a real region through to an INHERITED declaration', () => {
      // The polarity that keeps the guard from being a blanket refusal, driven
      // through commander after the sweep rather than by calling the helper —
      // and on one of the four options cdkd does not declare, since those are
      // the ones the sweep is responsible for.
      const program = buildProgram();
      program.exitOverride();
      let seen: string | undefined;
      const stub = (cmd: Command): void => {
        cmd.exitOverride();
        if (cmd.name() === 'start-cloudfront') {
          cmd.action(() => {
            seen = cmd.opts()['stackRegion'] as string | undefined;
          });
        } else {
          cmd.action(() => {});
        }
        cmd.commands.forEach(stub);
      };
      program.commands.forEach(stub);

      program.parse(
        ['local', 'start-cloudfront', 'Foo', '--from-cfn-stack', 'S', '--stack-region', 'us-east-1'],
        { from: 'user' }
      );

      expect(seen).toBe('us-east-1');
    });
  });
});
