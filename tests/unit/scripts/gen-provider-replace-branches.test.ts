import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BRANCH_DISPOSITIONS,
  NOT_A_TRIGGER,
  OUT_JSON,
  OUT_MD,
  buildReport,
  classifyFile,
  diffVerdict,
  findDispositionConflicts,
  findGaps,
  findStaleEntries,
  findUnderived,
  loadReport,
  parseProviderMarks,
  renderMarkdown,
  serializeReport,
  type BranchDisposition,
  type SiteRow,
  type TriggerExemption,
} from '../../../scripts/gen-provider-replace-branches.ts';
import {
  ModuleIndex,
  type RuleSets,
  type SchemaFacts,
  type SourceHost,
} from '../../../scripts/gen-update-path-coverage.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

const ROOT = '/virtual/src/provisioning/providers';
const PROVIDER = `${ROOT}/fake-provider.ts`;
const TYPE = 'AWS::Fake::Thing';

const memoryHost = (files: Record<string, string>): SourceHost => ({ read: (f) => files[f] ?? null });

const rulesOf = (r: Partial<Record<keyof RuleSets, string[]>>): Map<string, RuleSets> =>
  new Map([
    [
      TYPE,
      {
        replacement: new Set(r.replacement ?? []),
        updateable: new Set(r.updateable ?? []),
        conditional: new Set(r.conditional ?? []),
      },
    ],
  ]);

function classify(opts: {
  classBody: string;
  handled?: string[];
  types?: string[];
  prelude?: string;
  extraFiles?: Record<string, string>;
  companions?: string[];
  rules?: Map<string, RuleSets>;
  createOnly?: string[];
  providerMarks?: Map<string, Set<string>>;
  dispositions?: Map<string, BranchDisposition>;
  notATrigger?: Map<string, TriggerExemption>;
}): { sites: SiteRow[]; unresolved: string[] } {
  const handled = opts.handled ?? ['A', 'B', 'C', 'D'];
  const types = opts.types ?? [TYPE];
  const decl = types.map((t) => `['${t}', new Set([${handled.map((p) => `'${p}'`).join(', ')}])]`).join(', ');
  const source = `${opts.prelude ?? ''}
export class FakeProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([${decl}]);
  ${opts.classBody}
}
`;
  const schema: SchemaFacts = {
    properties: new Set(handled),
    readOnly: new Set(),
    createOnly: new Set(opts.createOnly ?? []),
  };
  return classifyFile({
    file: PROVIDER,
    companions: opts.companions ?? [],
    index: new ModuleIndex(memoryHost({ [PROVIDER]: source, ...(opts.extraFiles ?? {}) })),
    rules: opts.rules ?? new Map(),
    ...(opts.providerMarks && { providerMarks: opts.providerMarks }),
    schema: () => schema,
    dispositions: opts.dispositions ?? new Map(),
    notATrigger: opts.notATrigger ?? new Map(),
  });
}

const triggersOf = (site: SiteRow | undefined): Record<string, string> =>
  Object.fromEntries((site?.triggers ?? []).map((t) => [t.property, t.verdict]));

const CREATE = `async create(id, type, properties) { return { physicalId: 'x' }; }`;

