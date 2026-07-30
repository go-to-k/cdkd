import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Mechanical non-regression backstop for the "sparse poll-loop backoff" latency
 * class (PR #1175 / follow-up #1176, memory rule
 * `feedback_sdk_waiter_sparse_default_poll`).
 *
 * Every hand-rolled terminal-state poll loop in a provider uses the shape
 * `delay = Math.min(delay * N, <cap>)` with a wall-clock deadline as the loop
 * guard (`while (Date.now() - start < maxWaitMs)`). Because the guard is a
 * deadline (not a fixed attempt count), the cap only controls how DENSE the
 * polling is — a sparse cap (30_000 / 60_000) means a resource that reaches its
 * terminal state just after a poll is detected up to a full cap-interval late,
 * which is exactly what made cdkd trail Terraform on NAT / CloudFront stacks
 * until #1175. The whole class is kept tight by capping every such loop at
 * <= 15s (the fixes land on 10s).
 *
 * Two cap spellings are enforced:
 *   1. inline literal: `Math.min(delay * N, <literal>)`
 *   2. named constant:  `...maxDelay... = <literal>` (e.g. `maxDelayMs = 10_000`,
 *      `eniWaitMaxDelayMs: number = 10_000`) consumed by a `Math.min(delay * N,
 *      <name>)` loop.
 *
 * Deliberately scoped to loops whose delay variable is named exactly `delay`.
 * The DynamoDB `retryOnTransientControlPlane` loop uses `delayMs` and is
 * ATTEMPT-based (`for (attempt; attempt < maxAttempts)`), not a deadline-guarded
 * terminal-state poll — its cap is part of a deliberately-tuned fixed ~2min
 * retry budget, so lowering it would SHRINK that budget rather than just
 * densify polling. It is intentionally out of this rule's scope.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const providersDir = join(repoRoot, 'src', 'provisioning', 'providers');

const MAX_ALLOWED_CAP_MS = 15_000;

function providerFiles(): string[] {
  return readdirSync(providersDir)
    .filter((f) => f.endsWith('-provider.ts'))
    .map((f) => join(providersDir, f));
}

function parseCap(literal: string): number {
  return Number.parseInt(literal.replace(/_/g, ''), 10);
}

