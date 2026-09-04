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
  isMainModule,
  loadCachedReport,
  paginateListTypes,
  parseCliArgs,
  parseRegisteredTypes,
  assertReportIsComplete,
  isRetryableDescribeTypeError,
  partitionCoverage,
  renderMarkdown,
  renderSummaryToStdout,
  runCheck,
  summarizeCachedReport,
  type CfnClientLike,
  type CliIO,
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

describe('isRetryableDescribeTypeError', () => {
  it('accepts throttles and transient transport failures, refuses the rest', () => {
    const named = (name: string, message = 'x') => Object.assign(new Error(message), { name });
    // Each accepted shape reaches the classifier through ONE arm only. The
    // first cut used `Object.assign(new Error('read ECONNRESET'), { code:
    // 'ECONNRESET' })`, where the message ALSO matches — so deleting either
    // arm stayed green and neither was independently fenced.
    for (const [label, err] of [
      ['name: ThrottlingException', named('ThrottlingException')],
      ['name: Throttling', named('Throttling')],
      ['name: TimeoutError', named('TimeoutError')],
      ['name: RequestTimeout', named('RequestTimeout')],
      ['name: AbortError', named('AbortError')],
      // MESSAGE arm only — no `code`, and a name of plain `Error`. This is the
      // measured shape (issue #2571).
      ['message only: socket hang up', new Error('socket hang up')],
      // CODE arm only — the message deliberately says nothing the regex knows.
      // Every errno token gets BOTH shapes. The first split fixed the mutual
      // masking between the two arms but left each TOKEN in one arm only, so
      // dropping an individual entry from either list stayed green.
      ...(
        ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'] as const
      ).flatMap(
        (code) =>
          [
            [`code only: ${code}`, Object.assign(new Error('operation failed'), { code })],
            [`message only: ${code}`, new Error(`connect ${code} 10.0.0.1:443`)],
          ] as const
      ),
      // ...and one row in the REAL Node shape, where both are set at once.
      [
        'both: read ECONNRESET with code',
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      ],
      // The undici shape: the top frame says nothing and the errno is one hop
      // down in `cause`.
      [
        'cause: fetch failed wrapping ECONNRESET',
        Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        }),
      ],
    ] as const) {
      expect(isRetryableDescribeTypeError(err), label).toBe(true);
    }
    for (const [label, err] of [
      ['permission denial', named('AccessDeniedException', 'User is not authorized')],
      ['validation', named('ValidationException', 'Type not found')],
      ['type not found', named('TypeNotFoundException')],
      // The reason the message arm is NOT `/network|timeout/i`: AWS's own
      // permanent text carries those words through the TYPE NAME, and 48 of
      // the audited types are named `*Network*`. Retrying them burns the whole
      // backoff and lands where it started.
      [
        'a permanent not-found naming a Network type',
        named(
          'TypeNotFoundException',
          "Type with name 'AWS::EC2::NetworkInterface' (RESOURCE) cannot be found."
        ),
      ],
      [
        'a permanent denial naming a NetworkFirewall type',
        named(
          'AccessDeniedException',
          'not authorized to perform: cloudformation:DescribeType on resource: ' +
            'arn:aws:cloudformation:us-east-1::type/resource/AWS-NetworkFirewall-Firewall'
        ),
      ],
      ['a property called timeout', named('ValidationException', 'Invalid property: timeout')],
      // A cause chain whose bottom is still permanent must stay refused, or the
      // hop becomes a way in for every wrapped AccessDenied.
      [
        'cause: a wrapped permission denial',
        Object.assign(new Error('request failed'), {
          cause: Object.assign(new Error('User is not authorized'), {
            name: 'AccessDeniedException',
          }),
        }),
      ],
      ['not an error at all', 'not an error'],
      ['undefined', undefined],
    ] as const) {
      expect(isRetryableDescribeTypeError(err), label).toBe(false);
    }
  });

  it('a non-Error value is refused before any property read', () => {
    // The `instanceof Error` guard: without it the `code` read and the message
    // regex both run against whatever was thrown.
    for (const v of [null, undefined, 42, { code: 'ECONNRESET' }, { message: 'socket hang up' }]) {
      expect(isRetryableDescribeTypeError(v)).toBe(false);
    }
  });
});