describe('gen-provider-replace-branches: what a replace site is (issue #6656)', () => {
  it('finds a wasReplaced answer and an own-create call, and derives the guard of each', () => {
    const { sites } = classify({
      classBody: `
        ${CREATE}
        async update(id, pid, type, properties, previous) {
          if (properties['A'] !== previous['A']) {
            const r = await this.create(id, type, properties);
            return { physicalId: r.physicalId, wasReplaced: true };
          }
          return { physicalId: pid, wasReplaced: false };
        }`,
    });
    expect(sites.map((s) => s.signal).sort()).toEqual(['own-create', 'was-replaced']);
    for (const s of sites) expect(triggersOf(s)).toEqual({ A: 'gap' });
  });

  it('a literal `wasReplaced: false` is no site; a computed one is, and guards it', () => {
    const { sites } = classify({
      classBody: `
        ${CREATE}
        async update(id, pid, type, properties, previous) {
          const moved = properties.B !== previous.B;
          return { physicalId: pid, wasReplaced: moved };
        }
        async other() { return { wasReplaced: false }; }`,
    });
    expect(sites).toHaveLength(1);
    expect(triggersOf(sites[0])).toEqual({ B: 'gap' });
  });

  it('follows create() to the member it returns the result of, through a companion', () => {
    const companion = `${ROOT}/fake/create.ts`;
    const { sites } = classify({
      prelude: `import { createThing } from './fake/create.js';`,
      companions: [companion],
      extraFiles: {
        [companion]: `export async function createThing(this: FakeProvider, props) { return { physicalId: 'y' }; }
export async function update(this: FakeProvider, id, pid, type, properties, previous) {
  if (properties.C === previous.C) return { physicalId: pid };
  return this.createThing(properties);
}`,
      },
      classBody: `
        async create(id, type, properties) { return createThing.call(this, properties); }
        createThing(p) { return createThing.call(this, p); }
        async update(id, pid, type, properties, previous) { return update.call(this, id, pid, type, properties, previous); }`,
    });
    expect(sites.map((s) => `${s.function} ${s.signal}`)).toEqual(['update own-create']);
    // The early `return` is a guard of what follows it.
    expect(triggersOf(sites[0])).toEqual({ C: 'gap' });
  });

  it('a throw-only early exit is a refusal, never a trigger', () => {
    const { sites } = classify({
      classBody: `
        ${CREATE}
        async update(id, pid, type, properties, previous) {
          if (!Array.isArray(properties.D)) throw new Error('malformed');
          if (properties.A !== previous.A) return this.create(id, type, properties);
          return { physicalId: pid };
        }`,
    });
    expect(triggersOf(sites[0])).toEqual({ A: 'gap' });
  });

  it('grows a guard through a loop over a literal list, a destructured helper result and a module function', () => {
    const { sites } = classify({
      prelude: `
const IMMUTABLE = ['A', 'B'] as const;
function identityChanged(prev, next) { return prev['C'] !== next['C']; }`,
      classBody: `
        ${CREATE}
        async update(id, pid, type, properties, previous) {
          let changed;
          for (const k of IMMUTABLE) if (properties[k] !== previous[k]) changed = k;
          const { moved } = { moved: identityChanged(previous, properties) };
          if (changed || moved) return this.create(id, type, properties);
          return { physicalId: pid };
        }`,
    });
    expect(Object.keys(triggersOf(sites[0])).sort()).toEqual(['A', 'B', 'C']);
  });

  it('narrows a multi-type class per resource type', () => {
    const OTHER = 'AWS::Fake::Other';
    const { sites } = classify({
      types: [TYPE, OTHER],
      classBody: `
        ${CREATE}
        async update(id, pid, resourceType, properties, previous) {
          switch (resourceType) {
            case '${OTHER}':
              if (properties.A !== previous.A) return this.create(id, resourceType, properties);
              return { physicalId: pid };
            default:
              return { physicalId: pid };
          }
        }`,
    });
    expect(sites.map((s) => s.resourceType)).toEqual([OTHER]);
  });

  it('a guard reading a parameter reads what the callers passed for it', () => {
    const { sites } = classify({
      prelude: `function flag(v) { return v; }`,
      classBody: `
        ${CREATE}
        async replaceWhen(changed, id, type, properties) {
          if (changed && properties.D) return this.create(id, type, properties);
          return { physicalId: 'p' };
        }
        async update(id, pid, type, properties, previous) {
          const moved = properties.A !== previous.A;
          await this.replaceWhen(moved, id, type, properties);
          return { physicalId: pid, wasReplaced: properties.C ? flag(properties.B !== previous.B) : false };
        }`,
    });
    const bySignal = Object.fromEntries(sites.map((s) => [s.signal, Object.keys(triggersOf(s)).sort()]));
    expect(bySignal).toEqual({ 'own-create': ['A', 'D'], 'was-replaced': ['B', 'C'] });
  });

  it('reports a this.x() the walk cannot resolve', () => {
    const { unresolved } = classify({
      classBody: `${CREATE}
        async update(id, pid, type, properties) { return this.missing(properties); }`,
    });
    expect(unresolved).toEqual([`FakeProvider (${TYPE}): this.missing()`]);
  });
});

