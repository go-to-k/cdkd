import { Command, Option } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { adoptDeprecatedRegionFlag } from '../../../src/cli/region-options.js';

/**
 * Issue [#2522](https://github.com/go-to-k/cdkd/issues/2522) — the four
 * `cdkd local start-*` shims never folded `--region`.
 *
 * They are 75-135 line wrappers that hand their parsed options bag straight to
 * cdk-local, so there is no cdkd-owned line inside the handler where the
 * `canonicalizeRegion` call the other four `local` commands make could go.
 * `cli-region-fold.test.ts`'s scanner could not see them either: it looks for a
 * `options.region ?? process.env['AWS_REGION']` shape, and these files never
 * name `options.region` at all. So `--region US-EAST-1` reached cdk-local's SDK
 * clients, the ECR host it synthesizes for an image pull, the SigV4 credential
 * scope and the `AWS_REGION` every container it starts receives — the
 * [#1795](https://github.com/go-to-k/cdkd/issues/1795) class, in the command set
 * that shipped after #1795.
 *
 * This is the BEHAVIOURAL half of the fence, deliberately live rather than a
 * source scan: it drives commander's real parser through
 * `adoptDeprecatedRegionFlag`'s `preAction` hook and reads the option bag the
 * action would have received. Removing the fold from any ONE of the four turns
 * its rows red. The STRUCTURAL half — "a fifth shim cannot be added unfolded" —
 * lives in `cli-region-fold.test.ts`, which is where the rest of this class is
 * fenced.
 */

/** The four commands whose handler cdk-local owns. */
const SHIMS = ['start-service', 'start-alb', 'start-cloudfront', 'start-agentcore'] as const;

/**
 * The `cdkd local` tree with every subcommand's action stubbed out.
 *
 * The stub replaces the ACTION only; `preAction` hooks still run, which is the
 * point — the fold under test IS a hook (the `cmd-parse-stub-gate` hook requires
 * this stub for any `cmd.parse()` in a test).
 */
function localTree(): Command {
  const local = createLocalCommand();
  for (const sub of local.commands) sub.action(() => {});
  return local;
}

function parseOpts(name: string, argv: string[]): Record<string, unknown> {
  const local = localTree();
  local.parse([name, ...argv], { from: 'user' });
  const sub = local.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`no such subcommand: ${name}`);
  return sub.opts();
}

describe('cdkd local start-*: --region is folded before cdk-local sees it (#2522)', () => {
  const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
  beforeEach(() => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });
  afterEach(() => {
    if (saved.region === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = saved.region;
    if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = saved.def;
    vi.restoreAllMocks();
  });

  it.each(SHIMS)('%s folds --region to its canonical spelling', (name) => {
    // `CN-NORTH-1` rather than `US-EAST-1` on purpose: `us-east-1` is this
    // repo's own fallback region, so an assertion pinned to it passes under a
    // mutation that drops the value entirely. A China-partition region can only
    // come from the flag, and it is also the case where the partition-prefix
    // walk (and therefore the endpoint suffix) is decided case-sensitively.
    expect(parseOpts(name, ['--region', 'CN-NORTH-1']).region).toBe('cn-north-1');
  });

  it.each(SHIMS)('%s folds --stack-region and keeps the RAW spelling beside it', (name) => {
    // `rawStackRegion` is not symmetry: `local-state-source.ts`'s `--from-state`
    // factory falls back to the still-raw `stackRegion` when it is absent, and
    // folding without capturing first would collapse that fallback onto the
    // folded value — silently disabling the exact-spelling state-record match
    // (issue #1836 round 3).
    const opts = parseOpts(name, ['--stack-region', 'AP-NORTHEAST-1']);
    expect(opts.stackRegion).toBe('ap-northeast-1');
    expect(opts.rawStackRegion).toBe('AP-NORTHEAST-1');
  });

  it.each(SHIMS)('%s leaves an absent --region absent rather than inventing one', (name) => {
    const opts = parseOpts(name, []);
    expect(opts.region).toBeUndefined();
    expect(opts.stackRegion).toBeUndefined();
    expect(opts.rawStackRegion).toBeUndefined();
  });

  it.each(SHIMS)('%s folds the AWS_REGION / AWS_DEFAULT_REGION env vars too', (name) => {
    // The half no fold at a cdkd READ site can reach: with no `--region`,
    // cdk-local builds region-less SDK clients and the AWS SDK's own chain reads
    // these two variables directly (issue #2065).
    process.env['AWS_REGION'] = 'CN-NORTH-1';
    process.env['AWS_DEFAULT_REGION'] = 'CN-NORTH-1';
    parseOpts(name, []);
    expect(process.env['AWS_REGION']).toBe('cn-north-1');
    expect(process.env['AWS_DEFAULT_REGION']).toBe('cn-north-1');
  });

  it.each(SHIMS)('%s hides --region from --help, like every other cdkd command', (name) => {
    const sub = localTree().commands.find((c) => c.name() === name);
    const region = sub?.options.find((option) => option.long === '--region');
    expect(region, `${name} lost its --region option entirely`).toBeDefined();
    // The user-visible delta of this change: cdk-local declared it VISIBLY and
    // undeprecated; cdkd's shared `deprecatedRegionOption` is hidden and says so.
    expect(region?.hidden).toBe(true);
    expect(region?.description).toContain('[deprecated]');
    // Exactly one — a failed splice of cdk-local's declaration would leave two
    // `--region` entries, and commander answers `opts().region` from whichever
    // parsed last.
    expect(sub?.options.filter((option) => option.long === '--region')).toHaveLength(1);
  });

  it.each(SHIMS)('%s warns that --region is deprecated when it is passed', (name) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    parseOpts(name, ['--region', 'cn-north-1']);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('--region is deprecated');
  });

  it.each(SHIMS)('%s does NOT warn when --region was not passed', (name) => {
    // The other direction: a warning that fires unconditionally would satisfy
    // the case above while nagging every user of these four commands.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    parseOpts(name, []);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).not.toContain('--region is deprecated');
  });
});

