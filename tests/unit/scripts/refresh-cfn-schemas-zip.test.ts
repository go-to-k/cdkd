/**
 * Issue [#2718](https://github.com/go-to-k/cdkd/issues/2718) — the public
 * schema-bundle capture path in `scripts/refresh-cfn-schemas.mjs`, which the
 * scheduled fixture-refresh workflow runs.
 *
 * What the path has to get right, and what each is defended against:
 *
 * - **Drift detection ignoring `generatedAt`.** The refresh stamps a date on
 *   every type it captures, so counting that as drift would report all ~134
 *   fixtures changed every cycle. Measured on the first real run: 132 rewritten,
 *   114 differing in `generatedAt` ALONE. A job whose signal counted that opens
 *   a no-op PR every month, and a PR that is noise every time is a PR nobody
 *   reads on the cycle that matters.
 * - **A type absent from the bundle is SKIPPED, never blanked.** Treating
 *   absence as "this type now has no properties" would empty `properties`, turn
 *   every `handledProperties` declaration bogus, and destroy silent-drop
 *   routing for the type — a missing input becoming a silent behavior change on
 *   the deploy path. Two real types are in this state
 *   (`AWS::BedrockAgentCore::Browser` / `CodeInterpreter`).
 * - **Two collapse floors.** A truncated-but-parseable bundle, or an entry
 *   naming change, makes every lookup miss; every type then takes the
 *   legitimate skip path and the run reports a confident ZERO drift. Both are
 *   aborts, because "we looked at almost nothing" is indistinguishable
 *   downstream from "AWS changed nothing".
 *
 * The acceptance clause the issue states — "a fixture deliberately missing a
 * property makes the new check fail" — is the `MemorySize` case below, with an
 * unmutated CONTROL twin asserting byte-identity so a checker that reported
 * everything as drifted could not pass both.
 *
 * What is REAL in that case is stated precisely, because over-claiming a
 * fence's reach is the defect this whole issue is about: the property LIST
 * comes from the committed `AWS-Lambda-Function.json` and is asserted to
 * contain `MemorySize`, while the bundle entry is derived from that list. It
 * has to be — a fixture stores property NAMES, not the schema body, so it is a
 * lossy projection and cannot be inverted into an entry that re-derives it.
 * The claim this suite supports is therefore "the refresh notices a property
 * missing from a real type's real property list", not "the refresh reproduces
 * AWS's schema".
 */
import { describe, it, expect, afterAll } from 'vite-plus/test';
import AdmZip from 'adm-zip';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFixture,
  downloadSchemaBundle,
  fixtureDiffersIgnoringDate,
  MAX_DOWNLOAD_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  readSchemaBundle,
  refreshFixturesFromEntries,
  serializeFixture,
  zipEntryName,
} from '../../../scripts/refresh-cfn-schemas.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'cfn-schemas');
const LAMBDA_FIXTURE = join(FIXTURES_DIR, 'AWS-Lambda-Function.json');

/**
 * The floors live in the script as module constants. Cross this many synthetic
 * filler entries into a bundle so a case that is NOT about the floors clears
 * them; a bare handful of entries would abort for the wrong reason and the
 * assertion would pass vacuously.
 */
const FILLER_ENTRIES = 1200;

function bundleWith(entries: Record<string, unknown>, filler = FILLER_ENTRIES): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, schema] of Object.entries(entries)) {
    map.set(name, JSON.stringify(schema));
  }
  for (let i = map.size; i < filler; i++) {
    map.set(`filler-${i}.json`, JSON.stringify({ typeName: `Filler::T::${i}`, properties: {} }));
  }
  return map;
}

/** Every scratch dir this file made, removed in `afterAll` rather than leaked. */
const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A scratch fixtures dir plus recording read/write seams. */
function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-schema-refresh-'));
  scratchDirs.push(dir);
  const writes: Array<{ path: string; text: string }> = [];
  return {
    dir,
    writes,
    writeFixture: (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
      writes.push({ path, text });
    },
    readFixture: (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  };
}

describe('zipEntryName', () => {
  it('lowercases and dash-joins, which is NOT the committed fixture filename convention', () => {
    expect(zipEntryName('AWS::Lambda::Function')).toBe('aws-lambda-function.json');
    expect(zipEntryName('AWS::BedrockAgentCore::Runtime')).toBe('aws-bedrockagentcore-runtime.json');
  });
});