describe('gen-provider-replace-branches: classification against the diff', () => {
  const body = `
    ${CREATE}
    async update(id, pid, type, properties, previous) {
      if (properties.A !== previous.A || properties.B !== previous.B || properties.C !== previous.C || properties.D !== previous.D) {
        return this.create(id, type, properties);
      }
      return { physicalId: pid };
    }`;

  it('a rule, a create-only path, a predicate and a provider mark each make the change a replacement', () => {
    const { sites } = classify({
      classBody: body,
      rules: rulesOf({ replacement: ['A'], conditional: ['C'] }),
      createOnly: ['B'],
      providerMarks: new Map([[TYPE, new Set(['D'])]]),
    });
    expect(triggersOf(sites[0])).toEqual({
      A: 'replacement',
      B: 'replacement',
      C: 'conditional',
      D: 'provider-marked',
    });
    expect(findGaps(buildReport(sites))).toEqual([]);
  });

  it('an updateable rule over a create-only path is a gap (DiffCalculator order)', () => {
    expect(
      diffVerdict('A', rulesOf({ updateable: ['A'] }).get(TYPE), {
        properties: new Set(['A']),
        readOnly: new Set(),
        createOnly: new Set(['A']),
      }).verdict
    ).toBe('update');
    const { sites } = classify({ classBody: body, rules: rulesOf({ updateable: ['A'] }), createOnly: ['A'] });
    const report = buildReport(sites);
    expect(findGaps(report).map((g) => g.split(' ')[0]).sort()).toEqual(
      ['A', 'B', 'C', 'D'].map((p) => `${TYPE}#${p}`)
    );
  });

  it('an exemption settles an update verdict only; an unused one is stale', () => {
    const notATrigger = new Map<string, TriggerExemption>([
      [`${TYPE}#A`, { kind: 'not-a-trigger', at: `${PROVIDER}:update`, rationale: 'read only to exempt' }],
      [`${TYPE}#B`, { kind: 'cfn-update', at: `${PROVIDER}:update`, rationale: 'CloudFormation updates' }],
    ]);
    const { sites } = classify({ classBody: body, createOnly: ['B', 'C', 'D'], notATrigger });
    const report = buildReport(sites);
    expect(triggersOf(sites[0])).toMatchObject({ A: 'exempt', B: 'replacement' });
    expect(findGaps(report)).toEqual([]);
    expect(findStaleEntries(report, new Map(), notATrigger)).toEqual([`NOT_A_TRIGGER: ${TYPE}#B`]);
  });

  it('an exemption answers only for the function it names', () => {
    const notATrigger = new Map<string, TriggerExemption>([
      [`${TYPE}#A`, { kind: 'not-a-trigger', at: `${PROVIDER}:elsewhere`, rationale: 'r' }],
    ]);
    const { sites } = classify({ classBody: body, createOnly: ['B', 'C', 'D'], notATrigger });
    const report = buildReport(sites);
    expect(triggersOf(sites[0])).toMatchObject({ A: 'gap' });
    expect(findStaleEntries(report, new Map(), notATrigger)).toEqual([`NOT_A_TRIGGER: ${TYPE}#A`]);
  });

  it('a no-template-trigger disposition over a site whose guards read a property blocks', () => {
    const dispositions = new Map<string, BranchDisposition>([
      [`${TYPE} ${PROVIDER}:update own-create#1`, { kind: 'no-template-trigger', rationale: 'replay only' }],
    ]);
    const { sites } = classify({ classBody: body, createOnly: ['A', 'B', 'C', 'D'], dispositions });
    const report = buildReport(sites);
    expect(findGaps(report)).toEqual([]);
    expect(findDispositionConflicts(report)).toEqual([`${TYPE} ${PROVIDER}:update own-create#1`]);
  });

  it('a site with no derived trigger blocks until a disposition records it', () => {
    const unguarded = `${CREATE}
      async update(id, pid, type, properties) { return this.create(id, type, properties); }`;
    const blocked = classify({ classBody: unguarded });
    expect(findUnderived(buildReport(blocked.sites))).toEqual([
      `${TYPE} ${PROVIDER}:update own-create#1`,
    ]);
    const dispositions = new Map<string, BranchDisposition>([
      [`${TYPE} ${PROVIDER}:update own-create#1`, { kind: 'every-property', rationale: 'no update API' }],
    ]);
    const every = classify({ classBody: unguarded, dispositions, createOnly: ['A', 'B', 'C'] });
    const report = buildReport(every.sites);
    expect(findUnderived(report)).toEqual([]);
    expect(findGaps(report)).toEqual([`${TYPE}#D (${TYPE} ${PROVIDER}:update own-create#1)`]);
    expect(findStaleEntries(buildReport([]), dispositions, new Map())).toEqual([
      `BRANCH_DISPOSITIONS: ${TYPE} ${PROVIDER}:update own-create#1`,
    ]);
  });
});

