import { beforeAll, describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ModuleIndex,
  UPDATE_PATH_ALLOW_LIST,
  allowKey,
  buildReport,
  classifyFile,
  findGaps,
  findStaleAllowEntries,
  findUnresolved,
  loadReport,
  parseReplacementRules,
  type RuleSets,
  type SchemaFacts,
  type SourceHost,
  type TypeRow,
} from '../../../scripts/gen-update-path-coverage.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

const ROOT = '/virtual/src/provisioning/providers';
const PROVIDER = `${ROOT}/fake-provider.ts`;

function memoryHost(files: Record<string, string>): SourceHost {
  return { read: (file) => files[file] ?? null };
}

function schemaOf(properties: string[], createOnly: string[] = []): SchemaFacts {
  return { properties: new Set(properties), readOnly: new Set(), createOnly: new Set(createOnly) };
}

/**
 * Classify one in-memory provider file. `handled` becomes the class's
 * `handledProperties` for every type in `types`.
 */
function classify(opts: {
  classBody: string;
  handled: string[];
  types?: string[];
  prelude?: string;
  extraFiles?: Record<string, string>;
  companions?: string[];
  rules?: Map<string, RuleSets>;
  createOnly?: string[];
  schema?: SchemaFacts | null;
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
  return classifyFile({
    file: PROVIDER,
    companions: opts.companions ?? [],
    index: new ModuleIndex(host),
    rules: opts.rules ?? new Map(),
    schema: () => (opts.schema === undefined ? schemaOf(opts.handled, opts.createOnly) : opts.schema),
    allowList: new Map(),
  });
}

const statusOf = (rows: TypeRow[], prop: string, type = 'AWS::Fake::Thing'): string | undefined =>
  rows.find((r) => r.resourceType === type)?.properties.find((p) => p.property === prop)?.status;

describe('gen-update-path-coverage: what counts as a read on the update path', () => {
  it('an element access, a property access and a destructuring read; an unread property is a gap', () => {
    const rows = classify({
      handled: ['A', 'B', 'C', 'D'],
      classBody: `
        async update(id, pid, type, properties, previous) {
          const { C } = properties;
          await this.client.send(new X({ a: properties['A'], b: properties.B, c: C }));
        }`,
    });
    expect(statusOf(rows, 'A')).toBe('update');
    expect(statusOf(rows, 'B')).toBe('update');
    expect(statusOf(rows, 'C')).toBe('update');
    expect(statusOf(rows, 'D')).toBe('gap');
  });

  it('an object-literal KEY named like the property is not a read', () => {
    const rows = classify({
      handled: ['Name'],
      classBody: `async update(id, pid, type, properties) { await send({ Name: 'constant' }); }`,
    });
    expect(statusOf(rows, 'Name')).toBe('gap');
  });

  it('a string literal in a table the update walks is a read', () => {
    const rows = classify({
      handled: ['Size'],
      prelude: `const FIELDS = [{ prop: 'Size', path: '/size' }];`,
      classBody: `async update(id, pid, type, properties) { for (const f of FIELDS) await this.c.send(new PatchCommand({ [f.path]: properties[f.prop] })); }`,
    });
    expect(statusOf(rows, 'Size')).toBe('update');
  });

  it('follows this.x(), a module function, and a function imported from another file', () => {
    const helper = `${ROOT}/fake/helper.ts`;
    const rows = classify({
      handled: ['A', 'B', 'C'],
      prelude: `import { sendC } from './fake/helper.js';\nfunction sendB(p) { return client.send(new BCommand(p['B'])); }`,
      extraFiles: { [helper]: `export function sendC(p) { return client.send(new CCommand(p.C)); }` },
      classBody: `
        async update(id, pid, type, properties) { this.applyA(properties); sendB(properties); sendC(properties); }
        private applyA(p) { return this.c.send(new ACommand(p['A'])); }`,
    });
    expect(['A', 'B', 'C'].map((p) => statusOf(rows, p))).toEqual(['update', 'update', 'update']);
  });

  it('follows fn.call(this, ...) and a this.x() mixin into a companion this: function', () => {
    const companion = `${ROOT}/fake/update.ts`;
    const rows = classify({
      handled: ['A', 'B'],
      companions: [companion],
      extraFiles: {
        [companion]: `
          export function update(this: FakeProvider, id, pid, type, properties) { this.mixinB(properties); return this.c.send(new ACommand(properties.A)); }
          export function mixinB(this: FakeProvider, properties) { return this.c.send(new BCommand(properties['B'])); }`,
      },
      prelude: `import { update } from './fake/update.js';`,
      classBody: `async update(...args) { return update.call(this, ...args); }`,
    });
    expect(statusOf(rows, 'A')).toBe('update');
    expect(statusOf(rows, 'B')).toBe('update');
  });

  it('does not walk the declarative tables: iterating handledProperties reads nothing', () => {
    const rows = classify({
      handled: ['A'],
      classBody: `
        removalHandledInUpdate = new Map([['AWS::Fake::Thing', new Set(['A'])]]);
        async update(id, pid, type, properties, previous) {
          for (const k of this.handledProperties.get(type) ?? []) if (properties[k] !== previous[k]) break;
          void this.removalHandledInUpdate;
        }`,
    });
    expect(statusOf(rows, 'A')).toBe('gap');
  });

  it('does not walk into another class (a registry whose table names every property)', () => {
    const rows = classify({
      handled: ['A'],
      prelude: `class Registry { init() { return ['A']; } }`,
      classBody: `async update() { new Registry().init(); }`,
    });
    expect(statusOf(rows, 'A')).toBe('gap');
  });

  it('does not walk a generated module, whose tables name every type\'s properties', () => {
    const generated = '/virtual/src/provisioning/coverage.generated.ts';
    const rows = classify({
      handled: ['A'],
      prelude: `import { TABLE } from '../coverage.generated.js';`,
      extraFiles: { [generated]: `export const TABLE = new Set(['A']);` },
      classBody: `async update() { return TABLE; }`,
    });
    expect(statusOf(rows, 'A')).toBe('gap');
  });

  it('counts a handled name outside the schema instead of classifying it, and refuses a type with no schema', () => {
    const rows = classify({
      handled: ['A', 'NotCfn', 'Arn'],
      schema: { properties: new Set(['A', 'Arn']), readOnly: new Set(['Arn']), createOnly: new Set() },
      classBody: `async update(id, pid, type, p) { await this.c.send(new ACommand(p.A)); }`,
    });
    expect(rows[0]!.properties.map((p) => p.property)).toEqual(['A']);
    expect(rows[0]!.outsideSchema).toEqual(['Arn', 'NotCfn']);
    expect(buildReport(rows).summary.outsideSchema).toBe(2);
    expect(() => classify({ handled: ['A'], schema: null, classBody: `async update() {}` })).toThrow(
      /no CFn schema fixture/
    );
  });

  it('flags this.x.call / .apply / .bind on an unresolvable member too', () => {
    const rows = classify({
      handled: ['A'],
      classBody: `async update() { this.a.call(this); this.b.apply(this, []); const f = this.c.bind(this); }`,
    });
    expect(rows[0]!.unresolved).toEqual(['a', 'b', 'c']);
  });

  it('records an unresolvable this.x() call, and refuses a class with no update()', () => {
    const rows = classify({ handled: ['A'], classBody: `async update() { this.inherited(); }` });
    expect(rows[0]!.unresolved).toEqual(['inherited']);
    expect(findUnresolved(buildReport(rows))).toEqual(['FakeProvider (AWS::Fake::Thing): this.inherited()']);
    expect(() => classify({ handled: ['A'], classBody: `async create() {}` })).toThrow(/no update\(\)/);
  });

  it('resolves a base class member reached through this.x(), only through `extends`', () => {
    const rows = classify({
      handled: ['A'],
      prelude: `class Base { applyA(p) { return this.c.send(new ACommand(p.A)); } }`,
      classBody: `async update(id, pid, type, properties) { this.applyA(properties); }`,
    });
    // Without the heritage clause the member is unresolved, not borrowed.
    expect(rows[0]!.unresolved).toEqual(['applyA']);
    const host = memoryHost({
      [PROVIDER]: `class Base { applyA(p) { return this.c.send(new ACommand(p.A)); } }
        export class FakeProvider extends Base {
          handledProperties = new Map([['AWS::Fake::Thing', new Set(['A'])]]);
          async update(id, pid, type, properties) { this.applyA(properties); }
        }`,
    });
    const extended = classifyFile({
      file: PROVIDER,
      companions: [],
      index: new ModuleIndex(host),
      rules: new Map(),
      schema: () => schemaOf(['A']),
      allowList: new Map(),
    });
    expect(extended[0]!.unresolved).toEqual([]);
    expect(statusOf(extended, 'A')).toBe('update');
  });
});

describe('gen-update-path-coverage: a read counts only when it reaches a send, a refusal or a warning', () => {
  it('a change flag counts through the guard that sends, not through a skip path or a log line', () => {
    const body = (withSend: boolean): string => `
      async update(id, pid, type, properties, previous) {
        const changed = (k) => properties[k] !== previous[k];
        const autoChanged = changed('Auto');
        const warnKept = () => this.logger.warn('kept');
        if (!autoChanged) { this.logger.debug('nothing to do'); warnKept(); return; }
        this.logger.debug(\`Auto: \${properties.Logged}\`);
        ${withSend ? "if (autoChanged) await this.c.send(new PutAutoCommand(properties['Auto']));" : ''}
      }`;
    expect(statusOf(classify({ handled: ['Auto', 'Logged'], classBody: body(true) }), 'Auto')).toBe('update');
    const dropped = classify({ handled: ['Auto', 'Logged'], classBody: body(false) });
    // The issue's EMR mutation: delete the sending block and the flag's only
    // other reader is the early-exit guard.
    expect(statusOf(dropped, 'Auto')).toBe('gap');
    expect(statusOf(dropped, 'Logged')).toBe('gap');
  });

  it('a refusal and a warning count; an exempting membership test does not', () => {
    const rows = classify({
      handled: ['Fixed', 'Mutable', 'Noisy'],
      prelude: `const MUTABLE = new Set(['Mutable']);`,
      classBody: `
        async update(id, pid, type, properties, previous) {
          if (properties.Fixed !== previous.Fixed) throw new ResourceUpdateNotSupportedError(type, id, 'Fixed');
          if (properties.Noisy !== previous.Noisy) this.logger.warn('Noisy is not applied');
          for (const key of Object.keys(properties)) {
            if (!MUTABLE.has(key)) throw new ResourceUpdateNotSupportedError(type, id, key);
          }
        }`,
    });
    expect(statusOf(rows, 'Fixed')).toBe('update');
    expect(statusOf(rows, 'Noisy')).toBe('update');
    // MUTABLE lists what the refusal lets THROUGH: nothing here sends it.
    expect(statusOf(rows, 'Mutable')).toBe('gap');
  });

  it('a validation loop over a key table counts nothing (the s3-tables shape)', () => {
    const rows = classify({
      handled: ['EncryptionConfiguration'],
      prelude: `
        const CONFIG_KEYS = { 'AWS::Fake::Thing': ['EncryptionConfiguration'] };
        function desiredObject(p, key) {
          if (p[key] !== undefined && typeof p[key] !== 'object') throw new ProvisioningError(key + ' must be an object');
          return p[key];
        }`,
      classBody: `
        async update(id, pid, resourceType, properties) {
          for (const key of CONFIG_KEYS[resourceType] ?? []) desiredObject(properties, key);
        }`,
    });
    expect(statusOf(rows, 'EncryptionConfiguration')).toBe('gap');
  });

  it('a request built in a local, filled by a helper, or composed through a callback counts', () => {
    const rows = classify({
      handled: ['A', 'B', 'C'],
      prelude: `
        function fill(input, p) { input.b = p.B; }
        async function diffSub(prev, next, onPut) { if (prev !== next) await onPut(next); }`,
      classBody: `
        async update(id, pid, type, properties, previous) {
          const params = {};
          if (properties.A !== undefined) params.a = properties.A;
          fill(params, properties);
          await this.c.send(new UpdateCommand(params));
          await diffSub(previous.C, properties['C'], async (cfg) => this.c.send(new PutCCommand(cfg)));
        }`,
    });
    expect(['A', 'B', 'C'].map((p) => statusOf(rows, p))).toEqual(['update', 'update', 'update']);
  });
});

describe('gen-update-path-coverage: what a helper does with what it is handed', () => {
  it('a flag handed to a sending helper counts only if the helper hands that parameter on (the DynamoDB shape)', () => {
    const helper = (usesFlag: boolean): string => `
      async function applySettings(client, properties, protectionChanged, sseChanged) {
        if (sseChanged) await client.send(new UpdateSseCommand(properties.Sse));
        ${usesFlag ? 'if (protectionChanged) await client.send(new UpdateProtectionCommand(properties.Protection));' : ''}
      }
      function preflight(properties, previous) {
        const protectionChanged = properties['Protection'] !== previous['Protection'];
        if (protectionChanged && typeof properties['Protection'] !== 'boolean') throw new ProvisioningError('bad');
        return { protectionChanged, sseChanged: properties['Sse'] !== previous['Sse'] };
      }`;
    const body = `
      async update(id, pid, type, properties, previous) {
        const { protectionChanged, sseChanged } = preflight(properties, previous);
        await applySettings(this.c, properties, protectionChanged, sseChanged);
      }`;
    const kept = classify({ handled: ['Protection', 'Sse'], prelude: helper(true), classBody: body });
    expect(statusOf(kept, 'Protection')).toBe('update');
    const dropped = classify({ handled: ['Protection', 'Sse'], prelude: helper(false), classBody: body });
    // The flag is still computed and still handed over, but nothing sends it:
    // its validation refusal alone is no refusal of the change.
    expect(statusOf(dropped, 'Protection')).toBe('gap');
    expect(statusOf(dropped, 'Sse')).toBe('update');
  });

  it('a request filled through a delegating member and a spread rest parameter counts', () => {
    const companion = `${ROOT}/fake/fill.ts`;
    const rows = classify({
      handled: ['A'],
      companions: [companion],
      extraFiles: {
        [companion]: `export function fill(this: FakeProvider, input, properties) { input.a = properties.A; }`,
      },
      prelude: `import { fill } from './fake/fill.js';`,
      classBody: `
        fill(...args) { return fill.call(this, ...args); }
        async update(id, pid, type, properties) {
          const input = {};
          this.fill(input, properties);
          await this.c.send(new UpdateCommand(input));
        }`,
    });
    expect(statusOf(rows, 'A')).toBe('update');
  });
});

describe('gen-update-path-coverage: resourceType-keyed tables', () => {
  const types = ['AWS::Fake::One', 'AWS::Fake::Two'];

  it('TABLE[resourceType] and MAP.get(resourceType) walk only the entry for the type', () => {
    const rows = classify({
      types,
      handled: ['A', 'B', 'C', 'D'],
      prelude: `
        const KEYS = { 'AWS::Fake::One': ['A'], 'AWS::Fake::Two': ['B'] };
        const MORE = new Map([['AWS::Fake::One', ['C']], ['AWS::Fake::Two', ['D']]]);`,
      classBody: `
        async update(id, pid, resourceType, properties) {
          for (const k of KEYS[resourceType] ?? []) await this.c.send(new PutCommand({ v: properties[k] }));
          for (const k of MORE.get(resourceType) ?? []) await this.c.send(new PutCommand({ v: properties[k] }));
        }`,
    });
    expect(['A', 'B', 'C', 'D'].map((p) => statusOf(rows, p, 'AWS::Fake::One'))).toEqual([
      'update',
      'gap',
      'update',
      'gap',
    ]);
    expect(['A', 'B', 'C', 'D'].map((p) => statusOf(rows, p, 'AWS::Fake::Two'))).toEqual([
      'gap',
      'update',
      'gap',
      'update',
    ]);
  });
});

describe('gen-update-path-coverage: per-type narrowing', () => {
  const types = ['AWS::Fake::One', 'AWS::Fake::Two'];

  it('a switch on resourceType walks only the matching case', () => {
    const rows = classify({
      types,
      handled: ['A', 'B'],
      classBody: `
        async update(id, pid, resourceType, properties) {
          switch (resourceType) {
            case 'AWS::Fake::One': return this.c.send(new ACommand(properties.A));
            case 'AWS::Fake::Two': return this.c.send(new BCommand(properties.B));
          }
        }`,
    });
    expect(statusOf(rows, 'A', 'AWS::Fake::One')).toBe('update');
    expect(statusOf(rows, 'B', 'AWS::Fake::One')).toBe('gap');
    expect(statusOf(rows, 'A', 'AWS::Fake::Two')).toBe('gap');
    expect(statusOf(rows, 'B', 'AWS::Fake::Two')).toBe('update');
  });

  it('an if / else on resourceType, in both polarities', () => {
    const rows = classify({
      types,
      handled: ['A', 'B'],
      classBody: `
        async update(id, pid, resourceType, properties) {
          if (resourceType !== 'AWS::Fake::One') { return send(new BCommand(properties.B)); } else { return send(new ACommand(properties.A)); }
        }`,
    });
    expect(statusOf(rows, 'A', 'AWS::Fake::One')).toBe('update');
    expect(statusOf(rows, 'B', 'AWS::Fake::One')).toBe('gap');
    expect(statusOf(rows, 'B', 'AWS::Fake::Two')).toBe('update');
    expect(statusOf(rows, 'A', 'AWS::Fake::Two')).toBe('gap');
  });

  it('a braced case body that returns does not fall through into the next case', () => {
    const rows = classify({
      types,
      handled: ['A', 'B', 'C'],
      classBody: `
        async update(id, pid, resourceType, properties) {
          switch (resourceType) {
            case 'AWS::Fake::One': { const a = properties.A; return send(new ACommand(a)); }
            case 'AWS::Fake::Two': if (properties.A) return send(new BCommand(properties.B)); else return;
            case 'AWS::Fake::Three': return send(new CCommand(properties.C));
          }
        }`,
    });
    expect(statusOf(rows, 'B', 'AWS::Fake::One')).toBe('gap');
    // An if / else whose arms both return ends the clause too.
    expect(statusOf(rows, 'C', 'AWS::Fake::Two')).toBe('gap');
  });

  it('narrows through && and ||, and reads the condition for a type that takes the branch', () => {
    const rows = classify({
      types,
      handled: ['A', 'B', 'C'],
      classBody: `
        async update(id, pid, resourceType, properties) {
          if (resourceType === 'AWS::Fake::One' && properties.C) return send(new ACommand(properties.A));
          if (resourceType === 'AWS::Fake::One' || resourceType === 'AWS::Fake::Three') return;
          return send(new BCommand(properties.B));
        }`,
    });
    expect(statusOf(rows, 'A', 'AWS::Fake::One')).toBe('update');
    expect(statusOf(rows, 'A', 'AWS::Fake::Two')).toBe('gap');
    // The guard reads C for type One only: for Two it short-circuits.
    expect(statusOf(rows, 'C', 'AWS::Fake::One')).toBe('update');
    expect(statusOf(rows, 'C', 'AWS::Fake::Two')).toBe('gap');
    // Early return: after `if (type is One or Three) return;` the rest of the
    // block is not type One's, and is type Two's.
    expect(statusOf(rows, 'B', 'AWS::Fake::One')).toBe('gap');
    expect(statusOf(rows, 'B', 'AWS::Fake::Two')).toBe('update');
  });

  it('a comparison of something else with an AWS:: literal does not narrow', () => {
    const rows = classify({
      types,
      handled: ['A'],
      classBody: `
        async update(id, pid, resourceType, properties) {
          if (properties.Target.Type === 'AWS::Fake::Two') return send(new ACommand(properties.A));
        }`,
    });
    expect(statusOf(rows, 'A', 'AWS::Fake::One')).toBe('update');
  });
});

describe('gen-update-path-coverage: replacement and allow-listing', () => {
  const rules = (r: Partial<RuleSets>): Map<string, RuleSets> =>
    new Map([
      [
        'AWS::Fake::Thing',
        {
          replacement: r.replacement ?? new Set(),
          updateable: r.updateable ?? new Set(),
          conditional: r.conditional ?? new Set(),
        },
      ],
    ]);
  const noReads = `async update() {}`;

  it('a replacementProperties entry or a schema create-only property replaces', () => {
    const rows = classify({
      handled: ['R', 'C'],
      classBody: noReads,
      createOnly: ['C'],
      rules: rules({ replacement: new Set(['R']) }),
    });
    expect(rows[0]!.properties).toEqual([
      { property: 'C', status: 'replacement', via: 'create-only' },
      { property: 'R', status: 'replacement', via: 'rule' },
    ]);
  });

  it('create-only overridden as updateable, or given a conditional predicate, still needs the update path', () => {
    const rows = classify({
      handled: ['U', 'K'],
      classBody: noReads,
      createOnly: ['U', 'K'],
      rules: rules({ updateable: new Set(['U']), conditional: new Set(['K']) }),
    });
    expect(statusOf(rows, 'U')).toBe('gap');
    expect(statusOf(rows, 'K')).toBe('gap');
  });

  it('an allow-list entry classifies a gap, and an entry for a non-gap is stale', () => {
    const report = buildReport([
      {
        resourceType: 'AWS::Fake::Thing',
        file: 'f.ts',
        className: 'FakeProvider',
        properties: [
          { property: 'A', status: 'allow-listed', rationale: 'x' },
          { property: 'B', status: 'update' },
          { property: 'C', status: 'gap' },
        ],
        outsideSchema: [],
        unresolved: [],
      },
    ]);
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'A'), { rationale: 'x' }],
      [allowKey('AWS::Fake::Thing', 'B'), { rationale: 'fixed since' }],
    ]);
    expect(findGaps(report)).toEqual(['AWS::Fake::Thing#C']);
    expect(findStaleAllowEntries(report, allow)).toEqual(['AWS::Fake::Thing#B']);
  });
});