describe('fixtureDiffersIgnoringDate', () => {
  const schema = JSON.stringify({ properties: { A: { type: 'string' } } });
  const base = buildFixture(schema, 'AWS::Test::Type', '2026-01-01');

  it('reports NO drift when only generatedAt differs', () => {
    const committed = serializeFixture(buildFixture(schema, 'AWS::Test::Type', '2020-05-05'));
    expect(fixtureDiffersIgnoringDate(base, committed)).toBe(false);
  });

  it('reports drift when a property is added', () => {
    const older = JSON.stringify({ properties: {} });
    const committed = serializeFixture(buildFixture(older, 'AWS::Test::Type', '2026-01-01'));
    expect(fixtureDiffersIgnoringDate(base, committed)).toBe(true);
  });

  it('reports drift when a property is REMOVED (the bogus-entry class)', () => {
    const richer = JSON.stringify({ properties: { A: { type: 'string' }, B: { type: 'string' } } });
    const committed = serializeFixture(buildFixture(richer, 'AWS::Test::Type', '2026-01-01'));
    expect(fixtureDiffersIgnoringDate(base, committed)).toBe(true);
  });

  it('treats an absent fixture as drift', () => {
    expect(fixtureDiffersIgnoringDate(base, undefined)).toBe(true);
  });

  it('treats an unparseable committed fixture as drift, so it gets repaired', () => {
    expect(fixtureDiffersIgnoringDate(base, '{ not json')).toBe(true);
  });
});

describe('refreshFixturesFromEntries — the acceptance case (issue #2718)', () => {
  /**
   * The REAL datum both cases below are built on: the committed Lambda
   * fixture's top-level property list, `MemorySize` included.
   *
   * The bundle entry is DERIVED from that list rather than being a captured
   * AWS schema, and that is forced rather than chosen: a fixture is a LOSSY
   * projection of a registry schema (it stores property NAMES, not the schema
   * body), so it cannot be inverted into an entry that re-derives itself. What
   * stays real is the part the acceptance clause is about — which properties
   * the type actually has — and it is asserted, so the day AWS retires
   * `MemorySize` this probe fails loudly instead of testing a name that no
   * longer exists.
   */
  function lambdaBaseline() {
    const committed = JSON.parse(readFileSync(LAMBDA_FIXTURE, 'utf8'));
    expect(
      committed.properties,
      'the real Lambda fixture must carry MemorySize — repoint this probe if AWS retires it'
    ).toContain('MemorySize');
    expect(
      committed.properties.length,
      'the real Lambda fixture must carry a substantial property list, or this ' +
        'probe would be asserting over almost nothing'
    ).toBeGreaterThan(20);

    const liveSchema = {
      properties: Object.fromEntries(
        (committed.properties as string[]).map((p) => [p, { type: 'string' }])
      ),
    };
    return {
      liveSchema,
      // The fixture the refresh SHOULD converge on, byte for byte.
      expectedText: serializeFixture(
        buildFixture(JSON.stringify(liveSchema), 'AWS::Lambda::Function', '2026-08-13')
      ),
      properties: committed.properties as string[],
    };
  }

  /**
   * The issue's acceptance clause: a fixture deliberately missing a property
   * must make the check fail — here, be reported drifted and rewritten to
   * carry it again.
   */
  it('a committed fixture MISSING a property is reported drifted and rewritten to carry it', () => {
    const { liveSchema, expectedText } = lambdaBaseline();
    const mutated = JSON.parse(expectedText);
    mutated.properties = mutated.properties.filter((p: string) => p !== 'MemorySize');

    const { dir, writeFixture, readFixture } = scratchDir();
    const path = join(dir, 'AWS-Lambda-Function.json');
    writeFileSync(path, serializeFixture(mutated), 'utf8');

    const summary = refreshFixturesFromEntries({
      entries: bundleWith({ 'aws-lambda-function.json': liveSchema }),
      types: ['AWS::Lambda::Function'],
      fixturesDir: dir,
      generatedAt: '2026-08-13',
      writeFixture,
      readFixture,
    });

    expect(summary.drifted).toEqual(['AWS::Lambda::Function']);
    expect(summary.failed).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8')).properties).toContain('MemorySize');
  });

  /**
   * The CONTROL twin. Same baseline, UNMUTATED, same bundle entry, and a
   * DIFFERENT capture date so `generatedAt` is the only thing that could
   * report drift. It must be reported unchanged AND left byte-identical.
   * Without this, a checker that called everything drifted would pass the case
   * above.
   */
  it('the same fixture UNMUTATED is reported unchanged and left byte-identical', () => {
    const { liveSchema, expectedText } = lambdaBaseline();
    const { dir, writeFixture, readFixture, writes } = scratchDir();
    const path = join(dir, 'AWS-Lambda-Function.json');
    writeFileSync(path, expectedText, 'utf8');

    const summary = refreshFixturesFromEntries({
      entries: bundleWith({ 'aws-lambda-function.json': liveSchema }),
      types: ['AWS::Lambda::Function'],
      generatedAt: '2099-12-31',
      fixturesDir: dir,
      writeFixture,
      readFixture,
    });

    expect(summary.unchanged).toEqual(['AWS::Lambda::Function']);
    expect(summary.drifted).toEqual([]);
    expect(writes).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(expectedText);
  });
});