describe('gen-provider-replace-branches: the provider-replacement mark table', () => {
  const SOURCE = readFileSync(
    resolve(import.meta.dirname, '../../../src/analyzer/diff-calculator/provider-replacement.ts'),
    'utf8'
  );

  it('reads every planner and its property list from the real source', () => {
    const marks = parseProviderMarks(SOURCE);
    expect(marks.get('AWS::Route53::RecordSet')).toEqual(new Set(['Name']));
    expect(marks.get('AWS::SNS::Subscription')?.size).toBeGreaterThanOrEqual(5);
  });

  it('refuses a table it cannot read', () => {
    expect(() =>
      parseProviderMarks(`const PROVIDER_REPLACEMENT_PLANNERS = new Map([['AWS::A::B', { properties: LIST, plan }]]);`)
    ).toThrow(/no literal properties list/);
    expect(() => parseProviderMarks('const X = 1;')).toThrow(/not found/);
  });
});

describe('gen-provider-replace-branches: the real tree', () => {
  // One walk of the real tree serves both cases.
  let loaded: ReturnType<typeof loadReport> | undefined;
  const real = (): ReturnType<typeof loadReport> => (loaded ??= loadReport());

  it(
    'has no gap, no underived site and no stale entry, and the committed files are current',
    () => {
      const { report, unresolved } = real();
      expect(findGaps(report)).toEqual([]);
      expect(findUnderived(report)).toEqual([]);
      expect(findStaleEntries(report)).toEqual([]);
      expect(unresolved).toEqual([]);
      // Floors per signal: a walk that stops seeing a shape drops its sites
      // and would read as a clean tree.
      const bySignal = (s: string): number => report.sites.filter((r) => r.signal === s).length;
      expect(bySignal('was-replaced')).toBeGreaterThanOrEqual(8);
      expect(bySignal('own-create')).toBeGreaterThanOrEqual(8);
      expect(report.summary.types).toBeGreaterThanOrEqual(9);
      // Every recorded entry is in use.
      expect(BRANCH_DISPOSITIONS.size).toBe(report.summary.disposed);
      expect(NOT_A_TRIGGER.size).toBeGreaterThan(0);
      expect(readFileSync(OUT_JSON, 'utf8')).toBe(serializeReport(report));
      expect(readFileSync(OUT_MD, 'utf8')).toBe(renderMarkdown(report) + '\n');
    },
    CONTENDED_CASE_TIMEOUT_MS
  );

  it(
    'pins the replace sites #6509 and #6513 were found at',
    () => {
      const { report } = real();
      const triggers = (type: string): Set<string> =>
        new Set(report.sites.filter((s) => s.resourceType === type).flatMap((s) => s.triggers.map((t) => t.property)));
      expect(triggers('AWS::SNS::Subscription')).toContain('FilterPolicy');
      expect(triggers('AWS::CertificateManager::Certificate')).toContain('DomainName');
      expect(triggers('AWS::Route53::RecordSet')).toContain('Name');
    },
    CONTENDED_CASE_TIMEOUT_MS
  );
});