describe('parseReplacementRules', () => {
  it('reads Sets, Maps and the array-.map Map shape', () => {
    const rules = parseReplacementRules(`
      function initializeRules() {
        this.rules.set('AWS::A::B', {
          replacementProperties: new Set(['R']),
          updateableProperties: new Set(['U']),
          conditionalReplacements: new Map([['K', pred]]),
        });
        this.rules.set('AWS::C::D', {
          replacementProperties: new Set(),
          conditionalReplacements: new Map(['X', 'Y'].map((p) => [p, pred])),
        });
      }`);
    expect(rules.get('AWS::A::B')).toEqual({
      replacement: new Set(['R']),
      updateable: new Set(['U']),
      conditional: new Set(['K']),
    });
    expect(rules.get('AWS::C::D')!.conditional).toEqual(new Set(['X', 'Y']));
  });

  it('refuses a member or an entry it does not model', () => {
    expect(() =>
      parseReplacementRules(`this.rules.set('AWS::A::B', { replacementProperties: new Set(), other: 1 });`)
    ).toThrow(/unmodelled member/);
    expect(() =>
      parseReplacementRules(`this.rules.set('AWS::A::B', { replacementProperties: new Set([NAME]) });`)
    ).toThrow(/non-literal entry/);
    expect(() => parseReplacementRules(`const x = 1;`)).toThrow(/zero/);
  });
});

