import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DRIFT_READBACK_BASELINE,
  ModuleIndex,
  buildReport,
  classifyFile,
  findGaps,
  findStaleBaselineEntries,
  findUnresolved,
  helperFamilies,
  loadReport,
  type BaselineEntry,
  type SchemaFacts,
  type SourceHost,
  type TypeRow,
} from '../../../scripts/gen-drift-readback-coverage.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

const ROOT = '/virtual/src/provisioning/providers';
const PROVIDER = `${ROOT}/fake-provider.ts`;

function memoryHost(files: Record<string, string>): SourceHost {
  return { read: (file) => files[file] ?? null };
}

function schemaOf(properties: string[], readOnly: string[] = []): SchemaFacts {
  return { properties: new Set([...properties, ...readOnly]), readOnly: new Set(readOnly) };
}

/** Classify one in-memory provider whose `handledProperties` is `handled` for every type. */
function classify(opts: {
  classBody: string;
  handled: string[];
  types?: string[];
  prelude?: string;
  extraFiles?: Record<string, string>;
  companions?: string[];
  readOnly?: string[];
  /** The schema's properties, when not exactly `handled`. */
  schemaProps?: string[];
  baseline?: ReadonlyMap<string, BaselineEntry>;
  /** Other provider facades among `extraFiles`, for the helper-family scan. */
  peerProviders?: string[];
}): TypeRow[] {
  const types = opts.types ?? ['AWS::Fake::Thing'];
  const handledDecl = types
    .map((t) => `['${t}', new Set([${opts.handled.map((p) => `'${p}'`).join(', ')}])]`)
    .join(', ');
  const source = `${opts.prelude ?? ''}
export class FakeProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([${handledDecl}]);
  ${opts.classBody}
}
`;
  const host = memoryHost({ [PROVIDER]: source, ...(opts.extraFiles ?? {}) });
  const index = new ModuleIndex(host);
  const companions = opts.companions ?? [];
  return classifyFile({
    file: PROVIDER,
    companions,
    index,
    helperFamilies: helperFamilies(
      [PROVIDER, ...(opts.peerProviders ?? [])],
      (f) => (f === PROVIDER ? companions : []),
      index
    ),
    schema: () => schemaOf(opts.schemaProps ?? opts.handled, opts.readOnly),
    baseline: opts.baseline ?? new Map(),
  });
}

const statusOf = (rows: TypeRow[], prop: string, type = 'AWS::Fake::Thing'): string | undefined =>
  rows.find((r) => r.resourceType === type)?.properties.find((p) => p.property === prop)?.status;

