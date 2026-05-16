import { describe, it, expect } from 'vite-plus/test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DescribeTypeCommand,
  ListTypesCommand,
  type ProvisioningType,
} from '@aws-sdk/client-cloudformation';
import {
  atomicWriteFile,
  checkCachedAgainstSource,
  classifyProvisioningType,
  describeTypeWithRetry,
  loadCachedReport,
  paginateListTypes,
  parseRegisteredTypes,
  partitionCoverage,
  renderMarkdown,
  renderSummaryToStdout,
  type CfnClientLike,
  type CoverageReport,
} from '../../../scripts/audit-provider-coverage.js';

describe('parseRegisteredTypes', () => {
  it('extracts every registry.register(...) type name', () => {
    const source = `
      registry.register('AWS::IAM::Role', new IAMRoleProvider());
      registry.register("AWS::S3::Bucket", new S3BucketProvider());
      const shared = new ECSProvider();
      registry.register('AWS::ECS::Cluster', shared);
      registry.register(  'AWS::ECS::Service'  ,  shared  );
    `;
    const result = parseRegisteredTypes(source);
    expect(result).toEqual(
      new Set(['AWS::IAM::Role', 'AWS::S3::Bucket', 'AWS::ECS::Cluster', 'AWS::ECS::Service'])
    );
  });

  it('returns empty set when source has no register calls', () => {
    expect(parseRegisteredTypes('// nothing here\nexport const x = 1;')).toEqual(new Set());
  });

  it('ignores non-AWS:: prefixed strings (e.g. Custom::)', () => {
    const source = `
      registry.register('Custom::SomeResource', new X());
      registry.register('AWS::Lambda::Function', new Y());
    `;
    expect(parseRegisteredTypes(source)).toEqual(new Set(['AWS::Lambda::Function']));
  });

  it('matches against the real register-providers.ts source', () => {
    // Pull the actual file off disk and assert canonical SDK Providers are
    // present. Guards against regex regressions silently dropping types.
    const realPath = join(process.cwd(), 'src/provisioning/register-providers.ts');
    const source = readFileSync(realPath, 'utf8');
    const result = parseRegisteredTypes(source);
    // Spot-check across several categories.
    expect(result.has('AWS::IAM::Role')).toBe(true);
    expect(result.has('AWS::S3::Bucket')).toBe(true);
    expect(result.has('AWS::Lambda::Function')).toBe(true);
    expect(result.has('AWS::EC2::VPC')).toBe(true);
    expect(result.has('AWS::ApiGateway::Method')).toBe(true);
    // Expect a non-trivial total — guards against the regex accidentally
    // matching only the first occurrence.
    expect(result.size).toBeGreaterThan(40);
  });
});

describe('classifyProvisioningType', () => {
  it('classifies FULLY_MUTABLE / IMMUTABLE as Tier 2', () => {
    expect(classifyProvisioningType('FULLY_MUTABLE')).toBe('tier2-cc-api-fallback');
    expect(classifyProvisioningType('IMMUTABLE')).toBe('tier2-cc-api-fallback');
  });

  it('classifies NON_PROVISIONABLE as Tier 3', () => {
    expect(classifyProvisioningType('NON_PROVISIONABLE')).toBe('tier3-unsupported');
  });

  it('classifies undefined / unknown values as Tier 3', () => {
    expect(classifyProvisioningType(undefined)).toBe('tier3-unsupported');
    expect(classifyProvisioningType('SOMETHING_NEW' as ProvisioningType)).toBe(
      'tier3-unsupported'
    );
  });
});

