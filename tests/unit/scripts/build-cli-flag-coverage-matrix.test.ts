import { describe, it, expect } from 'vite-plus/test';
import {
  parseFlagSpec,
  parseOptionSpecsFromSource,
  parseDeclaredFlags,
  scanFlagsInShellScript,
} from '../../../scripts/build-cli-flag-coverage-matrix.js';

describe('parseFlagSpec', () => {
  it('parses a bare long flag', () => {
    expect(parseFlagSpec('--verbose')).toEqual({
      long: ['--verbose'],
      short: [],
      raw: '--verbose',
    });
  });

  it('parses short+long with comma separator', () => {
    expect(parseFlagSpec('-f, --force')).toEqual({
      long: ['--force'],
      short: ['-f'],
      raw: '-f, --force',
    });
  });

  it('strips <arg> placeholder', () => {
    expect(parseFlagSpec('--profile <profile>')).toEqual({
      long: ['--profile'],
      short: [],
      raw: '--profile <profile>',
    });
  });

  it('strips [optional-arg] placeholder', () => {
    expect(parseFlagSpec('--assume-task-role [<arn>]')).toEqual({
      long: ['--assume-task-role'],
      short: [],
      raw: '--assume-task-role [<arn>]',
    });
  });

  it('strips variadic ... syntax', () => {
    expect(parseFlagSpec('-c, --context <key=value...>')).toEqual({
      long: ['--context'],
      short: ['-c'],
      raw: '-c, --context <key=value...>',
    });
  });

  it('handles --no-rollback negation form as long flag', () => {
    expect(parseFlagSpec('--no-rollback')).toEqual({
      long: ['--no-rollback'],
      short: [],
      raw: '--no-rollback',
    });
  });
});

describe('parseOptionSpecsFromSource', () => {
  it('extracts the first-arg string from `new Option(...)` calls', () => {
    const src = `
      new Option('--verbose', 'Enable verbose logging');
      new Option('-f, --force', 'Force the action');
    `;
    expect(parseOptionSpecsFromSource(src)).toEqual(['--verbose', '-f, --force']);
  });

  it('handles double-quoted spec strings', () => {
    const src = `new Option("--profile <profile>", "AWS profile")`;
    expect(parseOptionSpecsFromSource(src)).toEqual(['--profile <profile>']);
  });

  it('handles multi-line Option constructors', () => {
    const src = `
      new Option(
        '--role-arn <arn>',
        'IAM role to assume'
      ).default(false);
    `;
    expect(parseOptionSpecsFromSource(src)).toEqual(['--role-arn <arn>']);
  });

  it('returns an empty array when no Option calls present', () => {
    expect(parseOptionSpecsFromSource('export const x = 1;')).toEqual([]);
  });

  it('returns multiple specs in source order', () => {
    const src = `
      new Option('--one');
      new Option(
        '--two <arg>',
        'desc'
      );
      new Option("--three");
    `;
    expect(parseOptionSpecsFromSource(src)).toEqual(['--one', '--two <arg>', '--three']);
  });
});

describe('parseDeclaredFlags', () => {
  it('returns sorted unique long-form flags only (short forms omitted)', () => {
    const src = `
      new Option('-f, --force', 'force');
      new Option('--verbose', 'verbose');
      new Option('-y, --yes', 'yes');
    `;
    expect(parseDeclaredFlags(src)).toEqual(['--force', '--verbose', '--yes']);
  });

  it('deduplicates flags declared in multiple Option calls', () => {
    const src = `
      new Option('--verbose', 'first');
      new Option('--verbose', 'duplicate');
    `;
    expect(parseDeclaredFlags(src)).toEqual(['--verbose']);
  });

  it('returns empty array when no Option declarations', () => {
    expect(parseDeclaredFlags('')).toEqual([]);
  });
});

describe('scanFlagsInShellScript', () => {
  it('detects --foo style flags in a shell command', () => {
    const sh = `cdkd deploy --verbose --stack MyStack --no-rollback`;
    const result = scanFlagsInShellScript(sh);
    expect(result.has('--verbose')).toBe(true);
    expect(result.has('--stack')).toBe(true);
    expect(result.has('--no-rollback')).toBe(true);
  });

  it('detects flags inside quoted strings (intentional — scripts often use them)', () => {
    const sh = `echo "Running with --dry-run flag"`;
    expect(scanFlagsInShellScript(sh).has('--dry-run')).toBe(true);
  });

  it('does NOT count short-form flags', () => {
    const sh = `cdkd destroy -f -y`;
    const result = scanFlagsInShellScript(sh);
    expect(result.has('-f')).toBe(false);
    expect(result.has('-y')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('returns empty set for shell with no flags', () => {
    expect(scanFlagsInShellScript('echo hello').size).toBe(0);
  });

  it('handles flags with hyphens in the name', () => {
    const sh = `cdkd deploy --no-aggressive-vpc-parallel --resource-warn-after 5m`;
    const result = scanFlagsInShellScript(sh);
    expect(result.has('--no-aggressive-vpc-parallel')).toBe(true);
    expect(result.has('--resource-warn-after')).toBe(true);
  });

  it('deduplicates repeated flag occurrences', () => {
    const sh = `cdkd deploy --stack A --stack B --stack C`;
    const result = scanFlagsInShellScript(sh);
    expect(result.size).toBe(1);
    expect(result.has('--stack')).toBe(true);
  });
});