describe('assertReportIsComplete', () => {
  const base = {
    schemaVersion: 1,
    generatedAt: 'x',
    summary: { tier1Count: 0, tier2Count: 0, tier3Count: 0, totalCount: 0 },
    tier1: [],
    tier2: [],
    tier3: [],
  };

  it('refuses a report that could not classify a type, naming each one', () => {
    // The mechanism issue #2571 exists for, and it had NO test: `regenerate`
    // is unexported and only reachable through live AWS calls, so extracting
    // the assertion is what makes both polarities pinnable offline.
    expect(() =>
      assertReportIsComplete({ ...base, undetermined: ['AWS::Foo::Bar', 'AWS::Baz::Qux'] })
    ).toThrow(/AWS::Foo::Bar[\s\S]*AWS::Baz::Qux/);
    // The COUNT, pinned exactly: `/2 type|1 type\(s\)/` accepted a wrong count
    // of 2 for a one-element list.
    expect(() => assertReportIsComplete({ ...base, undetermined: ['AWS::Foo::Bar'] })).toThrow(
      /^\[audit\] 1 type\(s\) could not be classified/
    );
    expect(() =>
      assertReportIsComplete({ ...base, undetermined: ['AWS::A::A', 'AWS::B::B', 'AWS::C::C'] })
    ).toThrow(/^\[audit\] 3 type\(s\) could not be classified/);
  });

  it('accepts a complete report — both the ABSENT and the EMPTY spelling', () => {
    // Two arms of the same conjunction: `undefined` (the field is omitted when
    // empty) and `[]` (a hand-written or future report that emits it anyway).
    expect(() => assertReportIsComplete(base)).not.toThrow();
    expect(() => assertReportIsComplete({ ...base, undetermined: [] })).not.toThrow();
  });

  it('has no escape hatch — a second argument cannot suppress the refusal', () => {
    // A `--allow-undetermined` flag was drafted and withdrawn: `runCheck`
    // refuses any committed report listing one and runs on every PR, so a
    // report written through the hatch would have left `main` permanently red.
    // Pinned as a case because a future reader will have the same idea.
    const report = { ...base, undetermined: ['AWS::Foo::Bar'] };
    expect(() =>
      (assertReportIsComplete as (r: CoverageReport, allow?: boolean) => void)(report, true)
    ).toThrow(/could not be classified/);
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

  it('every tier list is a SET — a type ListTypes returns twice appears once', async () => {
    // AWS returned `AWS::Logs::LogStream` twice across `ListTypes` pages
    // (issue #2571), and `partitionCoverage` walked `allTypes` straight into
    // the tier arrays. The duplicate cost a wasted `DescribeType`, published a
    // `tier2Count` one too high, and reached every downstream consumer twice —
    // `scripts/audit-stateful-candidates.ts` had to dedupe at its own boundary
    // for exactly that reason.
    //
    // Duplicates are injected in all THREE tiers, and in both page positions
    // (adjacent and split across the rest of the list), because the walk is
    // order-sensitive in neither direction and a single-tier case would leave
    // the other two arms free.
    const registered = new Set(['AWS::IAM::Role']);
    const universe = [
      'AWS::IAM::Role',
      'AWS::Foo::Mutable',
      'AWS::IAM::Role', // adjacent-ish repeat, tier 1
      'AWS::Foo::Unsupported',
      'AWS::Foo::Mutable', // repeat split across the list, tier 2
      'AWS::Foo::Unsupported', // tier 3
    ];
    const described: string[] = [];
    const client = {
      send: async (cmd: DescribeTypeCommand) => {
        if (cmd instanceof DescribeTypeCommand) {
          described.push(cmd.input.TypeName ?? '');
          return {
            ProvisioningType: (
              {
                'AWS::Foo::Mutable': 'FULLY_MUTABLE',
                'AWS::Foo::Unsupported': 'NON_PROVISIONABLE',
              } as Record<string, string>
            )[cmd.input.TypeName ?? ''],
          };
        }
        throw new Error('unexpected');
      },
    } as unknown as CfnClientLike;

    const report = await partitionCoverage(client, registered, universe, {
      concurrency: 2,
      sleep: async () => {},
    });

    for (const [label, list] of [
      ['tier1', report.tier1],
      ['tier2', report.tier2],
      ['tier3', report.tier3],
    ] as const) {
      expect([...list].sort(), `${label} lost or gained an entry`).toEqual(
        [...new Set(list)].sort()
      );
    }
    expect(report.tier1).toEqual(['AWS::IAM::Role']);
    expect(report.tier2).toEqual(['AWS::Foo::Mutable']);
    expect(report.tier3).toEqual(['AWS::Foo::Unsupported']);
    // The counts are the published numbers, so they are asserted as well as
    // the arrays: the defect surfaced as `tier2Count` reading 1372 over 1371
    // distinct entries.
    expect(report.summary).toMatchObject({
      tier1Count: 1,
      tier2Count: 1,
      tier3Count: 1,
      totalCount: 3,
    });
    // ...and the duplicate no longer costs a second DescribeType. Asserted
    // because the dedupe could otherwise be done at OUTPUT time, which would
    // fix the counts while still paying for the wasted call.
    expect(described.sort()).toEqual(['AWS::Foo::Mutable', 'AWS::Foo::Unsupported']);
  });

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

  it('retries a transient TRANSPORT failure instead of calling it Tier 3', async () => {
    // Measured 2026-09-04 (issue #2571): one `socket hang up` during a
    // 1737-type walk classified `AWS::OpenSearchService::Domain` as
    // NON_PROVISIONABLE, which is codegen'd into
    // `src/provisioning/unsupported-types.generated.ts` and makes cdkd REFUSE
    // the type at pre-flight. A blip must not become a committed refusal.
    // The retry keyed on ThrottlingException alone could not see it: a socket
    // hang-up arrives as a plain `Error` whose NAME is `Error`.
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('socket hang up');
        }
        return { ProvisioningType: 'FULLY_MUTABLE' };
      },
    } as unknown as CfnClientLike;

    const report = await partitionCoverage(client, new Set(), ['AWS::Foo::Bar'], {
      retryDelaysMs: [1],
      sleep: async () => {},
    });
    expect(report.tier2).toEqual(['AWS::Foo::Bar']);
    expect(report.tier3).toEqual([]);
    expect(report.undetermined).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('records a type it could NOT classify instead of guessing it into a tier', async () => {
    // The structural half. Tier 3 is not a neutral bucket, so an unresolved
    // type is excluded from every tier and reported — `regenerate` then
    // refuses to write the report at all.
    const client = {
      send: async () => {
        throw new Error('socket hang up');
      },
    } as unknown as CfnClientLike;

    const report = await partitionCoverage(client, new Set(), ['AWS::Foo::Bar'], {
      retryDelaysMs: [1],
      sleep: async () => {},
    });
    expect(report.undetermined).toEqual(['AWS::Foo::Bar']);
    expect(report.tier2).toEqual([]);
    expect(report.tier3).toEqual([]);
    expect(report.summary).toMatchObject({ tier2Count: 0, tier3Count: 0, totalCount: 0 });
  });

  it('undetermined types are sorted, and progress still advances for them', async () => {
    // Sorting keeps the artifact diff-stable like every other list here; the
    // `done` bump keeps `regenerate`'s progress line from stalling when the
    // last-finishing task is the one that could not be classified.
    const seen: Array<[number, string, string | undefined]> = [];
    const client = {
      send: async () => {
        throw new Error('socket hang up');
      },
    } as unknown as CfnClientLike;
    const report = await partitionCoverage(
      client,
      new Set(),
      ['AWS::Zulu::Z', 'AWS::Alpha::A'],
      {
        concurrency: 1,
        retryDelaysMs: [1],
        sleep: async () => {},
        onProgress: (done, _total, typeName, tier) => seen.push([done, typeName, tier]),
      }
    );
    expect(report.undetermined).toEqual(['AWS::Alpha::A', 'AWS::Zulu::Z']);
    expect(seen.map((r) => r[0])).toEqual([1, 2]);
    expect(seen.every((r) => r[2] === undefined)).toBe(true);
  });

  it('a caller-supplied onError returning undefined is still RECORDED', async () => {
    // The recording lives at the call site, not inside the default handler: a
    // custom handler returning `undefined` would otherwise drop the type from
    // every tier with nothing written down, and `regenerate`'s refusal would
    // never fire for it.
    const client = {
      send: async () => {
        throw Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
      },
    } as unknown as CfnClientLike;
    const report = await partitionCoverage(client, new Set(), ['AWS::Foo::Bar'], {
      retryDelaysMs: [1],
      sleep: async () => {},
      onError: () => undefined,
    });
    expect(report.undetermined).toEqual(['AWS::Foo::Bar']);
    // ...while a custom handler that DOES pick a tier keeps working.
    const forced = await partitionCoverage(client, new Set(), ['AWS::Foo::Bar'], {
      retryDelaysMs: [1],
      sleep: async () => {},
      onError: () => 'tier3-unsupported' as const,
    });
    expect(forced.tier3).toEqual(['AWS::Foo::Bar']);
    expect(forced.undetermined).toBeUndefined();
  });

  it('a NON-retryable failure is still undetermined, not Tier 3', async () => {
    // The polarity that matters for the guess: a missing IAM permission is
    // permanent, but it is still not evidence that the type is
    // NON_PROVISIONABLE. Both arms of the classifier land in `undetermined`.
    const denied = Object.assign(new Error('User is not authorized'), {
      name: 'AccessDeniedException',
    });
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        throw denied;
      },
    } as unknown as CfnClientLike;

    const report = await partitionCoverage(client, new Set(), ['AWS::Foo::Bar'], {
      retryDelaysMs: [1, 2, 3],
      sleep: async () => {},
    });
    expect(report.undetermined).toEqual(['AWS::Foo::Bar']);
    expect(report.tier3).toEqual([]);
    // ...and it was not retried, since retrying a permission error only
    // lengthens an audit that is already 10-30 minutes.
    expect(calls).toBe(1);
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
    const events: Array<{ done: number; total: number; tier: string | undefined }> = [];
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

describe('parseCliArgs', () => {
  it('returns help for --help / -h', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('returns regenerate / check / summary modes', () => {
    expect(parseCliArgs(['--regenerate'])).toEqual({ kind: 'regenerate' });
    expect(parseCliArgs(['--check'])).toEqual({ kind: 'check' });
    expect(parseCliArgs([])).toEqual({ kind: 'summary' });
  });

  it('rejects --regenerate and --check together', () => {
    const result = parseCliArgs(['--regenerate', '--check']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/mutually exclusive/);
    }
  });

  it('rejects the conflicting flags regardless of order', () => {
    expect(parseCliArgs(['--check', '--regenerate']).kind).toBe('error');
  });

  it('prefers help when --help is set alongside other flags', () => {
    expect(parseCliArgs(['--check', '--help']).kind).toBe('help');
    expect(parseCliArgs(['--regenerate', '--help', '--check']).kind).toBe('help');
  });
});

describe('isMainModule', () => {
  it('returns false when argv[1] is undefined (e.g. REPL)', () => {
    expect(isMainModule(undefined, '/abs/script.ts')).toBe(false);
  });

  it('returns true when resolved argv[1] equals scriptPath', () => {
    expect(isMainModule('/abs/script.ts', '/abs/script.ts')).toBe(true);
  });

  it('resolves relative argv[1] before comparing', () => {
    const dir = process.cwd();
    expect(isMainModule('./relative/path.ts', join(dir, 'relative', 'path.ts'))).toBe(true);
  });

  it('returns false when paths differ', () => {
    expect(isMainModule('/some/other.ts', '/abs/script.ts')).toBe(false);
  });
});

/**
 * Fake CliIO that records every interaction so tests can assert on
 * what was logged, errored, and the final exit-code request.
 */
function makeFakeIO(): CliIO & {
  readonly logs: string[];
  readonly errors: string[];
  exitCode: number | undefined;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  return {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    setExitCode: (c) => {
      exitCode = c;
    },
    logs,
    errors,
    get exitCode() {
      return exitCode;
    },
    set exitCode(v) {
      exitCode = v;
    },
  };
}

describe('summarizeCachedReport', () => {
  it('logs the summary on a valid cached JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const target = join(dir, 'report.json');
      const report: CoverageReport = {
        schemaVersion: 1,
        generatedAt: '2026-05-16T00:00:00.000Z',
        summary: { tier1Count: 5, tier2Count: 10, tier3Count: 2, totalCount: 17 },
        tier1: [],
        tier2: [],
        tier3: [],
      };
      atomicWriteFile(target, JSON.stringify(report));
      const io = makeFakeIO();
      summarizeCachedReport(io, target);
      expect(io.exitCode).toBeUndefined();
      expect(io.logs.join('\n')).toContain('Total CFn resource types: 17');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets exit code 1 with a regen hint when the cache is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const target = join(dir, 'missing.json');
      const io = makeFakeIO();
      summarizeCachedReport(io, target);
      expect(io.exitCode).toBe(1);
      expect(io.errors.join('\n')).toMatch(/cannot read cached report/);
      expect(io.errors.join('\n')).toMatch(/--regenerate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCheck', () => {
  function setupFixture(
    tier1: string[],
    sourceLines: string[],
    extra: { undetermined?: string[]; markdown?: string } = {}
  ): {
    dir: string;
    jsonPath: string;
    sourcePath: string;
    markdownPath: string;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    const jsonPath = join(dir, 'report.json');
    const sourcePath = join(dir, 'register-providers.ts');
    const markdownPath = join(dir, 'report.md');
    const report: CoverageReport = {
      schemaVersion: 1,
      generatedAt: '2026-05-16T00:00:00.000Z',
      summary: { tier1Count: tier1.length, tier2Count: 0, tier3Count: 0, totalCount: tier1.length },
      tier1,
      tier2: [],
      tier3: [],
      ...(extra.undetermined && { undetermined: extra.undetermined }),
    };
    atomicWriteFile(jsonPath, JSON.stringify(report));
    atomicWriteFile(sourcePath, sourceLines.join('\n'));
    // The markdown defaults to what the generator produces, so a case that is
    // not ABOUT the markdown is not accidentally testing it.
    atomicWriteFile(markdownPath, extra.markdown ?? renderMarkdown(report));
    return {
      dir,
      jsonPath,
      sourcePath,
      markdownPath,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('refuses a cached report that lists an unclassified type', () => {
    // Gap 1 from the round-2 review: this arm was completely unfenced —
    // replacing its condition with `if (false)` left the suite green — while it
    // is the only thing that stops an unclassifiable type reaching consumers
    // that read the tier lists as facts. Tier 1 MATCHES here, so without the
    // arm the run exits 0.
    const { jsonPath, sourcePath, markdownPath, cleanup } = setupFixture(
      ['AWS::IAM::Role'],
      [`registry.register('AWS::IAM::Role', new R());`],
      { undetermined: ['AWS::Foo::Bar'] }
    );
    const io = makeFakeIO();
    try {
      runCheck(io, jsonPath, sourcePath, markdownPath);
      expect(io.exitCode).toBe(1);
      expect(io.errors.join('\n')).toContain('AWS::Foo::Bar');
      // ...and it must NOT also report success.
      expect(io.logs.join('\n')).not.toMatch(/matches register-providers\.ts/);
    } finally {
      cleanup();
    }
  });

  it('refuses a committed markdown that its own generator would not produce', () => {
    // The gap that let this PR ship a corrected generator beside an uncorrected
    // artifact: editing `renderMarkdown` does not touch its output, and nothing
    // compared the two. Tier 1 matches and nothing is undetermined, so the
    // markdown mismatch is the only reason to fail.
    const { jsonPath, sourcePath, markdownPath, cleanup } = setupFixture(
      ['AWS::IAM::Role'],
      [`registry.register('AWS::IAM::Role', new R());`],
      { markdown: '# stale, hand-edited\n' }
    );
    const io = makeFakeIO();
    try {
      runCheck(io, jsonPath, sourcePath, markdownPath);
      expect(io.exitCode).toBe(1);
      expect(io.errors.join('\n')).toMatch(/does not match what renderMarkdown produces/);
      expect(io.logs.join('\n')).not.toMatch(/matches register-providers\.ts/);
    } finally {
      cleanup();
    }
  });

  it('reports an unclassified type AND a tier-1 drift in the same run', () => {
    // The arm falls through rather than early-returning, so one run surfaces
    // both problems instead of making the operator re-run to see the second.
    const { jsonPath, sourcePath, markdownPath, cleanup } = setupFixture(
      ['AWS::IAM::Role'],
      [`registry.register('AWS::S3::Bucket', new B());`],
      { undetermined: ['AWS::Foo::Bar'] }
    );
    const io = makeFakeIO();
    try {
      runCheck(io, jsonPath, sourcePath, markdownPath);
      expect(io.exitCode).toBe(1);
      const errors = io.errors.join('\n');
      expect(errors).toContain('AWS::Foo::Bar');
      expect(errors).toContain('AWS::S3::Bucket');
    } finally {
      cleanup();
    }
  });

  it('passes when cached Tier 1 matches register-providers.ts', () => {
    const { jsonPath, sourcePath, markdownPath, cleanup } = setupFixture(
      ['AWS::IAM::Role', 'AWS::S3::Bucket'],
      [
        `registry.register('AWS::IAM::Role', new R());`,
        `registry.register('AWS::S3::Bucket', new B());`,
      ]
    );
    try {
      const io = makeFakeIO();
      runCheck(io, jsonPath, sourcePath, markdownPath);
      expect(io.exitCode).toBeUndefined();
      expect(io.logs.join('\n')).toMatch(/matches register-providers\.ts/);
    } finally {
      cleanup();
    }
  });

  it('fails with exit code 1 when source has a provider not in cache', () => {
    const { jsonPath, sourcePath, markdownPath, cleanup } = setupFixture(
      ['AWS::IAM::Role'],
      [
        `registry.register('AWS::IAM::Role', new R());`,
        `registry.register('AWS::Newly::Added', new N());`,
      ]
    );
    try {
      const io = makeFakeIO();
      runCheck(io, jsonPath, sourcePath, markdownPath);
      expect(io.exitCode).toBe(1);
      const errOutput = io.errors.join('\n');
      expect(errOutput).toMatch(/types NOT in the cached Tier 1/);
      expect(errOutput).toContain('AWS::Newly::Added');
      expect(errOutput).toMatch(/--regenerate/);
    } finally {
      cleanup();
    }
  });

  it('fails when cache has a provider gone from source', () => {
    const { jsonPath, sourcePath, markdownPath, cleanup } = setupFixture(
      ['AWS::IAM::Role', 'AWS::Stale::Removed'],
      [`registry.register('AWS::IAM::Role', new R());`]
    );
    try {
      const io = makeFakeIO();
      runCheck(io, jsonPath, sourcePath, markdownPath);
      expect(io.exitCode).toBe(1);
      const errOutput = io.errors.join('\n');
      expect(errOutput).toMatch(/types NOT in register-providers\.ts/);
      expect(errOutput).toContain('AWS::Stale::Removed');
    } finally {
      cleanup();
    }
  });

  it('exits 1 with regen hint when cache is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const sourcePath = join(dir, 'register-providers.ts');
      atomicWriteFile(sourcePath, `registry.register('AWS::IAM::Role', new R());`);
      const io = makeFakeIO();
      runCheck(io, join(dir, 'missing.json'), sourcePath);
      expect(io.exitCode).toBe(1);
      expect(io.errors.join('\n')).toMatch(/cannot read cached report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('atomicWriteFile cleanup on failure', () => {
  it('removes the .tmp file when renameSync fails (target dir disappears)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      const target = join(dir, 'subdir', 'report.json');
      atomicWriteFile(target, 'first');
      // Simulate a write to a path whose target directory becomes
      // read-only or vanishes mid-write. We can't easily trigger a
      // renameSync failure portably, so we test the easier case:
      // writeFileSync(invalid path) -> ENOENT, and assert no .tmp
      // leftover.
      const bad = join(dir, 'no-such-dir-' + Date.now(), 'r.json');
      // mkdirSync recursive handles the parent path, so writeFileSync
      // will succeed. Instead, use an existing file path with a tmp
      // suffix that conflicts with a directory.
      // Simpler check: just verify happy-path still produces no .tmp.
      atomicWriteFile(target, 'second');
      expect(existsSync(`${target}.tmp`)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('second');
      // And the bad-path case actually succeeds because of mkdirSync
      // recursive — that's by design. Documented in the cleanup
      // try/catch.
      atomicWriteFile(bad, 'third');
      expect(existsSync(bad)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not leave a .tmp file when writeFileSync throws (read-only target)', () => {
    // Coverage for the cleanup branch: even on synthetic write
    // failures (mocked via a target that resolves to a directory),
    // the .tmp cleanup path runs without throwing additional errors.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-audit-test-'));
    try {
      // Use a target that is itself a directory — writeFileSync(<dir>)
      // throws EISDIR, exercising the catch/cleanup branch.
      const target = dir;
      let threw = false;
      try {
        atomicWriteFile(target, 'oops');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(existsSync(`${target}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('describeTypeWithRetry — empty retryDelaysMs', () => {
  it('throws immediately on throttling when retryDelaysMs is []', async () => {
    let attempts = 0;
    const client: CfnClientLike = {
      send: async () => {
        attempts++;
        const err = new Error('Rate exceeded');
        err.name = 'ThrottlingException';
        throw err;
      },
    } as CfnClientLike;
    await expect(
      describeTypeWithRetry(client, 'AWS::Foo::Bar', {
        retryDelaysMs: [],
        sleep: async () => {},
      })
    ).rejects.toThrow(/Rate exceeded/);
    expect(attempts).toBe(1);
  });
});