describe('paginateListTypes', () => {
  it('walks NextToken pagination to completion', async () => {
    const sendCalls: ListTypesCommand[] = [];
    const responses = [
      { TypeSummaries: [{ TypeName: 'AWS::Foo::Bar' }], NextToken: 'tok1' },
      { TypeSummaries: [{ TypeName: 'AWS::Baz::Qux' }], NextToken: 'tok2' },
      { TypeSummaries: [{ TypeName: 'AWS::Quux::Final' }] },
    ];
    let idx = 0;
    const client: CfnClientLike = {
      // eslint-disable-next-line @typescript-eslint/require-await
      send: async (command) => {
        if (command instanceof ListTypesCommand) {
          sendCalls.push(command);
          const resp = responses[idx++];
          if (!resp) throw new Error('over-read');
          return resp;
        }
        throw new Error('unexpected command');
      },
    } as CfnClientLike;

    const collected: string[] = [];
    for await (const typeName of paginateListTypes(client)) {
      collected.push(typeName);
    }
    expect(collected).toEqual(['AWS::Foo::Bar', 'AWS::Baz::Qux', 'AWS::Quux::Final']);
    expect(sendCalls.length).toBe(3);
    // First call has no NextToken; subsequent calls carry the prior token.
    expect(sendCalls[0]!.input.NextToken).toBeUndefined();
    expect(sendCalls[1]!.input.NextToken).toBe('tok1');
    expect(sendCalls[2]!.input.NextToken).toBe('tok2');
    // Every call narrows to AWS-owned LIVE resource types.
    for (const call of sendCalls) {
      expect(call.input.Type).toBe('RESOURCE');
      expect(call.input.Visibility).toBe('PUBLIC');
      expect(call.input.DeprecatedStatus).toBe('LIVE');
      expect(call.input.Filters?.Category).toBe('AWS_TYPES');
    }
  });

  it('handles empty TypeSummaries gracefully', async () => {
    const client: CfnClientLike = {
      send: async () => ({}),
    } as CfnClientLike;
    const collected: string[] = [];
    for await (const t of paginateListTypes(client)) collected.push(t);
    expect(collected).toEqual([]);
  });

  it('skips entries with no TypeName', async () => {
    const client: CfnClientLike = {
      send: async () => ({
        TypeSummaries: [{ TypeName: 'AWS::X::Y' }, {}, { TypeName: 'AWS::Z::A' }],
      }),
    } as CfnClientLike;
    const collected: string[] = [];
    for await (const t of paginateListTypes(client)) collected.push(t);
    expect(collected).toEqual(['AWS::X::Y', 'AWS::Z::A']);
  });
});

describe('describeTypeWithRetry', () => {
  it('returns ProvisioningType on first success', async () => {
    const client: CfnClientLike = {
      send: async (cmd) => {
        if (cmd instanceof DescribeTypeCommand) {
          return { ProvisioningType: 'FULLY_MUTABLE' as ProvisioningType };
        }
        throw new Error('unexpected');
      },
    } as CfnClientLike;
    const result = await describeTypeWithRetry(client, 'AWS::Foo::Bar');
    expect(result).toBe('FULLY_MUTABLE');
  });

  it('retries on ThrottlingException with backoff, then succeeds', async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];
    const client: CfnClientLike = {
      send: async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('Rate exceeded');
          err.name = 'ThrottlingException';
          throw err;
        }
        return { ProvisioningType: 'IMMUTABLE' as ProvisioningType };
      },
    } as CfnClientLike;
    const result = await describeTypeWithRetry(client, 'AWS::Foo::Bar', {
      retryDelaysMs: [10, 20, 30],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(result).toBe('IMMUTABLE');
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([10, 20]);
  });

  it('throws after exhausting retries on persistent throttling', async () => {
    const client: CfnClientLike = {
      send: async () => {
        const err = new Error('Rate exceeded');
        err.name = 'Throttling';
        throw err;
      },
    } as CfnClientLike;
    await expect(
      describeTypeWithRetry(client, 'AWS::Foo::Bar', {
        retryDelaysMs: [1, 1],
        sleep: async () => {},
      })
    ).rejects.toThrow(/Rate exceeded/);
  });

  it('propagates non-throttling errors without retry', async () => {
    let attempts = 0;
    const client: CfnClientLike = {
      send: async () => {
        attempts++;
        const err = new Error('AccessDenied');
        err.name = 'AccessDeniedException';
        throw err;
      },
    } as CfnClientLike;
    await expect(
      describeTypeWithRetry(client, 'AWS::Foo::Bar', {
        retryDelaysMs: [10, 20],
        sleep: async () => {},
      })
    ).rejects.toThrow(/AccessDenied/);
    expect(attempts).toBe(1);
  });
});