describe('refreshFixturesFromEntries — skips and floors', () => {
  it('leaves a type with no bundle entry byte-identical and lists it as missing', () => {
    const { dir, writeFixture, readFixture, writes } = scratchDir();
    const absentType = 'AWS::BedrockAgentCore::Browser';
    const path = join(dir, 'AWS-BedrockAgentCore-Browser.json');
    const original = serializeFixture(
      buildFixture(
        JSON.stringify({ properties: { NetworkConfiguration: { type: 'object' } } }),
        absentType,
        '2026-08-13'
      )
    );
    writeFileSync(path, original, 'utf8');

    // Companion types that ARE present, so the missing RATIO stays under the
    // ceiling — otherwise this case aborts on the floor and never reaches the
    // skip path it exists to test (the real shape is 2 absent of 134).
    const present = Array.from({ length: 40 }, (_, i) => `AWS::Test::T${i}`);
    const summary = refreshFixturesFromEntries({
      entries: bundleWith(
        Object.fromEntries(present.map((t) => [zipEntryName(t), { properties: {} }]))
      ),
      types: [absentType, ...present],
      fixturesDir: dir,
      generatedAt: '2026-09-07',
      writeFixture,
      readFixture,
    });

    expect(summary.missing).toEqual([absentType]);
    expect(summary.drifted).not.toContain(absentType);
    expect(writes.map((w) => w.path)).not.toContain(path);
    // The load-bearing assertion: the fixture is not blanked, not re-dated,
    // not touched at all.
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  /**
   * The third shape of the same collapse, and the one that slips past BOTH
   * floors: an empty population makes the missing ratio 0/0, the entry floor
   * is about the bundle rather than the types, and the run returns four empty
   * arrays the workflow reads as "no drift" — forever, silently. Reachable
   * without touching the capture code at all, since `extractRegisteredTypes`
   * scrapes `register-providers.ts` with a regex that a refactor can empty.
   */
  it('aborts on an EMPTY type list rather than reporting no drift', () => {
    const { dir, writeFixture, readFixture, writes } = scratchDir();
    expect(() =>
      refreshFixturesFromEntries({
        entries: bundleWith({}),
        types: [],
        fixturesDir: dir,
        generatedAt: '2026-09-07',
        writeFixture,
        readFixture,
      })
    ).toThrow(/No registered resource types/);
    expect(writes).toEqual([]);
  });

  it('aborts on a bundle below the entry floor, writing nothing', () => {
    const { dir, writeFixture, readFixture, writes } = scratchDir();
    expect(() =>
      refreshFixturesFromEntries({
        entries: bundleWith({ 'aws-lambda-function.json': { properties: {} } }, 10),
        types: ['AWS::Lambda::Function'],
        fixturesDir: dir,
        generatedAt: '2026-09-07',
        writeFixture,
        readFixture,
      })
    ).toThrow(/only 10 entries/);
    expect(writes).toEqual([]);
  });

  it('aborts when too many registered types are absent, writing nothing', () => {
    const { dir, writeFixture, readFixture, writes } = scratchDir();
    // 10 types, only 1 present -> 90% missing, far over the 10% ceiling.
    const types = Array.from({ length: 10 }, (_, i) => `AWS::Test::T${i}`);
    expect(() =>
      refreshFixturesFromEntries({
        entries: bundleWith({ 'aws-test-t0.json': { properties: {} } }),
        types,
        fixturesDir: dir,
        generatedAt: '2026-09-07',
        writeFixture,
        readFixture,
      })
    ).toThrow(/have no entry in the schema bundle/);
    expect(writes).toEqual([]);
  });

  it('tolerates a couple of missing types without aborting (the real 2-of-134 shape)', () => {
    const { dir, writeFixture, readFixture } = scratchDir();
    const types = Array.from({ length: 100 }, (_, i) => `AWS::Test::T${i}`);
    const entries = bundleWith(
      Object.fromEntries(
        types.slice(0, 98).map((t) => [zipEntryName(t), { properties: { A: { type: 'string' } } }])
      )
    );
    const summary = refreshFixturesFromEntries({
      entries,
      types,
      fixturesDir: dir,
      generatedAt: '2026-09-07',
      writeFixture,
      readFixture,
    });
    expect(summary.missing).toHaveLength(2);
    expect(summary.drifted).toHaveLength(98);
  });

  it('records a per-type capture failure without aborting the whole run', () => {
    const { dir, writeFixture, readFixture } = scratchDir();
    const entries = bundleWith({
      'aws-test-good.json': { properties: { A: { type: 'string' } } },
    });
    entries.set('aws-test-bad.json', '{ not json');
    const summary = refreshFixturesFromEntries({
      entries,
      types: ['AWS::Test::Good', 'AWS::Test::Bad'],
      fixturesDir: dir,
      generatedAt: '2026-09-07',
      writeFixture,
      readFixture,
    });
    expect(summary.drifted).toEqual(['AWS::Test::Good']);
    expect(summary.failed.map((f) => f.type)).toEqual(['AWS::Test::Bad']);
  });
});


describe('readSchemaBundle', () => {
  /**
   * The bundle reader has real parsing behavior, and each rule below guards a
   * way a future bundle-layout change could quietly empty the result while the
   * zip still opens.
   */
  function zipOf(files: Record<string, string>): Buffer {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) {
      zip.addFile(name, Buffer.from(content, 'utf8'));
    }
    return zip.toBuffer();
  }

  it('reads entries keyed by their basename', () => {
    const entries = readSchemaBundle(zipOf({ 'aws-lambda-function.json': '{"properties":{}}' }));
    expect([...entries.keys()]).toEqual(['aws-lambda-function.json']);
    expect(entries.get('aws-lambda-function.json')).toBe('{"properties":{}}');
  });

  /**
   * The bundle is flat today. Keying on the full path would make a future
   * wrapper directory read as "every registered type is absent" — which is the
   * shape the missing-ratio ceiling aborts on, so this keeps a harmless layout
   * change from looking like a corrupt bundle.
   */
  it('keys a nested entry by basename too, so a wrapper directory is survivable', () => {
    const entries = readSchemaBundle(
      zipOf({ 'schemas/aws-lambda-function.json': '{"properties":{}}' })
    );
    expect(entries.has('aws-lambda-function.json')).toBe(true);
  });

  it('ignores non-JSON entries', () => {
    const entries = readSchemaBundle(
      zipOf({ 'README.txt': 'hi', 'aws-s3-bucket.json': '{"properties":{}}' })
    );
    expect([...entries.keys()]).toEqual(['aws-s3-bucket.json']);
  });
});

describe('fixtureDiffersIgnoringDate sees EVERY captured section', () => {
  /**
   * The gap this closes: every drift case elsewhere in this file differs only
   * in `properties`, so narrowing the comparison to `candidate.properties`
   * passed the acceptance case, its byte-identity control twin, and all five
   * unit cases. A signal blind to a section is a section that can change under
   * a monthly job reporting "no drift" — the exact failure mode the job exists
   * to prevent, one level down.
   *
   * One case per section `buildFixture` emits, each a MINIMAL edit to that
   * section alone.
   */
  const BASE = {
    properties: {
      A: { type: 'string' },
      Cfg: { $ref: '#/definitions/Cfg' },
      // An INLINE object, deliberately not a `$ref` definition: adding a member
      // under it moves `nestedProperties` / `nestedPropertyPaths` WITHOUT
      // touching `definitionShapes`, which only classifies `#top` and each
      // NAMED definition. Without it, every nested variant also moved
      // `definitionShapes` and no case pinned the nested sections at all.
      Obj: { type: 'object', properties: { P1: { type: 'string' } } },
    },
    readOnlyProperties: ['/properties/A'],
    createOnlyProperties: ['/properties/A'],
    primaryIdentifier: ['/properties/A'],
    required: ['A'],
    definitions: {
      Cfg: { type: 'object', required: ['Inner'], properties: { Inner: { type: 'string' } } },
    },
  };

  /**
   * Each variant changes the NAMED section, and — where isolation is possible
   * — only that one. Measured, not assumed.
   *
   * `properties` is NOT isolable by construction and the table does not
   * pretend otherwise: `definitionShapes` carries a `#top` entry whose keys ARE
   * the top-level property names, so any change to `properties` necessarily
   * moves `definitionShapes` too. That is a property of the capture, not a
   * weakness of the case — what matters is that no OTHER section can stand in
   * for the one under test, which the isolated variants below establish.
   */
  const VARIANTS: Array<{ section: string; mutate: (s: typeof BASE) => Record<string, unknown> }> = [
    { section: 'properties', mutate: (s) => ({ ...s, properties: { ...s.properties, B: { type: 'string' } } }) },
    { section: 'readOnlyProperties', mutate: (s) => ({ ...s, readOnlyProperties: [] }) },
    { section: 'createOnlyProperties', mutate: (s) => ({ ...s, createOnlyProperties: [] }) },
    { section: 'primaryIdentifier', mutate: (s) => ({ ...s, primaryIdentifier: [] }) },
    {
      section: 'nestedProperties / nestedPropertyPaths',
      // Measured to move ONLY those two sections (see the note on `Obj`).
      mutate: (s) => ({
        ...s,
        properties: {
          ...s.properties,
          Obj: { type: 'object', properties: { P1: { type: 'string' }, P2: { type: 'string' } } },
        },
      }),
    },
    {
      section: 'definitionShapes',
      mutate: (s) => ({
        ...s,
        definitions: {
          Cfg: { ...s.definitions.Cfg, properties: { Inner: { type: 'array', items: { type: 'string' } } } },
        },
      }),
    },
    {
      section: 'definitionRequired',
      mutate: (s) => ({ ...s, definitions: { Cfg: { ...s.definitions.Cfg, required: [] } } }),
    },
  ];

  const committed = serializeFixture(
    buildFixture(JSON.stringify(BASE), 'AWS::Test::Type', '2026-01-01')
  );

  it('reports NO drift for the unmutated base (the control for the table below)', () => {
    const candidate = buildFixture(JSON.stringify(BASE), 'AWS::Test::Type', '2099-12-31');
    expect(fixtureDiffersIgnoringDate(candidate, committed)).toBe(false);
  });

  for (const { section, mutate } of VARIANTS) {
    it(`reports drift when ${section} changes`, () => {
      const candidate = buildFixture(
        JSON.stringify(mutate(BASE)),
        'AWS::Test::Type',
        // Same date as the committed side, so the ONLY difference is the
        // section under test.
        '2026-01-01'
      );
      expect(fixtureDiffersIgnoringDate(candidate, committed)).toBe(true);
    });
  }

  it('the base actually populates every section it claims to exercise', () => {
    // Without this the table above could be asserting over sections the base
    // never emits, and each case would pass for the wrong reason.
    const built = buildFixture(JSON.stringify(BASE), 'AWS::Test::Type', '2026-01-01');
    for (const key of [
      'properties',
      'readOnlyProperties',
      'createOnlyProperties',
      'primaryIdentifier',
      'nestedProperties',
      'nestedPropertyPaths',
      'definitionShapes',
      'definitionRequired',
    ]) {
      expect(built, `buildFixture emitted no ${key}`).toHaveProperty(key);
    }
  });
});

describe('serializeFixture matches the committed corpus byte-for-byte', () => {
  /**
   * Every other comparison in this file is serialize-vs-serialize, so changing
   * `serializeFixture` to minified output — or dropping the trailing newline —
   * passes the whole suite while the next refresh rewrites all 134 committed
   * files for no reason. This is the one assertion anchored to what is
   * actually on disk, and it pins key ORDER as well as formatting.
   */
  it('round-trips every committed fixture unchanged', () => {
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    expect(files.length, 'no committed fixtures found — the corpus path is wrong').toBeGreaterThan(100);
    const mismatched: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(FIXTURES_DIR, file), 'utf8');
      if (serializeFixture(JSON.parse(text)) !== text) mismatched.push(file);
    }
    expect(mismatched, 'serializeFixture no longer reproduces these committed fixtures').toEqual([]);
  });

  /**
   * The round trip above preserves whatever order each FILE already has, so it
   * cannot see `buildFixture` reordering the object it returns — which would
   * rewrite all 134 fixtures on the next refresh for no semantic reason. This
   * pins the emitted order directly.
   */
  it('buildFixture emits its keys in the committed canonical order', () => {
    const built = buildFixture(
      JSON.stringify({
        properties: { A: { type: 'string' }, Obj: { type: 'object', properties: { P: {} } } },
        readOnlyProperties: ['/properties/A'],
        createOnlyProperties: ['/properties/A'],
        primaryIdentifier: ['/properties/A'],
        required: ['A'],
      }),
      'AWS::Test::Type',
      '2026-01-01'
    );
    expect(Object.keys(built)).toEqual([
      'resourceType',
      'generatedAt',
      'properties',
      'readOnlyProperties',
      'createOnlyProperties',
      'primaryIdentifier',
      'nestedProperties',
      'nestedPropertyPaths',
      'definitionShapes',
      'definitionRequired',
    ]);
  });
});