describe('gen-drift-readback-coverage: what counts as a returned name', () => {
  it('an object key, a shorthand, an assignment and a key table count; an unnamed property is a gap', () => {
    const rows = classify({
      handled: ['A', 'B', 'C', 'D', 'E', 'F'],
      classBody: `
        async readCurrentState(id) {
          const resp = await this.client.send(new GetThingCommand({ Id: id }));
          const B = resp.b;
          const out = { A: resp.a, B };
          out.C = resp.c;
          out['D'] = resp.d;
          for (const k of ['E']) out[k] = resp[k];
          return out;
        }`,
    });
    expect(['A', 'B', 'C', 'D', 'E'].map((p) => statusOf(rows, p))).toEqual([
      'read',
      'read',
      'read',
      'read',
      'read',
    ]);
    expect(statusOf(rows, 'F')).toBe('gap');
  });

  it('a request key and an element READ name what is asked of AWS, not what is returned', () => {
    const rows = classify({
      handled: ['A', 'B', 'C'],
      classBody: `
        async readCurrentState(id) {
          const resp = await this.client.send(new GetThingCommand({ A: id, Nested: { C: 1 } }));
          return { Other: resp['B'] };
        }`,
    });
    expect(statusOf(rows, 'A')).toBe('gap');
    expect(statusOf(rows, 'B')).toBe('gap');
    expect(statusOf(rows, 'C')).toBe('gap');
  });

  it('a string a warn / settle / record call takes, or one compared, does not count', () => {
    const rows = classify({
      handled: ['A', 'B', 'C', 'D', 'E'],
      classBody: `
        async readCurrentState(id) {
          this.logger.warn('A');
          warnUnsettledMember(this.logger, id, 'AWS::Fake::Thing', 'B');
          recordOwnWrite('C');
          if (id === 'D') return {};
          return { E: 1 };
        }`,
    });
    expect(['A', 'B', 'C', 'D'].map((p) => statusOf(rows, p))).toEqual(['gap', 'gap', 'gap', 'gap']);
    expect(statusOf(rows, 'E')).toBe('read');
  });

  it('a handled property outside the schema capture is classified and marked', () => {
    const rows = classify({
      handled: ['A', 'B'],
      schemaProps: ['A'],
      classBody: `async readCurrentState() { return { A: 1 }; }`,
    });
    expect(rows[0]!.properties.find((p) => p.property === 'B')).toEqual({
      property: 'B',
      status: 'gap',
      outsideSchema: true,
    });
  });

  it('a name in a type position does not count', () => {
    const rows = classify({
      handled: ['A'],
      classBody: `
        async readCurrentState(id): Promise<{ A: string }> {
          const x: 'A' = 'B' as 'A';
          return {};
        }`,
    });
    expect(statusOf(rows, 'A')).toBe('gap');
  });

  it('only properties the schema leaves writable are classified', () => {
    const rows = classify({
      handled: ['A'],
      readOnly: ['Arn'],
      classBody: `async readCurrentState() { return {}; }`,
    });
    expect(rows[0]!.properties.map((p) => p.property)).toEqual(['A']);
  });
});