describe('partitionCoverage', () => {
  function buildClient(provisioningByType: Record<string, ProvisioningType | string>): CfnClientLike {
    return {
      send: async (cmd) => {
        if (cmd instanceof DescribeTypeCommand) {
          const name = cmd.input.TypeName ?? '';
          return { ProvisioningType: provisioningByType[name] };
        }
        throw new Error('unexpected');
      },
    } as CfnClientLike;
  }

  it('partitions into three tiers correctly', async () => {
    const registered = new Set(['AWS::IAM::Role', 'AWS::S3::Bucket']);
    const universe = [
      'AWS::IAM::Role',
      'AWS::S3::Bucket',
      'AWS::Foo::Mutable',
      'AWS::Foo::Immutable',
      'AWS::Foo::Unsupported',
    ];
    const client = buildClient({
      'AWS::Foo::Mutable': 'FULLY_MUTABLE',
      'AWS::Foo::Immutable': 'IMMUTABLE',
      'AWS::Foo::Unsupported': 'NON_PROVISIONABLE',
    });

    const report = await partitionCoverage(client, registered, universe, {
      concurrency: 2,
      sleep: async () => {},
    });

    expect(report.tier1).toEqual(['AWS::IAM::Role', 'AWS::S3::Bucket']);
    expect(report.tier2).toEqual(['AWS::Foo::Immutable', 'AWS::Foo::Mutable']);
    expect(report.tier3).toEqual(['AWS::Foo::Unsupported']);
    expect(report.summary).toEqual({
      tier1Count: 2,
      tier2Count: 2,
      tier3Count: 1,
      totalCount: 5,
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('classifies DescribeType missing ProvisioningType as Tier 3', async () => {
    const client: CfnClientLike = {
      send: async () => ({}),
    } as CfnClientLike;
    const report = await partitionCoverage(client, new Set(), ['AWS::Foo::Bar'], {
      sleep: async () => {},
    });
    expect(report.tier3).toEqual(['AWS::Foo::Bar']);
  });

  it('routes DescribeType errors to onError handler defaulting to Tier 3', async () => {
    const client: CfnClientLike = {
      send: async () => {
        const err = new Error('AccessDenied');
        err.name = 'AccessDeniedException';
        throw err;
      },
    } as CfnClientLike;
    const errored: string[] = [];
    const report = await partitionCoverage(client, new Set(), ['AWS::Foo::Bar'], {
      sleep: async () => {},
      onError: (typeName) => {
        errored.push(typeName);
        return 'tier3-unsupported';
      },
    });
    expect(errored).toEqual(['AWS::Foo::Bar']);
    expect(report.tier3).toEqual(['AWS::Foo::Bar']);
  });

  it('skips DescribeType for already-Tier-1 types', async () => {
    let describeCalls = 0;
    const client: CfnClientLike = {
      send: async () => {
        describeCalls++;
        return { ProvisioningType: 'FULLY_MUTABLE' as ProvisioningType };
      },
    } as CfnClientLike;
    const report = await partitionCoverage(
      client,
      new Set(['AWS::A::A', 'AWS::B::B']),
      ['AWS::A::A', 'AWS::B::B'],
      { sleep: async () => {} }
    );
    expect(describeCalls).toBe(0);
    expect(report.tier1).toEqual(['AWS::A::A', 'AWS::B::B']);
    expect(report.tier2).toEqual([]);
  });

  it('reports per-type progress via onProgress', async () => {
    const client = buildClient({
      'AWS::A::A': 'FULLY_MUTABLE',
      'AWS::B::B': 'NON_PROVISIONABLE',
    });
    const events: Array<{ done: number; total: number; tier: string }> = [];
    await partitionCoverage(client, new Set(), ['AWS::A::A', 'AWS::B::B'], {
      sleep: async () => {},
      onProgress: (done, total, _name, tier) => {
        events.push({ done, total, tier });
      },
    });
    expect(events.length).toBe(2);
    // total is always 2 since both types are non-Tier-1.
    expect(events.every((e) => e.total === 2)).toBe(true);
    // done counts up from 1 to 2 (concurrency may reorder, so just check set).
    expect(new Set(events.map((e) => e.done))).toEqual(new Set([1, 2]));
  });

  it('sorts tier lists alphabetically for diff-friendly output', async () => {
    const client = buildClient({
      'AWS::Z::A': 'FULLY_MUTABLE',
      'AWS::A::A': 'FULLY_MUTABLE',
      'AWS::M::M': 'FULLY_MUTABLE',
    });
    const report = await partitionCoverage(
      client,
      new Set(),
      ['AWS::Z::A', 'AWS::A::A', 'AWS::M::M'],
      { sleep: async () => {} }
    );
    expect(report.tier2).toEqual(['AWS::A::A', 'AWS::M::M', 'AWS::Z::A']);
  });
});

describe('renderMarkdown', () => {
  const sampleReport: CoverageReport = {
    schemaVersion: 1,
    generatedAt: '2026-05-16T00:00:00.000Z',
    summary: { tier1Count: 1, tier2Count: 1, tier3Count: 1, totalCount: 3 },
    tier1: ['AWS::IAM::Role'],
    tier2: ['AWS::Foo::Mutable'],
    tier3: ['AWS::Foo::Unsupported'],
  };

  it('produces a deterministic Markdown report', () => {
    const md = renderMarkdown(sampleReport);
    // Headings render.
    expect(md).toContain('# Provider Coverage Report');
    expect(md).toContain('## Tier 1 — SDK Provider registered');
    expect(md).toContain('## Tier 2 — Cloud Control API fallback');
    expect(md).toContain('## Tier 3 — Not provisionable by cdkd today');
    // Type entries appear as bullet lines.
    expect(md).toContain('- `AWS::IAM::Role`');
    expect(md).toContain('- `AWS::Foo::Mutable`');
    expect(md).toContain('- `AWS::Foo::Unsupported`');
    // Summary table cites the counts.
    expect(md).toContain('| **Tier 1** | SDK Provider (preferred) | 1 |');
    expect(md).toContain('| **Tier 2** | Cloud Control API fallback | 1 |');
    expect(md).toContain('| **Tier 3** | Not provisionable by cdkd today | 1 |');
    // Generated timestamp surfaced.
    expect(md).toContain('2026-05-16T00:00:00.000Z');
  });

  it('renders cleanly even when a tier is empty', () => {
    const emptyTier3: CoverageReport = { ...sampleReport, tier3: [] };
    const md = renderMarkdown(emptyTier3);
    expect(md).toContain('## Tier 3 — Not provisionable by cdkd today');
    // No bullet lines under Tier 3 when empty.
    const tier3Section = md.slice(md.indexOf('## Tier 3'));
    expect(tier3Section).not.toMatch(/- `AWS::/);
  });
});

describe('renderSummaryToStdout', () => {
  it('renders a compact summary', () => {
    const out = renderSummaryToStdout({
      schemaVersion: 1,
      generatedAt: '2026-05-16T00:00:00.000Z',
      summary: { tier1Count: 95, tier2Count: 1200, tier3Count: 50, totalCount: 1345 },
      tier1: [],
      tier2: [],
      tier3: [],
    });
    expect(out).toContain('Generated: 2026-05-16T00:00:00.000Z');
    expect(out).toContain('Total CFn resource types: 1345');
    expect(out).toContain('Tier 1 (SDK Provider):       95');
    expect(out).toContain('Tier 2 (CC API fallback):    1200');
    expect(out).toContain('Tier 3 (no support):         50');
  });
});

describe('atomicWriteFile', () => {
  it('writes via .tmp then renames; leaves no .tmp on success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const target = join(dir, 'nested', 'report.json');
      atomicWriteFile(target, '{"hello":"world"}\n');
      expect(readFileSync(target, 'utf8')).toBe('{"hello":"world"}\n');
      expect(existsSync(`${target}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates parent directories if missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const target = join(dir, 'a', 'b', 'c', 'r.json');
      atomicWriteFile(target, 'x');
      expect(readFileSync(target, 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadCachedReport', () => {
  it('returns the parsed report when schemaVersion matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const report: CoverageReport = {
        schemaVersion: 1,
        generatedAt: '2026-05-16T00:00:00.000Z',
        summary: { tier1Count: 0, tier2Count: 0, tier3Count: 0, totalCount: 0 },
        tier1: [],
        tier2: [],
        tier3: [],
      };
      const target = join(dir, 'report.json');
      atomicWriteFile(target, JSON.stringify(report));
      expect(loadCachedReport(target)).toEqual(report);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a stale schemaVersion with a regen hint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const target = join(dir, 'report.json');
      atomicWriteFile(target, JSON.stringify({ schemaVersion: 99 }));
      expect(() => loadCachedReport(target)).toThrow(/--regenerate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkCachedAgainstSource', () => {
  it('reports ok when cached Tier 1 equals registered set', () => {
    const result = checkCachedAgainstSource(
      ['AWS::IAM::Role', 'AWS::S3::Bucket'],
      new Set(['AWS::S3::Bucket', 'AWS::IAM::Role'])
    );
    expect(result).toEqual({ ok: true, missingFromCache: [], extraInCache: [] });
  });

  it('detects providers added to source but not the cached audit', () => {
    const result = checkCachedAgainstSource(
      ['AWS::IAM::Role'],
      new Set(['AWS::IAM::Role', 'AWS::NewlyAdded::Type'])
    );
    expect(result.ok).toBe(false);
    expect(result.missingFromCache).toEqual(['AWS::NewlyAdded::Type']);
    expect(result.extraInCache).toEqual([]);
  });

  it('detects providers in the cache that are gone from source', () => {
    const result = checkCachedAgainstSource(
      ['AWS::IAM::Role', 'AWS::Stale::Removed'],
      new Set(['AWS::IAM::Role'])
    );
    expect(result.ok).toBe(false);
    expect(result.missingFromCache).toEqual([]);
    expect(result.extraInCache).toEqual(['AWS::Stale::Removed']);
  });

  it('handles both missing and extra simultaneously', () => {
    const result = checkCachedAgainstSource(
      ['AWS::A::A', 'AWS::B::B'],
      new Set(['AWS::B::B', 'AWS::C::C'])
    );
    expect(result.ok).toBe(false);
    expect(result.missingFromCache).toEqual(['AWS::C::C']);
    expect(result.extraInCache).toEqual(['AWS::A::A']);
  });

  it('sorts diff output for deterministic CI logs', () => {
    const result = checkCachedAgainstSource(
      ['AWS::Z::Z', 'AWS::A::A'],
      new Set(['AWS::M::M'])
    );
    expect(result.missingFromCache).toEqual(['AWS::M::M']);
    expect(result.extraInCache).toEqual(['AWS::A::A', 'AWS::Z::Z']);
  });
});
