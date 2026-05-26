import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { Command } from 'commander';

import {
  commonOptions,
  deprecatedRegionOption,
  effectiveResourceTimeoutMs,
  parseContextOptions,
  parseDuration,
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