describe('CLI argument handling', () => {
  /**
   * `main()` is not exported, so these run the real binary. The first case is
   * a REGRESSION probe: `--from-zipX` once passed the unknown-flag filter,
   * matched neither the zip mode nor the positional type filter, and fell
   * through to a FULL authenticated DescribeType refresh of every registered
   * type — rewriting ~135 fixtures from a typo, which is exactly what that
   * guard was added to prevent.
   */
  function run(args: string[]) {
    // The environment is SCRUBBED of AWS credentials, and that is a safety
    // requirement rather than hygiene. These cases exercise argument REFUSAL,
    // so the day a refusal regresses the run falls through to the real
    // DescribeType path — and on a developer or CI machine that has
    // credentials, it would issue ~135 live AWS calls and REWRITE all 134
    // committed fixtures. Measured, not hypothetical: it happened here while
    // probing this very guard, and the resulting fixture churn was
    // indistinguishable from a real refresh.
    //
    // With credentials removed the fall-through fails fast and writes nothing
    // (`processType` only writes on a successful response), so a regression
    // shows up as the assertion below failing rather than as a mutated tree.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('AWS_')) delete env[key];
    }
    env['AWS_EC2_METADATA_DISABLED'] = 'true';
    env['AWS_SHARED_CREDENTIALS_FILE'] = join(REPO_ROOT, 'does-not-exist-credentials');
    env['AWS_CONFIG_FILE'] = join(REPO_ROOT, 'does-not-exist-config');
    return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/refresh-cfn-schemas.mjs'), ...args], {
      encoding: 'utf8',
      env,
    });
  }

  /**
   * The safety net for the note above: whatever any case in this block does,
   * it must not have touched the committed corpus.
   */
  function fixtureCorpusDigest(): string {
    // CONTENT-hashed, not byte-length. The incident this guards is a
    // fall-through refresh rewriting every fixture's `generatedAt` — and a
    // date is always 10 characters, so a length-based digest passes over a
    // fully rewritten corpus, i.e. it would be blind to precisely the case it
    // exists for.
    const h = createHash('sha256');
    for (const f of readdirSync(FIXTURES_DIR).filter((n) => n.endsWith('.json')).sort()) {
      h.update(f).update('\0').update(readFileSync(join(FIXTURES_DIR, f)));
    }
    return h.digest('hex');
  }
  const corpusBefore = fixtureCorpusDigest();
  afterAll(() => {
    expect(
      fixtureCorpusDigest(),
      'a CLI case mutated the committed fixture corpus — a refusal regressed and the ' +
        'run reached the live DescribeType path'
    ).toBe(corpusBefore);
  });

  it('rejects a near-miss --from-zip typo instead of falling through', () => {
    const r = run(['--from-zipX']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown flag(s): --from-zipX');
  });

  it('rejects an unrelated unknown flag', () => {
    // The STDERR assertion is load-bearing. With the guard deleted, `-x` does
    // not start with `--`, so it becomes the positional type filter, matches
    // no registered type, and `main` exits 1 anyway — a status-only assertion
    // passes for entirely the wrong reason and never touches the guard.
    const r = run(['-x']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown flag(s): -x');
  });

  it('refuses an EMPTY positional rather than falling through to a full refresh', () => {
    // `refresh.mjs "$TYPE"` with TYPE unset. Same fall-through payload as the
    // `--from-zipX` case: ~135 live DescribeType calls and a rewritten corpus.
    const r = run(['']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Empty argument');
  });

  it('rejects --from-zip= with an empty value rather than silently downloading', () => {
    const r = run(['--from-zip=']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("requires a path when the '=' form is used");
  });

  it('refuses --from-zip combined with a type filter', () => {
    const r = run(['--from-zip', 'AWS::Lambda::Function']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot be combined');
  });

  it('refuses --from-zip combined with --only-missing', () => {
    // Status-only would pass here on regression by performing a live bundle
    // download and then failing for some other reason; the message pins that
    // the REFUSAL is what happened.
    const r = run(['--from-zip', '--only-missing']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot be combined');
  });

  it('--help exits 0 and documents the zip mode', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--from-zip');
  });
});

describe('download and decompression bounds', () => {
  /**
   * Round 2 found these controls had NO test at all: deleting the cumulative
   * cap, the `content-length` pre-check, and `redirect: 'error'` each passed
   * the whole suite. They are the only thing standing between an
   * un-checksummable third-party artifact and an unattended monthly job, so
   * "present in the source" is not enough.
   */
  function resp(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from('x');
      })(),
      ...overrides,
    };
  }

  it('refuses a bundle whose declared content-length is over the cap', async () => {
    const fetchImpl = async () =>
      resp({ headers: { get: () => String(200 * 1024 * 1024) } }) as never;
    await expect(downloadSchemaBundle('http://x', fetchImpl)).rejects.toThrow(/declares .* over the/);
  });

  it('bounds a chunked body that declares NO content-length', async () => {
    // The case a post-hoc `arrayBuffer()` check cannot catch: with no declared
    // length there is nothing to pre-check, so the bound must be enforced as
    // the bytes arrive or the runner is exhausted first.
    let emitted = 0;
    const fetchImpl = async () =>
      resp({
        headers: { get: () => null },
        body: (async function* () {
          for (;;) {
            emitted += 1;
            yield Buffer.alloc(8 * 1024 * 1024, 0x61);
          }
        })(),
      }) as never;
    await expect(downloadSchemaBundle('http://x', fetchImpl)).rejects.toThrow(/mid-download/);
    // Bounded, not merely rejected after consuming everything.
    expect(emitted).toBeLessThan(20);
  });

  it('accepts a small well-formed body', async () => {
    const fetchImpl = async () => resp() as never;
    expect((await downloadSchemaBundle('http://x', fetchImpl)).toString()).toBe('x');
  });

  it('names the redirect refusal, and keeps the cause that distinguishes it', async () => {
    // `fetch` reports a refused redirect AND an ordinary DNS/TCP failure as the
    // same bare `TypeError: fetch failed`; only `cause` tells them apart, so
    // dropping it made the wrapper misdirect on a network blip.
    const fetchImpl = async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('unexpected redirect'),
      });
    };
    await expect(downloadSchemaBundle('http://x', fetchImpl)).rejects.toThrow(
      /redirect is refused.*unexpected redirect/s
    );
  });

  it('actually passes redirect: "error" to fetch', async () => {
    // Every other mock here ignores `init`, so deleting `redirect: 'error'`
    // from the source passed the whole suite while the describe block claimed
    // the control was covered.
    let seen: Record<string, unknown> | undefined;
    const fetchImpl = async (_url: string, init?: Record<string, unknown>) => {
      seen = init;
      return resp() as never;
    };
    await downloadSchemaBundle('http://x', fetchImpl as never);
    expect(seen?.['redirect']).toBe('error');
  });

  it('refuses a non-ok response', async () => {
    const fetchImpl = async () => resp({ ok: false, status: 403, statusText: 'Forbidden' }) as never;
    await expect(downloadSchemaBundle('http://x', fetchImpl)).rejects.toThrow(/HTTP 403/);
  });

  it('refuses a zip whose entries expand past the cap, before extracting them', () => {
    // Many small entries, which is the real bomb shape — one huge entry is the
    // easy case. Built with genuinely compressible content so the ZIP stays
    // small while the declared uncompressed total is large.
    const zip = new AdmZip();
    for (let i = 0; i < 80; i++) {
      zip.addFile(`aws-test-t${i}.json`, Buffer.alloc(1024 * 1024, 0x61));
    }
    expect(() => readSchemaBundle(zip.toBuffer())).toThrow(/expands past the/);
  });

  /**
   * The case the cap alone CANNOT catch, and the reason the zero-size refusal
   * exists as its own arm.
   *
   * adm-zip passes `maxOutputLength: header.size` to `inflateRawSync` only
   * when that size is positive, so an entry declaring 0 inflates unbounded. A
   * previous revision tried to cover it by adding
   * `max(size, compressedSize)` to the running total — mathematically inert,
   * since the sum of all compressed sizes is bounded by the zip buffer, which
   * is already under the cap. Measured then: a `size=0` entry contributed 4 KB
   * while `getData()` materialized 4 MB.
   *
   * This fixture patches the CENTRAL directory (which is what adm-zip reads),
   * so it exercises the real shape rather than a synthetic one.
   */
  it('refuses an entry that declares ZERO uncompressed bytes for real compressed data', () => {
    const zip = new AdmZip();
    zip.addFile('aws-test-bomb.json', Buffer.alloc(1024 * 1024, 0x61));
    const buf = zip.toBuffer();

    // Locate the central-directory record and zero its uncompressed-size field
    // (CEN signature 0x02014b50; uncompressed size at offset 24).
    const CEN_SIG = 0x02014b50;
    let cen = -1;
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf.readUInt32LE(i) === CEN_SIG) {
        cen = i;
        break;
      }
    }
    expect(cen, 'no central-directory record found — fixture is wrong').toBeGreaterThanOrEqual(0);
    const compressed = buf.readUInt32LE(cen + 20);
    expect(compressed, 'the entry must carry real compressed data').toBeGreaterThan(0);
    buf.writeUInt32LE(0, cen + 24);

    expect(() => readSchemaBundle(buf)).toThrow(/declares 0 uncompressed bytes/);
  });

  /**
   * The central-directory parse is bounded ARITHMETICALLY by the byte cap
   * rather than by an entry-count check, and this pins that arithmetic.
   *
   * `new AdmZip(buffer)` builds an object per directory record before any
   * other check in the module runs, so a buffer that is nothing but records is
   * the cheapest attack on the runner. Measured 2026-09-07: 9,210-9,434 bytes
   * of heap per entry, against adm-zip's own 46-byte record divisor (it
   * refuses a declared count above `(len - offset) / 46` before allocating,
   * so the buffer size genuinely bounds the count).
   *
   * A hand-rolled EOCD ceiling was tried instead and deleted: two independent
   * reviews measured four bypasses (wrong field — `ENDTOT` vs the `ENDSUB`
   * adm-zip allocates from; wrong ZIP64 field; a `0xFFFF` gate adm-zip never
   * consults; highest-vs-lowest EOCD), and its test patched the one field
   * adm-zip ignores, so it was green while inert. This case cannot go inert
   * the same way: it asserts a relationship between two constants, with no
   * parsing involved.
   */
  it('keeps the worst-case directory parse survivable, so raising the cap is a security decision', () => {
    const MIN_CENTRAL_RECORD_BYTES = 46; // adm-zip's own divisor
    // 9,500 rather than my own 8,686: an independent measurement put the real
    // cost at 9,210-9,434 B/entry, so the test asserts the CONSERVATIVE end of
    // measured reality rather than my transcribed figure.
    const HEAP_BYTES_PER_ENTRY = 9500;
    const worstCaseHeapBytes =
      (MAX_DOWNLOAD_BYTES / MIN_CENTRAL_RECORD_BYTES) * HEAP_BYTES_PER_ENTRY;
    // 3 GB: under a runner's memory and under Node's default old-space, so the
    // run reaches MIN_ZIP_ENTRIES and is refused there rather than OOM-killed
    // mid-parse.
    expect(worstCaseHeapBytes).toBeLessThan(3 * 1024 * 1024 * 1024);
  });

  /**
   * The two budgets are SEPARATE, and each is asserted against the dimension it
   * actually governs. They were one constant, and lowering it to bound the
   * directory parse silently took the uncompressed bound below AWS's real
   * bundle — `readSchemaBundle` threw on the live artifact and the monthly job
   * would have failed every cycle.
   *
   * The fence that should have caught it did not, because it compared the cap
   * to the COMPRESSED size (2,989,693) while the failing check compares against
   * the UNCOMPRESSED total (13,991,910). Right constant, wrong dimension — so
   * both are pinned here, by name.
   */
  it('gives each budget headroom over the REAL bundle in its own dimension', () => {
    const REAL_COMPRESSED_BYTES = 2_989_693;
    const REAL_UNCOMPRESSED_BYTES = 13_991_910;
    expect(
      MAX_DOWNLOAD_BYTES,
      'the download cap must clear the real compressed bundle with headroom'
    ).toBeGreaterThan(2 * REAL_COMPRESSED_BYTES);
    expect(
      MAX_UNCOMPRESSED_BYTES,
      'the uncompressed cap must clear the real bundle EXPANDED — this is the ' +
        'dimension the accumulator in readSchemaBundle compares against'
    ).toBeGreaterThan(2 * REAL_UNCOMPRESSED_BYTES);
    // And they must stay distinct: collapsing them back into one constant is
    // exactly how the break happened.
    expect(MAX_UNCOMPRESSED_BYTES).toBeGreaterThan(MAX_DOWNLOAD_BYTES);
  });

  it('reads a normal bundle without tripping the cap', () => {
    const zip = new AdmZip();
    zip.addFile('aws-lambda-function.json', Buffer.from('{"properties":{}}'));
    expect(readSchemaBundle(zip.toBuffer()).size).toBe(1);
  });
});
