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
    // "A checker must prove it sees its input"). The tightened set is asg(1) +
    // docdb(4) + neptune(4) + rds(4) + elasticache(2) = 15 inline sites, plus
    // the two named caps (ec2 maxDelayMs, lambda eniWaitMaxDelayMs).
    expect(inlineSites, 'expected the inline `Math.min(delay * N, cap)` poll loops to be found').toBeGreaterThanOrEqual(15);
    expect(namedSites, 'expected the named maxDelay cap constants (ec2, lambda) to be found').toBeGreaterThanOrEqual(2);

    expect(violations, `sparse poll-loop caps found (tighten to <= ${MAX_ALLOWED_CAP_MS}ms):\n${violations.join('\n')}`).toEqual([]);
  });
});