/**
 * {@link adoptDeprecatedRegionFlag} in isolation — the arms the four live
 * commands cannot exercise.
 *
 * Every case above runs it against a command that ALREADY carries cdk-local's
 * `--region`, so the splice's `inherited === -1` arm — the one its own comment
 * says exists for a shim that stops inheriting the flag upstream — had no
 * coverage at all, and the residue-clearing added after review had none either.
 * Deleting the splice makes commander throw at CONSTRUCTION, which is a fine
 * safety net but not an assertion, so the discriminating cases live here.
 */
describe('adoptDeprecatedRegionFlag in isolation', () => {
  const savedEnv = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
  beforeEach(() => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });
  afterEach(() => {
    if (savedEnv.region === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedEnv.region;
    if (savedEnv.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = savedEnv.def;
    vi.restoreAllMocks();
  });

  /**
   * A stand-in for a shim, with or without an inherited `--region`.
   *
   * `--stack-region` is declared unconditionally because cdk-local declares it
   * on all four real commands and `adoptDeprecatedRegionFlag` folds it; without
   * the declaration commander would drop the value and the fold case below
   * would pass on an option that was never parsed.
   */
  function shim(inherited?: Option): Command {
    const cmd = new Command('probe')
      .argument('[target]')
      .addOption(new Option('--stack-region <region>', 'upstream stack region'));
    if (inherited) cmd.addOption(inherited);
    adoptDeprecatedRegionFlag(cmd);
    cmd.action(() => {});
    return cmd;
  }

  it('adopts the flag on a command that inherits NO --region', () => {
    const cmd = shim();
    const region = cmd.options.filter((option) => option.long === '--region');
    expect(region).toHaveLength(1);
    expect(region[0]?.hidden).toBe(true);
    cmd.parse(['--region', 'CN-NORTH-1'], { from: 'user' });
    expect(cmd.opts()['region']).toBe('cn-north-1');
  });

  it("clears an inherited --region's DEFAULT, so it cannot masquerade as user input", () => {
    // The residue the array splice alone leaves behind. cdk-local's `--region`
    // is bare today, so this asserts against the shape that would break it: an
    // upstream default would sit in `_optionValues` with source `default`,
    // making the deprecation warning fire on EVERY invocation and the fold
    // honour a region nobody named.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cmd = shim(new Option('--region <region>', 'upstream').default('US-WEST-2'));
    cmd.parse([], { from: 'user' });
    expect(cmd.opts()['region']).toBeUndefined();
    expect(cmd.getOptionValueSource('region')).toBeUndefined();
    // `undefined` is not enough: the bag is handed to cdk-local BY REFERENCE,
    // so an own `region: undefined` key is visible to `'region' in options`
    // and to `Object.keys`. An earlier cut assigned rather than deleted and
    // this assertion is the only one that told the two apart.
    expect(Object.hasOwn(cmd.opts(), 'region')).toBe(false);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).not.toContain('--region is deprecated');
  });

  it('removes the inherited listener, so one --region does not fire two handlers', () => {
    const cmd = shim(new Option('--region <region>', 'upstream'));
    // `Command` extends `EventEmitter` at runtime but is not typed as one.
    const emitter = cmd as unknown as { listenerCount(event: string): number };
    expect(emitter.listenerCount('option:region')).toBe(1);
  });

  it('removes the inherited ENV listener too, not just the flag one', () => {
    // `optionEnv:<name>` is a separate commander event, registered only for an
    // option declaring `.env()`. Without its own case, deleting that line from
    // the helper leaves every other assertion green.
    const cmd = shim(new Option('--region <region>', 'upstream').env('UPSTREAM_REGION'));
    const emitter = cmd as unknown as { listenerCount(event: string): number };
    expect(emitter.listenerCount('optionEnv:region')).toBe(0);
  });

  it.each(SHIMS)('%s carries exactly one option:region listener', (name) => {
    // The stand-in above cannot see an upstream DOUBLE registration; the real
    // commands can, and this is the assertion that would catch it.
    const sub = localTree().commands.find((c) => c.name() === name);
    const emitter = sub as unknown as { listenerCount(event: string): number };
    expect(emitter.listenerCount('option:region')).toBe(1);
  });

  it('leaves an already-canonical spelling byte-identical', () => {
    // The other direction of the fold: a normalizer that rewrote its input
    // unconditionally would satisfy every case above.
    const cmd = shim();
    cmd.action(() => {}); // no-op stub — `shim()` sets one; restated for the gate
    cmd.parse(['--region', 'ap-northeast-1', '--stack-region', 'eu-west-1'], { from: 'user' });
    expect(cmd.opts()['region']).toBe('ap-northeast-1');
    expect(cmd.opts()['stackRegion']).toBe('eu-west-1');
    expect(cmd.opts()['rawStackRegion']).toBe('eu-west-1');
  });
});
