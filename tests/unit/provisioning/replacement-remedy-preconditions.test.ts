/**
 * Issue [#2610]: a user-facing message must not name a remedy whose
 * precondition the emitting code never checks.
 *
 * Two families, both pinned here:
 *
 * (a) the advised replacement is blocked by a protection flag the emitting
 *     provider ALREADY holds in its properties bag — BOTH polarities are
 *     asserted per site, because a refusal that fires on everything satisfies
 *     every positive assertion;
 * (b) the message names a flag the advised command does not have — the
 *     `cdkd deploy --replace <LogicalId>` sites, where `--replace` is a boolean
 *     Option and `[stacks...]` swallows the id.
 *
 * Plus the sibling class the #2610 sweep turned up: a bare `--replace` advised
 * for a type in `STATEFUL_TYPES`, which the deploy engine's own replace
 * fallback refuses a second time with `STATEFUL_REPLACE_BLOCKED`.
 *
 * Every provider exercised here builds its AWS client lazily and every guard
 * asserted here throws BEFORE the first client call, so no SDK mock is needed —
 * which is itself part of what the tests pin: a refusal that reached AWS first
 * would fail differently.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  protectedReplacementAdvice,
  DELETION_PROTECTION_DOC_POINTER,
} from '../../../src/provisioning/replacement-protection-advice.js';
import { STATEFUL_TYPES } from '../../../src/provisioning/stateful-types.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { EMRClusterProvider } from '../../../src/provisioning/providers/emr-cluster-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { DLMLifecyclePolicyProvider } from '../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import { SchedulerScheduleProvider } from '../../../src/provisioning/providers/scheduler-schedule-provider.js';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';

/** Drive an `update()` that must throw, and hand back the message. */
async function refusalMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected update() to refuse, but it resolved');
}

describe('protectedReplacementAdvice', () => {
  const advice = protectedReplacementAdvice({
    evidence: "cdkd's recorded properties for this widget carry Protected: true",
    replaceFlags: 'cdkd deploy --replace',
    disableCommand: 'aws widgets unprotect --id w-1',
  });

  it('names the evidence, the mechanism, the doc section and the disable command', () => {
    expect(advice).toContain("cdkd's recorded properties for this widget carry Protected: true");
    expect(advice).toContain('cdkd deploy has no --remove-protection flag to clear it');
    expect(advice).toContain(DELETION_PROTECTION_DOC_POINTER);
    expect(advice).toContain('`aws widgets unprotect --id w-1`');
  });

  it('names the replace flags on BOTH the refusal and the re-run, from one input', () => {
    // The two spellings cannot drift apart: one argument feeds both.
    const occurrences = advice.split('cdkd deploy --replace').length - 1;
    expect(occurrences).toBe(2);
  });

  it('does not promise an outcome the emitting update() cannot see', () => {
    // Issue #2579's three review rounds each proved a downstream sentence
    // FALSE. The advice must defer to the doc rather than restate them.
    expect(advice).not.toMatch(/re-enable protection/i);
    expect(advice).not.toMatch(/the replacement (then )?deletes the old/i);
    expect(advice).toContain('depend on your UpdateReplacePolicy');
  });
});

describe('ELBv2 LoadBalancer immutable-property refusal (site 1)', () => {
  const provider = new ELBv2Provider();
  const arn = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/lb/abc';
  const run = (previousProperties: Record<string, unknown>) =>
    refusalMessage(() =>
      provider.update(
        'Lb',
        arn,
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Name: 'new-name', Scheme: 'internal' },
        { Name: 'old-name', Scheme: 'internet-facing', ...previousProperties }
      )
    );

  it('names the deletion-protection dead end when the RECORDED attributes carry it', async () => {
    const message = await run({
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '60' },
        { Key: 'deletion_protection.enabled', Value: 'true' },
      ],
    });
    expect(message).toContain('LoadBalancerAttributes deletion_protection.enabled=true');
    expect(message).toContain('cdkd deploy has no --remove-protection flag');
    expect(message).toContain(`--load-balancer-arn '${arn}'`);
    expect(message).toContain('Key=deletion_protection.enabled,Value=false');
  });

  it('keeps the short advice when protection is off', async () => {
    const message = await run({
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '60' },
        { Key: 'deletion_protection.enabled', Value: 'false' },
      ],
    });
    expect(message).toContain('re-deploy with cdkd deploy --replace');
    expect(message).not.toContain('--remove-protection');
    expect(message).not.toContain('modify-load-balancer-attributes');
  });

  it('keeps the short advice when the attribute is absent entirely', async () => {
    const message = await run({});
    expect(message).not.toContain('--remove-protection');
  });

  it('reads the RECORDED bag, not the desired one', async () => {
    // A template ADDING protection alongside the immutable change leaves AWS
    // unprotected, because this refusal fires before any attribute is applied.
    const message = await refusalMessage(() =>
      provider.update(
        'Lb',
        arn,
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        {
          Name: 'new-name',
          LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
        },
        {
          Name: 'old-name',
          LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
        }
      )
    );
    expect(message).not.toContain('--remove-protection');
  });
});