describe('gen-drift-readback-coverage: what is walked', () => {
  it('follows this.x() members, module functions, imports and this: companions', () => {
    const helper = `${ROOT}/fake/helper.ts`;
    const companion = `${ROOT}/fake/read.ts`;
    const rows = classify({
      handled: ['A', 'B', 'C', 'D', 'E'],
      prelude: `import { fromImport } from './fake/helper.js';
function local(out) { out.B = 1; }`,
      extraFiles: {
        [helper]: `export function fromImport(out) { out.C = 1; }`,
        [companion]: `export function viaCompanion(this: FakeProvider, out) { out.D = 1; }`,
      },
      // Every file under the companion directory is the provider's own.
      companions: [companion, helper],
      classBody: `
        async readCurrentState() {
          const out = {};
          this.member(out);
          local(out);
          fromImport(out);
          this.viaCompanion(out);
          return out;
        }
        member(out) { out.A = 1; }
        unrelated(out) { out.E = 1; }`,
    });
    expect(['A', 'B', 'C', 'D'].map((p) => statusOf(rows, p))).toEqual(['read', 'read', 'read', 'read']);
    // A member the readback never calls is not walked.
    expect(statusOf(rows, 'E')).toBe('gap');
  });

  it("a shared module outside the providers directory, or another provider's facade, is followed but credits nothing", () => {
    const shared = '/virtual/src/provisioning/settle-members.ts';
    const other = `${ROOT}/other-provider.ts`;
    const sibling = `${ROOT}/fake-shared.ts`;
    const rows = classify({
      handled: ['A', 'B', 'C', 'D'],
      prelude: `import { settle } from '../settle-members.js';
import { otherFields } from './other-provider.js';
import { readShared } from './fake-shared.js';`,
      extraFiles: {
        [shared]: `export function settle(out) { out.A = 1; const t = { B: 2 }; return deeper(t); }
function deeper(t) { return t; }`,
        [other]: `export function otherFields() { return { C: 1 }; }`,
        [sibling]: `export function readShared(out) { out.D = 1; }`,
      },
      classBody: `
        async readCurrentState() {
          const out = {};
          settle(out);
          otherFields();
          readShared(out);
          return out;
        }`,
    });
    expect(['A', 'B', 'C'].map((p) => statusOf(rows, p))).toEqual(['gap', 'gap', 'gap']);
    // A helper beside the providers that only this family imports
    // (`docdb-shared.ts`) is the provider's own.
    expect(statusOf(rows, 'D')).toBe('read');
  });

  it('a providers/ helper two provider families import credits neither; one family sharing it keeps it', () => {
    const helper = `${ROOT}/shared-roles.ts`;
    const run = (peer: string): TypeRow[] =>
      classify({
        handled: ['A'],
        prelude: `import { readRoles } from './shared-roles.js';`,
        extraFiles: {
          [helper]: `export function readRoles(out) { out.A = 1; }`,
          [peer]: `import { readRoles } from './shared-roles.js';\nexport class Peer {}`,
        },
        peerProviders: [peer],
        classBody: `async readCurrentState() { const out = {}; readRoles(out); return out; }`,
      });
    // `other` is another family: the helper names properties for both, so it credits nothing.
    expect(statusOf(run(`${ROOT}/other-provider.ts`), 'A')).toBe('gap');
    // `fake-extra` is the same family as `fake`.
    expect(statusOf(run(`${ROOT}/fake-extra-provider.ts`), 'A')).toBe('read');
  });

  it('a readCurrentState installed from a companion file (a mixin) is found', () => {
    const companion = `${ROOT}/fake/drift.ts`;
    const rows = classify({
      handled: ['A'],
      extraFiles: {
        [companion]: `export async function readCurrentState(this: FakeProvider) { return { A: 1 }; }`,
      },
      companions: [companion],
      classBody: ``,
    });
    expect(rows[0]!.hasReadback).toBe(true);
    expect(statusOf(rows, 'A')).toBe('read');
  });

  it('narrows a multi-type class through switch and if on resourceType', () => {
    const rows = classify({
      types: ['AWS::Fake::One', 'AWS::Fake::Two'],
      handled: ['A', 'B'],
      classBody: `
        async readCurrentState(id, logicalId, resourceType) {
          switch (resourceType) {
            case 'AWS::Fake::One':
              return { A: 1 };
            default:
              break;
          }
          if (resourceType === 'AWS::Fake::Two') return { B: 1 };
          return undefined;
        }`,
    });
    expect(statusOf(rows, 'A', 'AWS::Fake::One')).toBe('read');
    expect(statusOf(rows, 'B', 'AWS::Fake::One')).toBe('gap');
    expect(statusOf(rows, 'A', 'AWS::Fake::Two')).toBe('gap');
    expect(statusOf(rows, 'B', 'AWS::Fake::Two')).toBe('read');
  });

  it('code after an early return for one type is not walked for that type', () => {
    const rows = classify({
      types: ['AWS::Fake::One', 'AWS::Fake::Two'],
      handled: ['A', 'B'],
      classBody: `
        async readCurrentState(id, logicalId, resourceType) {
          if (resourceType === 'AWS::Fake::One') return this.readOne();
          return this.readTwo();
        }
        readOne() { return { A: 1 }; }
        readTwo() { return { B: 1 }; }
        getDriftUnknownPaths(resourceType) {
          if (resourceType !== 'AWS::Fake::Two') return [];
          return ['A'];
        }`,
    });
    expect(statusOf(rows, 'A', 'AWS::Fake::One')).toBe('read');
    expect(statusOf(rows, 'B', 'AWS::Fake::One')).toBe('gap');
    expect(statusOf(rows, 'A', 'AWS::Fake::Two')).toBe('unknown');
    expect(statusOf(rows, 'B', 'AWS::Fake::Two')).toBe('read');
  });

  it('an if whose taken arm is the else and ends the clause stops the walk too', () => {
    const rows = classify({
      types: ['AWS::Fake::One', 'AWS::Fake::Two'],
      handled: ['A', 'B', 'C'],
      classBody: `
        async readCurrentState(id, logicalId, resourceType) {
          if (resourceType !== 'AWS::Fake::One') {
            return { B: 1 };
          } else {
            return { A: 1 };
          }
          return { C: 1 };
        }`,
    });
    expect(statusOf(rows, 'A', 'AWS::Fake::One')).toBe('read');
    expect(statusOf(rows, 'B', 'AWS::Fake::Two')).toBe('read');
    expect(statusOf(rows, 'C', 'AWS::Fake::One')).toBe('gap');
    expect(statusOf(rows, 'C', 'AWS::Fake::Two')).toBe('gap');
  });

  it('a whole-property getDriftUnknownPaths entry is unknown; a nested one is not', () => {
    const rows = classify({
      handled: ['A', 'B'],
      classBody: `
        async readCurrentState() { return {}; }
        getDriftUnknownPaths() { return ['A', 'B.Inner']; }`,
    });
    expect(statusOf(rows, 'A')).toBe('unknown');
    expect(statusOf(rows, 'B')).toBe('gap');
  });

  it('a provider without readCurrentState is no-readback, with nothing classified', () => {
    const rows = classify({ handled: ['A'], classBody: `async create() {}` });
    expect(rows[0]!.hasReadback).toBe(false);
    expect(rows[0]!.properties).toEqual([]);
    expect(buildReport(rows).summary.noReadback).toBe(1);
  });

  it('an unresolvable this.x() call blocks', () => {
    const rows = classify({
      handled: ['A'],
      classBody: `async readCurrentState() { return this.missing(); }`,
    });
    expect(findUnresolved(buildReport(rows))).toEqual(['FakeProvider (AWS::Fake::Thing): this.missing()']);
  });
});