describe('provider poll-loop cap tightness (#1175 / #1176)', () => {
  // 1. inline `Math.min(delay * N, <literal>)`
  const inlineCap = /Math\.min\(\s*delay\s*\*\s*[\d.]+\s*,\s*(\d[\d_]*)\s*\)/g;
  // 2. named cap constant `...[Mm]axDelay... = <literal>` (excludes initialDelay)
  const namedCap = /\b\w*[Mm]axDelay\w*(?:\s*:\s*number)?\s*=\s*(\d[\d_]*)/g;

  it('every terminal-state poll loop caps its backoff at <= 15s', () => {
    const violations: string[] = [];
    let inlineSites = 0;
    let namedSites = 0;

    for (const file of providerFiles()) {
      const src = readFileSync(file, 'utf8');
      const name = file.slice(providersDir.length + 1);

      for (const m of src.matchAll(inlineCap)) {
        inlineSites++;
        const cap = parseCap(m[1]);
        if (cap > MAX_ALLOWED_CAP_MS) {
          violations.push(`${name}: Math.min(delay * .., ${m[1]}) cap ${cap}ms > ${MAX_ALLOWED_CAP_MS}ms`);
        }
      }
      for (const m of src.matchAll(namedCap)) {
        namedSites++;
        const cap = parseCap(m[1]);
        if (cap > MAX_ALLOWED_CAP_MS) {
          violations.push(`${name}: ${m[0].trim()} cap ${cap}ms > ${MAX_ALLOWED_CAP_MS}ms`);
        }
      }
    }

    // Prove the scanner actually saw its inputs — a green result must mean
    // "all caps tight", never "parsed nothing" (see .claude/rules/testing.md
    // "A checker must prove it sees its input"). The #1176-tightened set is
    // asg(1) + docdb(4) + neptune(4) + rds(4) + elasticache(2) = 15 inline
    // sites, plus 2 named caps (ec2 maxDelayMs, lambda eniWaitMaxDelayMs). The
    // scanner ALSO picks up already-tight sites not touched by #1176
    // (servicediscovery's inline 10s loop; cloudfront's named `maxDelay` 10s),
    // so live counts are >= 16 inline / >= 3 named — the floors keep margin and
    // are the "saw nothing = fail" backstop, not an exact-count assertion.
    expect(inlineSites, 'expected the inline `Math.min(delay * N, cap)` poll loops to be found').toBeGreaterThanOrEqual(15);
    expect(namedSites, 'expected the named maxDelay cap constants to be found').toBeGreaterThanOrEqual(2);

    expect(violations, `sparse poll-loop caps found (tighten to <= ${MAX_ALLOWED_CAP_MS}ms):\n${violations.join('\n')}`).toEqual([]);
  });

  // The rule above scans HAND-ROLLED loops only. The AWS SDK's own waiters
  // (`waitUntilInstanceRunning`, `waitUntilNatGatewayAvailable`,
  // `waitUntilLoadBalancerAvailable`, `waitUntilServicesStable`, ...) take their
  // cadence from a `{ minDelay, maxDelay }` config instead, which that regex
  // cannot see. That blind spot is not hypothetical: the #1177 sweep tightened
  // every hand-rolled loop to a 10s cap and left FOUR SDK-waiter sites at 15s
  // (both EC2 Instance waits + both NAT Gateway waits), where they stayed until
  // the Terraform ec2 benchmark measured cdkd losing to Terraform by ~7.5s --
  // almost exactly the mean detection lag a 15s cap produces.
  //
  // The waiter picks each delay as
  //   uniform_random(minDelay, min(minDelay * 2^(attempt-1), maxDelay))
  // so once the backoff saturates the mean lag between "AWS reached the state"
  // and "cdkd noticed" is maxDelay/2, and the RANDOM component makes the total
  // swing run to run. Capping at 10s bounds that at a mean 5s; types whose
  // operation is itself only ~30-60s (an EC2 instance) want tighter still, but
  // a blanket rule cannot know per-type speed, so 10s is the enforced ceiling
  // and individual sites may go lower.
  const MAX_ALLOWED_WAITER_MAXDELAY_S = 10;

  // Recursively list every .ts source file under src/ — the rule covers the
  // WHOLE tree, not just providers. The #1291 item-5 finding: the previous
  // version scanned provider files for `{ minDelay, maxDelay }` CONFIGS, so a
  // `waitUntil*` call that passed no config at all (running at the SDK's
  // 15s-120s defaults, or 30s for the CloudFormation waiters) was invisible —
  // eight such calls existed in export.ts / retire-cfn-stack.ts /
  // macro-expander.ts.
  function srcFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...srcFiles(full));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  it('every AWS SDK waiter CALL SITE carries an explicit tight { minDelay, maxDelay } config', () => {
    const srcRoot = join(repoRoot, 'src');
    const violations: string[] = [];
    let callSites = 0;
    let configuredSites = 0;
    const filesWithCalls = new Set<string>();

    // A call site is `waitUntilXxx(` (imports / re-exports don't parenthesize).
    // Its first argument is the waiter config object literal; line comments may
    // sit between the paren and the brace. Capture up to the closing brace
    // non-greedily — a future config with a NESTED object literal before
    // minDelay truncates early and reads as "no inline config", which fails
    // LOUD (a spurious violation), never silently green. minDelay / maxDelay
    // may appear in EITHER order (the old `minDelay:\s*\d+,\s*maxDelay:` regex
    // was key-order-evadable). A spread literal (`{ ...cfg }`) is flagged as
    // unconfigured; a bare IDENTIFIER config (`waitUntilX(cfg, input)`) does
    // not match this regex at all — that evasion is closed by the raw-count
    // reconciliation below, which counts every `waitUntil*(` occurrence and
    // fails when the two counters diverge.
    const callSite = /waitUntil\w+\(\s*(?:\/\/[^\n]*\n\s*)*\{([\s\S]*?)\}\s*,/g;
    const rawCallSite = /waitUntil\w+\(/g;
    let rawCallSites = 0;

    for (const file of srcFiles(srcRoot)) {
      const src = readFileSync(file, 'utf8');
      const name = file.slice(srcRoot.length + 1);

      rawCallSites += [...src.matchAll(rawCallSite)].length;
      for (const m of src.matchAll(callSite)) {
        callSites++;
        filesWithCalls.add(name);
        const config = m[1]!;
        const minM = config.match(/\bminDelay:\s*(\d[\d_]*)/);
        const maxM = config.match(/\bmaxDelay:\s*(\d[\d_]*)/);
        if (!minM || !maxM) {
          violations.push(
            `${name}: a waitUntil* call site has no inline { minDelay, maxDelay } — it runs at the SDK default cadence (15s-120s exp backoff; 30s flat for CloudFormation waiters)`
          );
          continue;
        }
        configuredSites++;
        const minDelay = parseCap(minM[1]!);
        const maxDelay = parseCap(maxM[1]!);
        if (maxDelay > MAX_ALLOWED_WAITER_MAXDELAY_S) {
          violations.push(
            `${name}: { minDelay: ${minDelay}, maxDelay: ${maxDelay} } — maxDelay ${maxDelay}s > ${MAX_ALLOWED_WAITER_MAXDELAY_S}s (mean detection lag ${maxDelay / 2}s)`
          );
        }
        if (minDelay > maxDelay) {
          violations.push(
            `${name}: { minDelay: ${minDelay}, maxDelay: ${maxDelay} } — minDelay exceeds maxDelay`
          );
        }
      }
    }

    // Coverage floors — "saw nothing = fail", per .claude/rules/testing.md.
    // 18 call sites live in the tree today: 10 in providers (4 ec2, 1 elbv2,
    // 1 ecs, 3 custom-resource, 1 lambda-function) + 5 export.ts +
    // 2 retire-cfn-stack.ts + 1 macro-expander.ts. The non-provider category
    // floor pins the shape the old scan missed, so a regression that stops
    // seeing THOSE cannot hide under the total.
    expect(callSites, 'expected the waitUntil* call sites to be found').toBeGreaterThanOrEqual(18);
    expect(
      [...filesWithCalls].filter((f) => !f.startsWith('provisioning/providers/')).length,
      'expected waitUntil* call sites OUTSIDE provisioning/providers to be seen (export / retire-cfn-stack / macro-expander)'
    ).toBeGreaterThanOrEqual(3);
    // Raw-count reconciliation: every `waitUntil*(` occurrence must have been
    // parsed by the config-literal regex. A bare identifier config
    // (`waitUntilX(cfg, input)`), a block comment before the brace, or any
    // other shape the literal regex cannot see makes the counters diverge and
    // fails HERE instead of silently dropping out of the scan. (The literal
    // regex's own matches split exactly into configured + no-inline-violation
    // by construction, so comparing against the RAW count is what makes this
    // a real invariant rather than a tautology.)
    expect(
      rawCallSites,
      'every waitUntil*( occurrence must be parseable by the config-literal regex — a bare identifier config or block-comment shape evades the cap rule; inline the { minDelay, maxDelay } literal'
    ).toBe(callSites);

    expect(
      violations,
      `sparse or missing SDK waiter configs found (inline { minDelay, maxDelay } with maxDelay <= ${MAX_ALLOWED_WAITER_MAXDELAY_S}s):\n${violations.join('\n')}`
    ).toEqual([]);
  });
});