describe('EMR Cluster immutable-property refusals (sites 2 and 3)', () => {
  const provider = new EMRClusterProvider();
  const clusterId = 'j-ABCDEF123456';

  it('is a stateful type, so both refusals must name --force-stateful-recreation', () => {
    // Premise, asserted rather than assumed: without it the flag half of the
    // fix below would be arbitrary.
    expect(STATEFUL_TYPES.has('AWS::EMR::Cluster')).toBe(true);
  });

  const instancesSite = (prevInstances: Record<string, unknown>) =>
    refusalMessage(() =>
      provider.update(
        'Cluster',
        clusterId,
        'AWS::EMR::Cluster',
        { Instances: { ...prevInstances, MasterInstanceType: 'm5.2xlarge' } },
        { Instances: { ...prevInstances, MasterInstanceType: 'm5.xlarge' } }
      )
    );
  const topLevelSite = (prevInstances: Record<string, unknown>) =>
    refusalMessage(() =>
      provider.update(
        'Cluster',
        clusterId,
        'AWS::EMR::Cluster',
        { ReleaseLabel: 'emr-7.0.0', Instances: prevInstances },
        { ReleaseLabel: 'emr-6.0.0', Instances: prevInstances }
      )
    );

  for (const [label, site] of [
    ['Instances sub-field', instancesSite],
    ['top-level property', topLevelSite],
  ] as const) {
    it(`${label}: names the termination-protection dead end when recorded`, async () => {
      const message = await site({ TerminationProtected: true });
      expect(message).toContain('Instances.TerminationProtected: true');
      expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
      expect(message).toContain(`--cluster-id '${clusterId}' --no-termination-protected`);
    });

    it(`${label}: keeps the short advice when protection is off`, async () => {
      const message = await site({ TerminationProtected: false });
      expect(message).toContain('Re-deploy with cdkd deploy --replace --force-stateful-recreation');
      expect(message).not.toContain('--remove-protection');
      expect(message).not.toContain('modify-cluster-attributes');
    });
  }

  it('accepts the CFn boolean-as-string spelling', async () => {
    const message = await instancesSite({ TerminationProtected: 'true' });
    expect(message).toContain('Instances.TerminationProtected: true');
  });
});

describe('AutoScalingGroup name-change refusal (site 8)', () => {
  const provider = new ASGProvider();
  const run = (recordedProtection: unknown) =>
    refusalMessage(() =>
      provider.update(
        'Asg',
        'my-asg',
        'AWS::AutoScaling::AutoScalingGroup',
        { AutoScalingGroupName: 'new-asg' },
        { AutoScalingGroupName: 'my-asg', DeletionProtection: recordedProtection }
      )
    );

  it('names the dead end for each protecting enum value', async () => {
    for (const value of ['prevent-force-deletion', 'prevent-all-deletion']) {
      const message = await run(value);
      expect(message).toContain(`DeletionProtection: ${value}`);
      expect(message).toContain('cdkd deploy has no --remove-protection flag');
      expect(message).toContain("--auto-scaling-group-name 'my-asg' --deletion-protection none");
    }
  });

  it("keeps the short advice for 'none', the readCurrentState placeholder", async () => {
    const message = await run('none');
    expect(message).toContain('Use cdkd deploy --replace to replace the group.');
    expect(message).not.toContain('--remove-protection');
  });

  it('keeps the short advice when the key is absent or unusable', async () => {
    for (const value of [undefined, '', 42, { Ref: 'Something' }]) {
      const message = await run(value);
      expect(message).not.toContain('--remove-protection');
    }
  });

  it('is NOT a stateful type, so the advice must not name --force-stateful-recreation', async () => {
    expect(STATEFUL_TYPES.has('AWS::AutoScaling::AutoScalingGroup')).toBe(false);
    expect(await run('none')).not.toContain('--force-stateful-recreation');
  });
});

describe('family (b): the advised command must not take a resource id', () => {
  it('DLM LifecyclePolicy names a bare --replace (site 12)', async () => {
    const message = await refusalMessage(() =>
      new DLMLifecyclePolicyProvider().update(
        'Policy',
        'policy-0123456789abcdef0',
        'AWS::DLM::LifecyclePolicy',
        { DefaultPolicy: 'VOLUME' },
        { DefaultPolicy: 'INSTANCE' }
      )
    );
    // The feared shape, spelled exactly as the regression emits it.
    expect(message).not.toContain('cdkd deploy --replace Policy');
    expect(message).toContain('`cdkd deploy --replace`');
    expect(message).toContain('takes no resource id');
    // The logical id is still reachable — it is in the error head.
    expect(message).toContain('(Policy)');
  });

  it('Scheduler Schedule names a bare --replace (site 13)', async () => {
    const message = await refusalMessage(() =>
      new SchedulerScheduleProvider().update(
        'Sched',
        'my-sched',
        'AWS::Scheduler::Schedule',
        { Name: 'my-sched', GroupName: 'group-b' },
        { Name: 'my-sched', GroupName: 'group-a' }
      )
    );
    expect(message).not.toContain('cdkd deploy --replace Sched');
    expect(message).toContain('`cdkd deploy --replace`');
    expect(message).toContain('takes no resource id');
    expect(message).toContain('(Sched)');
  });
});

