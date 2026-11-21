/**
 * Unit tests for `scripts/check-replaced-delete-deferral.ts` (issue #6713):
 * each shape on synthetic sources (found / not found), the audit's verdicts
 * (unlisted, count moved, stale, incomplete), the floors, the real tree, and
 * the CI wiring. The real-code probes (an inline delete before the deferral, a
 * provider update() that deletes then creates) are recorded in the PR body.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import type { SiteRow } from '../../../scripts/gen-provider-replace-branches.ts';
import {
  EXCEPTIONS,
  FLOORS,
  SHAPES,
  type Exception,
  type Site,
  audit,
  deployReaches,
  floorFailures,
  isEngineScanned,
  scanDeferralGate,
  scanGateArguments,
  scanProviderDeleteCalls,
  scanProviderOwnDeletes,
  scanProviderReplaceSites,
  scanTree,
} from '../../../scripts/check-replaced-delete-deferral.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.ts';

const REPO_ROOT = resolve(__dirname, '../../..');
const GATE_FILE = 'src/deployment/deploy-engine/replacement/delete-replaced.ts';

const GATE_SOURCE = `
export async function deleteReplacedAfterCreate(run, deps, logicalId, isRetry = false, holds = false) {
  if (!isRetry && !holds && deferToCleanupPhase(run, deps, logicalId)) {
    run.deferred.set(logicalId, { retry: () => deleteReplacedAfterCreate(run, deps, logicalId, true) });
    return;
  }
  const send = () => deps.provider.delete(logicalId, 'id', 'AWS::X::Y', {});
  await send();
}
function deferToCleanupPhase(run, deps, logicalId) {
  if (run.deferred === undefined) return false;
  if (deps.inline(logicalId)) {
    // a comment the key must not carry
    return false;
  }
  const nested = () => { return false; };
  if (deps.ok) return true;
  return deps.needs(logicalId);
}
`;

describe('replaced-delete-deferral: provider-delete-call', () => {
  it('finds a provider delete (3+ arguments) under its enclosing named function, not a Map delete', () => {
    const sites = scanProviderDeleteCalls('src/deployment/x.ts', GATE_SOURCE);
    expect(sites.map((s) => s.key)).toEqual(['src/deployment/x.ts:deleteReplacedAfterCreate']);
    const map = scanProviderDeleteCalls('src/deployment/x.ts', 'function f(m) { m.delete(k); m?.delete(k); }');
    expect(map).toEqual([]);
  });

  it('a module-level arrow names its own site; a class method its own', () => {
    const text = `
export const drop = async (p) => { await p.delete('L', 'id', 'T'); };
class C { async run(p) { await p?.delete('L', 'id', 'T', {}); } }`;
    expect(scanProviderDeleteCalls('src/deployment/y.ts', text).map((s) => s.key)).toEqual([
      'src/deployment/y.ts:drop',
      'src/deployment/y.ts:run',
    ]);
  });

  it('scans src/deployment/** but not the rollback replays', () => {
    expect(isEngineScanned('src/deployment/deploy-engine/replacement/create-first.ts')).toBe(true);
    expect(isEngineScanned('src/deployment/superseded-resources.ts')).toBe(true);
    expect(isEngineScanned('src/deployment/rollback-executor/replay-failed.ts')).toBe(false);
    expect(isEngineScanned('src/deployment/deploy-engine/rollback/perform.ts')).toBe(false);
    expect(isEngineScanned('src/cli/commands/destroy-runner/under-lock.ts')).toBe(false);
  });
});

describe('replaced-delete-deferral: deferral-exit and gate-argument', () => {
  it("keys every gate operand and every non-true return of the deferral, comments stripped", () => {
    const { sites, callerParams } = scanDeferralGate(GATE_FILE, GATE_SOURCE);
    expect(sites.map((s) => s.key.slice(GATE_FILE.length + 1))).toEqual([
      'deleteReplacedAfterCreate: !isRetry',
      'deleteReplacedAfterCreate: !holds',
      'deferToCleanupPhase: run.deferred === undefined',
      'deferToCleanupPhase: deps.inline(logicalId)',
      'deferToCleanupPhase: return deps.needs(logicalId)',
    ]);
    expect([...callerParams]).toEqual([
      ['isRetry', 3],
      ['holds', 4],
    ]);
  });

  it('refuses a tree where the gate or the deferral moved', () => {
    expect(() => scanDeferralGate(GATE_FILE, 'function deferToCleanupPhase() { return true; }')).toThrow(
      /no function deleteReplacedAfterCreate/
    );
    expect(() =>
      scanDeferralGate(GATE_FILE, 'export async function deleteReplacedAfterCreate() { if (x) return; }')
    ).toThrow(/no function deferToCleanupPhase/);
    expect(() =>
      scanDeferralGate(
        GATE_FILE,
        'export async function deleteReplacedAfterCreate() { await send(); }\nfunction deferToCleanupPhase() { return true; }'
      )
    ).toThrow(/0 `if` guarding/);
  });

  it('a caller passing a caller-decided parameter anything but nothing or `false` is a site', () => {
    const params = new Map([
      ['isRetry', 3],
      ['holds', 4],
    ]);
    const text = `
async function a() { await deleteReplacedAfterCreate(r, d, l); }
async function b() { await deleteReplacedAfterCreate(r, d, l, false, false); }
async function c() { await deleteReplacedAfterCreate(r, d, l, true); }
async function e(n) { await deleteReplacedAfterCreate(r, d, l, false, n.id === o.id); }`;
    expect(scanGateArguments('src/z.ts', text, params).map((s) => s.key)).toEqual([
      'src/z.ts:c:isRetry',
      'src/z.ts:e:holds',
    ]);
  });
});

const row = (over: Partial<SiteRow>): SiteRow => ({
  key: 'k',
  resourceType: 'AWS::X::Y',
  className: 'P',
  file: 'src/provisioning/providers/p.ts',
  function: 'update',
  signal: 'own-create',
  triggers: [],
  status: 'ok',
  ...over,
});

describe('replaced-delete-deferral: the provider shapes', () => {
  it('a replace branch the deploy hands a change through update() is a site; one the engine replaces first is not', () => {
    expect(deployReaches(row({ triggers: [{ property: 'A', verdict: 'replacement', via: 'create-only' }] }))).toBe(false);
    expect(deployReaches(row({ triggers: [{ property: 'A', verdict: 'conditional' }] }))).toBe(false);
    expect(deployReaches(row({ triggers: [{ property: 'A', verdict: 'provider-marked' }] }))).toBe(true);
    expect(deployReaches(row({ triggers: [{ property: 'A', verdict: 'exempt', exemption: 'cfn-update' }] }))).toBe(
      true
    );
    expect(deployReaches(row({ triggers: [{ property: 'A', verdict: 'gap' }] }))).toBe(true);
    expect(deployReaches(row({ status: 'underived' }))).toBe(true);
    expect(deployReaches(row({ disposition: { kind: 'no-template-trigger', rationale: 'r' } }))).toBe(false);
    expect(
      scanProviderReplaceSites([row({ triggers: [{ property: 'A', verdict: 'provider-marked' }] })]).map((s) => s.key)
    ).toEqual(['AWS::X::Y src/provisioning/providers/p.ts:update']);
  });

  it('a this.delete( outside delete() and outside every replace function is a site', () => {
    const text = `
class P {
  async delete(l, id, t) { await this.delete(l, id, t); }
  async update(l, id, t) { await this.delete(l, id, t); return this.create(l, t, {}); }
  async swap(l, id, t) { await this.delete(l, id, t); }
}`;
    const file = 'src/provisioning/providers/p.ts';
    const out = scanProviderOwnDeletes(file, text, new Set([`${file}:swap`]));
    expect(out.calls).toBe(3);
    expect(out.sites.map((s) => s.key)).toEqual([`${file}:update`]);
  });
});

describe('replaced-delete-deferral: the audit', () => {
  const site = (key: string, shape: Site['shape'] = 'provider-delete-call'): Site => ({ shape, key, at: `${key}:1` });
  const early: Exception = {
    shape: 'provider-delete-call',
    key: 'a',
    count: 1,
    kind: 'early-delete',
    cannotDefer: 'why',
    rollbackReports: 'how',
  };

  it('passes a listed site with its count', () => {
    expect(audit([site('a')], [early])).toEqual([]);
  });

  it('fails an unlisted site, naming it', () => {
    const failures = audit([site('a'), site('b')], [early]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/unreviewed early delete.*provider-delete-call b at b:1/);
  });

  it('fails when the count moves, either way', () => {
    expect(audit([site('a'), site('a')], [early])[0]).toMatch(/2 site\(s\), the exception lists 1/);
    expect(audit([site('a')], [{ ...early, count: 2 }])[0]).toMatch(/1 site\(s\), the exception lists 2/);
  });

  it('fails a stale exception', () => {
    expect(audit([], [early])).toEqual([
      'stale exception (no such site any more; remove or re-key it): provider-delete-call a',
    ]);
  });

  it('fails an exception that names no reason, and a duplicate', () => {
    expect(audit([site('a')], [{ ...early, rollbackReports: ' ' }])[0]).toMatch(/must name why it cannot defer/);
    expect(
      audit([site('a')], [{ shape: 'provider-delete-call', key: 'a', count: 1, kind: 'not-a-replacement', reason: '' }])[0]
    ).toMatch(/must give its reason/);
    expect(audit([site('a')], [early, early])).toContain('duplicate exception: provider-delete-call a');
  });

  it('the shape is part of the identity', () => {
    expect(audit([site('a', 'gate-argument')], [early])).toHaveLength(2);
  });

  it('a floor fails per shape, and on the inputs read', () => {
    const failures = floorFailures({ sites: [], replaceRows: 0, ownDeleteCalls: 0 });
    expect(failures).toHaveLength(SHAPES.length + 2);
  });
});

describe('replaced-delete-deferral: the real tree', () => {
  it(
    'every site is reviewed, no exception is stale, and every shape is at its floor',
    () => {
      const scan = scanTree();
      expect(audit(scan.sites)).toEqual([]);
      expect(floorFailures(scan)).toEqual([]);
      for (const shape of SHAPES) {
        expect(scan.sites.filter((s) => s.shape === shape).length).toBeGreaterThanOrEqual(FLOORS[shape]);
      }
    },
    CONTENDED_CASE_TIMEOUT_MS
  );

  it('lists each #6713 inventory row as an early-delete exception', () => {
    const early = EXCEPTIONS.filter((e) => e.kind === 'early-delete').map((e) => e.key);
    expect(early.some((k) => k.endsWith('isInlinePolicyType(oldResource.resourceType)'))).toBe(true);
    expect(early.filter((k) => k.endsWith(':newHoldsOldIdAndType'))).toHaveLength(2);
    expect(early.some((k) => k.startsWith('AWS::SNS::Subscription '))).toBe(true);
    expect(early.some((k) => k.endsWith('replace-fallback.ts:replaceFallbackFor'))).toBe(true);
    expect(early.some((k) => k.endsWith('delete-first.ts:replaceDeleteFirstAndRecreate'))).toBe(true);
    expect(early.some((k) => k.endsWith('recreate.ts:recreateDestroyThenCreate'))).toBe(true);
  });
});

describe('replaced-delete-deferral: CI wiring', () => {
  it('is a Vite+ task with the cache disabled, invoked by CI', () => {
    const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const entry = config.slice(config.indexOf("'audit:replaced-delete-deferral:check'"));
    expect(entry).toContain('scripts/check-replaced-delete-deferral.ts');
    expect(entry.slice(0, entry.indexOf('},'))).toContain('cache: false');
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('vp run audit:replaced-delete-deferral:check');
  });
});