describe('gen-drift-readback-coverage: the baseline', () => {
  it('a baseline entry turns its gap into baseline; a gap without one blocks', () => {
    const baseline = new Map([['AWS::Fake::Thing#A', { issue: 1, reason: 'tracked' }]]);
    const rows = classify({
      handled: ['A', 'B'],
      classBody: `async readCurrentState() { return {}; }`,
      baseline,
    });
    const report = buildReport(rows);
    expect(statusOf(rows, 'A')).toBe('baseline');
    expect(findGaps(report)).toEqual(['AWS::Fake::Thing#B']);
    expect(findStaleBaselineEntries(report, baseline)).toEqual([]);
  });

  it('an entry whose property is now read back is stale', () => {
    const baseline = new Map([['AWS::Fake::Thing#A', { issue: 1, reason: 'tracked' }]]);
    const rows = classify({
      handled: ['A'],
      classBody: `async readCurrentState() { return { A: 1 }; }`,
      baseline,
    });
    expect(findStaleBaselineEntries(buildReport(rows), baseline)).toEqual(['AWS::Fake::Thing#A']);
  });
});

describe('gen-drift-readback-coverage: the real tree', () => {
  const REPO = resolve(__dirname, '../../..');
  const diskHost: SourceHost = {
    read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
  };

  it(
    'classifies the providers with zero gaps, zero unresolved calls and no stale baseline entry',
    { timeout: CONTENDED_CASE_TIMEOUT_MS },
    () => {
      const report = loadReport(diskHost);
      // Floors, so "found nothing" cannot pass as "found no gap".
      expect(report.summary.types).toBeGreaterThanOrEqual(100);
      expect(report.summary.read).toBeGreaterThanOrEqual(1000);
      expect(findGaps(report)).toEqual([]);
      expect(findUnresolved(report)).toEqual([]);
      expect(findStaleBaselineEntries(report, DRIFT_READBACK_BASELINE)).toEqual([]);
    }
  );

  // The checker sees its input: drop one property from a real readback and
  // it goes red for exactly that property.
  it(
    'a property removed from a real readback becomes a gap',
    { timeout: CONTENDED_CASE_TIMEOUT_MS },
    () => {
      const sqs = resolve(REPO, 'src/provisioning/providers/sqs-queue-provider.ts');
      const needle = "result['KmsMasterKeyId'] = ";
      const original = readFileSync(sqs, 'utf8');
      expect(original.split(needle).length - 1).toBe(1);
      const host: SourceHost = {
        read: (file) =>
          file === sqs ? original.replace(needle, "result['Unrelated'] = ") : diskHost.read(file),
      };
      expect(findGaps(loadReport(host))).toEqual(['AWS::SQS::Queue#KmsMasterKeyId']);
    }
  );
});