// Each case walks every provider file of the real tree (seconds, more on a
// loaded CI runner), so the in-process 5 s default does not fit.
describe('gen-update-path-coverage on the real tree', { timeout: CONTENDED_CASE_TIMEOUT_MS }, () => {
  let report: ReturnType<typeof loadReport>;
  beforeAll(() => {
    report = loadReport();
  }, CONTENDED_CASE_TIMEOUT_MS);

  it('has no gap, no unresolved call and no stale allow-list entry', () => {
    expect(findGaps(report)).toEqual([]);
    expect(findUnresolved(report)).toEqual([]);
    expect(findStaleAllowEntries(report, UPDATE_PATH_ALLOW_LIST)).toEqual([]);
  });

  it('classifies exactly the SDK provider types the property coverage knows', () => {
    // A parse regression would shrink the population and clear gaps with it;
    // the property coverage (a different parser over the same declarations)
    // is the independent oracle for which types there are.
    expect(new Set(report.types.map((t) => t.resourceType))).toEqual(
      new Set(PROPERTY_COVERAGE_BY_TYPE.keys())
    );
    expect(report.summary.properties).toBeGreaterThanOrEqual(1500);
  });

  it('reports a gap when a real update path stops reading a property', () => {
    // SNS Topic's update applies MaximumMessageSize through a table keyed by
    // the property name; renaming the token there drops the only read.
    const target = resolve(process.cwd(), 'src/provisioning/providers/sns-topic/update.ts');
    const original = readFileSync(target, 'utf8');
    expect(original).toContain("'MaximumMessageSize'");
    const host: SourceHost = {
      read: (file) => {
        try {
          const text = readFileSync(file, 'utf8');
          return file === target ? text.replaceAll('MaximumMessageSize', 'MaximumMessageSizX') : text;
        } catch {
          return null;
        }
      },
    };
    expect(findGaps(loadReport(host))).toEqual(['AWS::SNS::Topic#MaximumMessageSize']);
  });
});