describe('sibling sweep: a stateful type must not advise a bare --replace', () => {
  it('EFS FileSystem', async () => {
    expect(STATEFUL_TYPES.has('AWS::EFS::FileSystem')).toBe(true);
    const message = await refusalMessage(() =>
      new EFSProvider().update(
        'Fs',
        'fs-0123456789abcdef0',
        'AWS::EFS::FileSystem',
        { PerformanceMode: 'maxIO' },
        { PerformanceMode: 'generalPurpose' }
      )
    );
    expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
    expect(message).toContain('STATEFUL_REPLACE_BLOCKED');
  });

  it('FSx FileSystem, top-level and variant sub-property', async () => {
    expect(STATEFUL_TYPES.has('AWS::FSx::FileSystem')).toBe(true);
    const provider = new FSxFileSystemProvider();
    const topLevel = await refusalMessage(() =>
      provider.update(
        'Fs',
        'fs-0123456789abcdef0',
        'AWS::FSx::FileSystem',
        { FileSystemType: 'LUSTRE' },
        { FileSystemType: 'WINDOWS' }
      )
    );
    expect(topLevel).toContain('cdkd deploy --replace --force-stateful-recreation');
    const variant = await refusalMessage(() =>
      provider.update(
        'Fs',
        'fs-0123456789abcdef0',
        'AWS::FSx::FileSystem',
        { LustreConfiguration: { DeploymentType: 'SCRATCH_2' } },
        { LustreConfiguration: { DeploymentType: 'PERSISTENT_1' } }
      )
    );
    expect(variant).toContain('cdkd deploy --replace --force-stateful-recreation');
  });

  it('S3Vectors VectorBucket', async () => {
    expect(STATEFUL_TYPES.has('AWS::S3Vectors::VectorBucket')).toBe(true);
    const message = await refusalMessage(() =>
      new S3VectorsProvider().update(
        'Vb',
        'my-vector-bucket',
        'AWS::S3Vectors::VectorBucket',
        { VectorBucketName: 'renamed' },
        { VectorBucketName: 'my-vector-bucket' }
      )
    );
    expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
    expect(message).toContain('STATEFUL_REPLACE_BLOCKED');
  });
});

describe('the class fence: no src message advises a --replace with an argument', () => {
  // Derived from the SHAPE, not from the two files this change touched:
  // `--replace` followed by an interpolation or a placeholder.
  const ARGUMENT_FORM = /--replace [^ `'"),]*[<$]/;

  it('has no `--replace ${...}` / `--replace <id>` site left in src/ CODE', async () => {
    const hits = (await srcCodeLines()).filter((row) => ARGUMENT_FORM.test(row.text));
    expect(hits.map((row) => `${row.file}:${row.line}`)).toEqual([]);
  });

  it('positive control: the pattern DOES match the shape that was fixed', () => {
    // The regression's own spelling, so a fence that matched nothing at all
    // could not pass as a clean tree.
    expect(ARGUMENT_FORM.test('`cdkd deploy --replace ${logicalId}` to recreate')).toBe(true);
    expect(ARGUMENT_FORM.test('cdkd deploy --replace <LogicalId>')).toBe(true);
    // ...and does not fire on the corrected spelling.
    expect(ARGUMENT_FORM.test('re-run with `cdkd deploy --replace` to recreate it')).toBe(false);
    expect(ARGUMENT_FORM.test('cdkd deploy --replace --force-stateful-recreation')).toBe(false);
  });

  it('positive control: the comment filter does not eat a code line', () => {
    expect(isCommentOnly("  const m = `cdkd deploy --replace ${id}`;")).toBe(false);
    expect(isCommentOnly('  // cdkd deploy --replace <LogicalId>')).toBe(true);
    expect(isCommentOnly('   * cdkd deploy --replace <LogicalId>')).toBe(true);
  });

  it('positive control: the scan reaches real string literals', async () => {
    const rows = await srcCodeLines();
    expect(rows.length).toBeGreaterThan(1000);
    expect(rows.some((row) => row.text.includes('cdkd deploy --replace'))).toBe(true);
  });
});

/**
 * Every `.ts` line under `src/`, with COMMENT-ONLY lines removed.
 *
 * The fence above watches what a USER can be shown, so the comments this change
 * added to EXPLAIN the retired spelling must not trip it — while an allow-list
 * naming the fixed files would be satisfied by its own text. Dropping comment
 * lines separates the two without naming any file. Line-based on purpose: a
 * needle inside a user-facing string always shares its line with code, and the
 * positive controls above keep the filter honest.
 */
async function srcCodeLines(): Promise<Array<{ file: string; line: number; text: string }>> {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const out: Array<{ file: string; line: number; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) {
        readFileSync(full, 'utf8')
          .split('\n')
          .forEach((text, i) => {
            if (!isCommentOnly(text)) out.push({ file: full, line: i + 1, text });
          });
      }
    }
  };
  walk('src');
  return out;
}

/** A line whose first non-space characters start a comment, or continue a block one. */
function isCommentOnly(text: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(text);
}
