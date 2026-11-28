/**
 * go-to-k/cdkd#7151: the shapes the #7061 schema invariant
 * (`schema-redaction-invariant-7061.test.ts`) does not claim, over the same
 * generated population (`schema-redaction-cases.ts`: every write-only,
 * secret-named and map-value path of every registry type).
 *
 * The values come from the REAL resolver (`IntrinsicFunctionResolver`), which
 * records the pass's secrets as a deploy does: an `ssm-secure` reference, and a
 * `NoEcho` parameter by `Ref`, whole or embedded in an `Fn::Join`.
 *
 * Each item of the issue, and how it is claimed:
 * 1. A `NoEcho` value EMBEDDED in text (`noecho-embedded`).
 * 2. A `NoEcho` value under the needle floor (`subfloor`, `subfloor-embedded`).
 * 3. The arm with NO template bag: an unchanged resource, re-persisted from
 *    the record the first persist wrote, its readback fresh.
 * 5. Map values (the population's `<key>` paths), and a map KEY spelling a
 *    reference: the resolver keeps a key as the template spells it
 *    (`intrinsic-function-resolver.ts`, "recursively resolve object
 *    properties"), so the key the record holds is template text.
 * 6. The other writers' call shapes: `cdkd scrub`'s stack rewrite (positioned,
 *    `state-cross-generation`) and its migration pass, the deploy journal's
 *    `previousState` (`redactOperationsForJournal`, `state-readback`), the
 *    rollback restore (`redactRollbackRecord`) and the rollback's observed
 *    refresh.
 * 7. Two references resolving to the SAME plaintext at two paths (`twin`).
 * 8. The whole persist pipeline: `redactStateForPersist`, the scrub choke
 *    point and then `applyNoEchoPersist`.
 *
 * Seeded as in the #7061 invariant: the value at the path in `properties` and
 * `observedProperties`, echoed as an attribute, and by the readback under a
 * key the template lacks. Asserted: no plaintext reaches the record, and an
 * unchanged redeploy plans no change. A known gap is listed in {@link GAPS}
 * with its filed issue. Each holds only with that readback echo, except
 * #7154 on a list path, and every writer is asserted clean without it (the
 * attribute echo kept).
 *
 * NOT claimed (a design limit, not a case): a value under the needle floor
 * (one to three characters) echoed WHOLE at a position the template does not
 * give it — an attribute of another name, a readback key the template lacks.
 * Such a value is no needle: any short text matches unrelated values, so it is
 * masked by position only (`recordNoEchoParameterFreshValue`, "the positional
 * arm covers it"; `noEchoAttributeNamesFor`). The `subfloor` form seeds no such
 * copy; `subfloor-embedded` seeds them, since the leaf it embeds in is a
 * string of needle length.
 *
 * Item 4 (the reader fence's limits) is claimed in
 * `tests/unit/scripts/recorded-secrecy-readers-7061.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  markSameGenerationBag,
  redactForState,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { markWrittenFromDeployedTemplate } from '../../../src/deployment/masked-property-fingerprints.js';
import { noEchoComparisonForTemplate } from '../../../src/deployment/deploy-engine/noecho.js';
import { redactOperationsForJournal } from '../../../src/deployment/deploy-engine/rollback/adopt-orphans.js';
import { redactRollbackRecord } from '../../../src/deployment/rollback-executor/replay-secrets.js';
import { maskRestoredNoEchoRecord } from '../../../src/deployment/rollback-executor/replay-noecho.js';
import { withRefreshedObservedBaseline } from '../../../src/deployment/rollback-executor/replay-observed-refresh.js';
import { applyScrubNoEcho, planScrubNoEcho, scrubMigrationNeedles } from '../../../src/cli/commands/scrub/noecho.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';
import { at, casesOf, MAP_KEY, PLACED_MAP_KEY, placed, type Case } from './schema-redaction-cases.js';

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...child, child: () => child }) };
});
/** The `ssm-secure` value each `GetParameter` returns, by name. */
const ssmValues = new Map<string, string>();
const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: ssmSend },
  }),
}));

const TYPE_ID = 'R';
type Form =
  | 'whole'
  | 'embedded'
  | 'noecho'
  | 'noecho-embedded'
  | 'subfloor'
  | 'subfloor-embedded'
  | 'twin';
const FORMS: readonly Form[] = ['whole', 'embedded', 'noecho', 'noecho-embedded', 'subfloor', 'subfloor-embedded', 'twin'];
const isNoEcho = (form: Form): boolean => form.startsWith('noecho') || form.startsWith('subfloor');
const isEmbedded = (form: Form): boolean => form.endsWith('embedded');
/** The second path of a `twin` case: a top-level key no registry path spells. */
const TWIN_KEY = 'Twin7151';

interface Seeded {
  readonly plaintext: string;
  readonly template: CloudFormationTemplate;
  readonly source: Record<string, unknown>;
  readonly resolved: Record<string, unknown>;
  readonly secrets: RecordedSecretValues;
  readonly parameters: Record<string, string>;
}

/** The case's template bag, resolved by the real resolver into a fresh pass bag. */
async function seeded(c: Case, index: number, form: Form): Promise<Seeded> {
  // A sub-floor value is three characters, never in any other text the record holds.
  const plaintext = form.startsWith('subfloor') ? 'q7Z' : `inv7151-pl4intext-${index}-${form}`;
  const name = `/inv7151/${index}/${form}`;
  ssmValues.set(name, plaintext);
  ssmValues.set(`${name}/twin`, plaintext);
  const reference = `{{resolve:ssm-secure:${name}}}`;
  const valueSource: unknown = isNoEcho(form)
    ? isEmbedded(form)
      ? { 'Fn::Join': ['', ['pre-', { Ref: 'SecretParam' }, '-post']] }
      : { Ref: 'SecretParam' }
    : form === 'embedded'
      ? `pre-${reference}-post`
      : reference;
  const source = placed(c.path, valueSource);
  if (form === 'twin') source[TWIN_KEY] = `{{resolve:ssm-secure:${name}/twin}}`;
  const template = {
    Parameters: { SecretParam: { Type: 'String', NoEcho: true } },
    Resources: { [TYPE_ID]: { Type: c.type, Properties: source } },
  } as unknown as CloudFormationTemplate;
  const secrets: RecordedSecretValues = new Map();
  const parameters = { SecretParam: plaintext };
  const context = { template, resources: {}, parameters, recordedSecretValues: secrets } as unknown as ResolverContext;
  const resolved = (await new IntrinsicFunctionResolver().resolve(source, context)) as Record<string, unknown>;
  return { plaintext, template, source, resolved, secrets, parameters };
}

/**
 * The record a provider call leaves in memory: the resolved bag, an attribute
 * echo, and a readback echoing the value under a key the template lacks too
 * (`echo`); `subfloor` seeds neither copy (header).
 */
function inMemoryRecord(c: Case, s: Seeded, form: Form, echo = true): ResourceState {
  const value = at(s.resolved, c.path);
  const echoes = form !== 'subfloor';
  return {
    physicalId: 'physical-7151',
    resourceType: c.type,
    properties: markWrittenFromDeployedTemplate(markSameGenerationBag({ ...s.resolved })),
    attributes: echoes ? { Echo: value } : {},
    observedProperties: markSameGenerationBag({ ...s.resolved, ...(echo && echoes && { ReadbackOnly7061: value }) }),
  };
}

function engineFor(s: Seeded | undefined, type: string): DeployEngine {
  const engine = new DeployEngine({} as never, {} as never, {} as never, {} as never, {} as never, { dryRun: false }, 'us-east-1');
  if (s !== undefined) {
    engine.secretsRun.perResourceTemplateProps.set(TYPE_ID, s.source);
    engine.secretsRun.perResourceResolvedType.set(TYPE_ID, type);
    engine.secretsRun.perResourceSecrets.set(TYPE_ID, s.secrets);
    engine.noEchoRun.constructPathTemplate = s.template;
  }
  return engine;
}

/** Item 8: the whole persist pipeline, `redactStateForPersist`. */
function persisted(engine: DeployEngine, record: ResourceState): ResourceState {
  const state: StackState = {
    version: 10,
    stackName: 's',
    region: 'us-east-1',
    resources: { [TYPE_ID]: record },
    outputs: {},
    lastModified: 0,
  };
  return (engine as unknown as { redactStateForPersist(s: StackState): StackState }).redactStateForPersist(state)
    .resources[TYPE_ID]!;
}

/** The diff's two sides for an unchanged redeploy, as the #7061 invariant computes them. */
function plansNoChange(c: Case, s: Seeded, form: Form, current: Record<string, unknown>): boolean {
  if (!isNoEcho(form)) return JSON.stringify(s.source) === JSON.stringify(current);
  const compare = noEchoComparisonForTemplate(s.template, undefined, s.parameters, {});
  const sides = compare?.({
    logicalId: TYPE_ID,
    resourceType: c.type,
    templateProperties: s.source,
    desired: s.resolved,
    current,
  }) ?? { desired: s.resolved, current };
  return JSON.stringify(sides.desired) === JSON.stringify(sides.current);
}

/** The problems a written record shows. */
/** The readback's key the template lacks, which {@link inMemoryRecord} seeds as an echo. */
const ECHO_KEY = 'ReadbackOnly7061';

/**
 * The problems a written record shows. A plaintext found ONLY under the
 * readback's echo key is its own problem, so a gap of that shape never absorbs
 * a plaintext anywhere else in the record.
 */
function problemsOf(record: unknown, s: Seeded): string[] {
  if (!JSON.stringify(record).includes(s.plaintext)) return [];
  const withoutEcho = JSON.stringify(record, (key, value: unknown) => (key === ECHO_KEY ? undefined : value));
  return [withoutEcho.includes(s.plaintext) ? 'plaintext persisted' : 'plaintext persisted only in the readback echo'];
}

type Writer = 'deploy-persist' | 'unchanged-persist' | 'scrub' | 'journal' | 'rollback-restore';
const WRITERS: readonly Writer[] = ['deploy-persist', 'unchanged-persist', 'scrub', 'journal', 'rollback-restore'];

/**
 * Each writer as its call site runs it, over the record it meets:
 * - `deploy-persist`: `redactStateForPersist` over the in-memory record;
 * - `unchanged-persist` (item 3): the next deploy's persist of that record,
 *   left unchanged, so it resolved nothing for it (no template bag, no
 *   secrets), with a fresh readback (`kickOffAutoRefreshObservedProperties`);
 * - `scrub`: `cdkd scrub` over a record an older binary wrote in plaintext,
 *   the redaction steps of `src/cli/commands/scrub/stack-rewrite.ts` (position
 *   against the template, `scrubResourceRecord` under `state-cross-generation`
 *   with `propertiesPositioned`, the `NoEcho` migration needles,
 *   `applyScrubNoEcho`); left out: `keepTemplateLiteralLeaves` and
 *   `keepHeldTokenProvenance`, which only KEEP leaves, and the public tokens
 *   (an empty set, so the migration needles are wider);
 * - `journal`: the deploy journal of a completed update
 *   (`redactOperationsForJournal`), its `properties` the resolved bag and its
 *   `previousState` the persisted record;
 * - `rollback-restore`: the rollback's in-place revert of that update, the
 *   redaction chain of `replay-failed.ts` (`withRefreshedObservedBaseline` over
 *   a fresh readback, `redactRollbackRecord` against the journaled bags,
 *   `maskRestoredNoEchoRecord` against the persisted record); left out:
 *   `recordAfterRollbackUpdate` / `withNameGenerationReached` (record shape,
 *   no redaction) and a revert's substituted `NoEcho` leaves (none here).
 */
async function written(
  writer: Writer,
  c: Case,
  s: Seeded,
  form: Form,
  echo = true
): Promise<{ record: unknown; properties?: Record<string, unknown> }> {
  const memory = inMemoryRecord(c, s, form, echo);
  const persistedRecord = (): ResourceState => persisted(engineFor(s, c.type), inMemoryRecord(c, s, form, echo));
  switch (writer) {
    case 'deploy-persist': {
      const out = persisted(engineFor(s, c.type), memory);
      return { record: out, properties: out.properties };
    }
    case 'unchanged-persist': {
      const first = persistedRecord();
      const engine = engineFor(undefined, c.type);
      engine.noEchoRun.constructPathTemplate = s.template;
      const out = persisted(engine, { ...first, observedProperties: memory.observedProperties });
      return { record: out, properties: out.properties };
    }
    case 'scrub': {
      const templateProps = new Map([[TYPE_ID, s.source]]);
      const plan = planScrubNoEcho(
        { version: 10, stackName: 's', region: 'us-east-1', resources: { [TYPE_ID]: memory }, outputs: {}, lastModified: 0 },
        s.template,
        templateProps,
        {}
      ).byLogicalId.get(TYPE_ID);
      const positioned = {
        ...memory,
        properties: redactForState(memory.properties, {
          provenance: 'template-sourced',
          secrets: s.secrets,
          source: s.source,
          generation: 'unproven',
        }) as Record<string, unknown>,
      };
      const walked = scrubResourceRecord(positioned, s.secrets, undefined, 'state-cross-generation', {
        properties: 'unproven',
        observed: 'unproven',
        propertiesPositioned: true,
      });
      const needles = scrubMigrationNeedles(plan, new Set());
      const migrated =
        needles === undefined
          ? walked
          : scrubResourceRecord(walked, needles, undefined, 'state-cross-generation', {
              properties: 'unproven',
              observed: 'unproven',
            });
      const out = applyScrubNoEcho(migrated, memory, plan);
      return { record: out, properties: out.properties };
    }
    case 'journal': {
      const [op] = redactOperationsForJournal(engineFor(s, c.type).rollbackDeps(), [
        {
          logicalId: TYPE_ID,
          resourceType: c.type,
          changeType: 'UPDATE',
          properties: markSameGenerationBag({ ...s.resolved }),
          previousState: persistedRecord(),
        } as never,
      ]);
      return { record: op };
    }
    case 'rollback-restore': {
      const baseline = persistedRecord();
      const provider = { readCurrentState: () => Promise.resolve({ ...memory.observedProperties }) };
      const refreshed = await withRefreshedObservedBaseline(
        { ...memory, observedProperties: baseline.observedProperties },
        {
          provider: provider as never,
          op: { logicalId: TYPE_ID, resourceType: c.type },
          desiredProps: s.resolved,
          restored: baseline,
          stateResources: { [TYPE_ID]: baseline },
          secrets: s.secrets,
          noEcho: { substituted: [] },
          mask: (text) => text,
          logger: { debug: () => undefined },
          inScope: (fn) => fn(),
          capture: true,
          publicTokens: new Set(),
        }
      );
      const out = maskRestoredNoEchoRecord(
        redactRollbackRecord(refreshed, s.secrets, new Set<string>(), baseline.properties, baseline.attributes),
        baseline
      );
      return { record: out, properties: out.properties };
    }
  }
}

/** The case paths a gap may absorb: a list item (a `*` segment), or any path. */
type GapShape = 'list' | 'any';
const PATH_SHAPES: Readonly<Record<GapShape, (path: readonly string[]) => boolean>> = {
  list: (path) => path.includes('*'),
  any: () => true,
};

/**
 * Known gaps, each filed, keyed `<writer> <form> <problem>` and bounded by the
 * case paths it may absorb (`shape`, measured): only a failure of that key on
 * such a path is absorbed, and a gap that no longer fails is itself a failure.
 * A plaintext gap absorbs only a plaintext found SOLELY under the readback's
 * echo key ({@link problemsOf}); without that echo every writer and form is
 * asserted clean, except #7154, which needs no echo (list paths only). The
 * #7152 / #7158 rows are gone: those writers and forms are asserted clean
 * with the echo too.
 */
const GAPS: Readonly<Record<string, { readonly issue: string; readonly shape: GapShape }>> = {
  // go-to-k/cdkd#7154: no plaintext; one spurious update after the scrub. Needs no echo.
  'scrub twin an unchanged redeploy plans a change': { issue: 'go-to-k/cdkd#7154 (two references, one plaintext, inside a list)', shape: 'list' },
};

interface Failure {
  readonly gap: string;
  readonly path: readonly string[];
  readonly detail: string;
}

/** Does a gap absorb `f`: its key, on a path of its shape? */
function absorbed(f: Failure): boolean {
  const gap = Object.hasOwn(GAPS, f.gap) ? GAPS[f.gap] : undefined;
  return gap !== undefined && PATH_SHAPES[gap.shape](f.path);
}

/** Every failure of `writer` over `cases`, keyed for {@link GAPS}. */
async function failuresOf(
  writer: Writer,
  cases: readonly Case[],
  echo: boolean,
  forms: readonly Form[] = FORMS
): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const [index, c] of cases.entries()) {
    for (const form of forms) {
      const s = await seeded(c, index, form);
      const { record, properties } = await written(writer, c, s, form, echo);
      const problems = problemsOf(record, s);
      if (properties !== undefined && !plansNoChange(c, s, form, properties)) problems.push('an unchanged redeploy plans a change');
      for (const problem of problems) {
        failures.push({ gap: `${writer} ${form} ${problem}`, path: c.path, detail: `${c.type} ${c.path.join('/')} ${form}: ${problem}` });
      }
    }
  }
  return failures;
}

describe('schema redaction invariant: the #7061 holes (go-to-k/cdkd#7151)', { timeout: CONTENDED_CASE_TIMEOUT_MS * 4 }, () => {
  const cases = casesOf();
  beforeEach(() => {
    ssmSend.mockReset();
    ssmSend.mockImplementation((command: { input: { Name: string } }) =>
      Promise.resolve({ Parameter: { Value: ssmValues.get(command.input.Name), Type: 'SecureString' } })
    );
  });

  it.each(WRITERS)('%s: no case and form persists the plaintext or plans a change', async (writer) => {
    const failures = await failuresOf(writer, cases, true);
    expect(failures.filter((f) => !absorbed(f)).map((f) => f.detail).slice(0, 20)).toEqual([]);
    // A gap of this writer that no longer fails is stale.
    const seen = new Set(failures.map((f) => f.gap));
    expect(Object.keys(GAPS).filter((gap) => gap.startsWith(`${writer} `) && !seen.has(gap))).toEqual([]);
  });

  it.each(WRITERS)('%s: without the readback echo under a key the template lacks, every case holds', async (writer) => {
    const failures = await failuresOf(writer, cases, false);
    // #7154 needs no echo: it is the scrub's list positioning, absorbed on a list path only.
    const needsNoEcho = (f: Failure): boolean => f.gap === 'scrub twin an unchanged redeploy plans a change' && absorbed(f);
    expect(failures.filter((f) => !needsNoEcho(f)).map((f) => f.detail).slice(0, 20)).toEqual([]);
  });

  it('probe: a gap absorbs only its key, on a path of its shape, and a plaintext only under the echo key', () => {
    const listGap = 'scrub twin an unchanged redeploy plans a change';
    expect(absorbed({ gap: listGap, path: ['Users', '*', 'Password'], detail: '' })).toBe(true);
    // The same key on a plain path or a map value is a leak outside the gap.
    expect(absorbed({ gap: listGap, path: ['Password'], detail: '' })).toBe(false);
    expect(absorbed({ gap: listGap, path: ['Env', MAP_KEY], detail: '' })).toBe(false);
    // A plaintext anywhere but the echo key is another problem, which no gap names.
    const s = { plaintext: 'pl-7151' } as Seeded;
    expect(problemsOf({ observedProperties: { [ECHO_KEY]: 'pl-7151' } }, s)).toEqual(['plaintext persisted only in the readback echo']);
    expect(problemsOf({ observedProperties: { [ECHO_KEY]: 'pl-7151', A: 'pl-7151' } }, s)).toEqual(['plaintext persisted']);
    expect(Object.keys(GAPS).some((gap) => gap.endsWith(' plaintext persisted'))).toBe(false);
  });

  it('a map KEY spelling a reference stays the template text, and its value is never fetched (item 5)', async () => {
    const maps = cases.filter((c) => c.shapes.includes('map-value'));
    expect(maps.length).toBeGreaterThanOrEqual(400);
    for (const [index, c] of maps.entries()) {
      const name = `/inv7151-key/${index}`;
      ssmValues.set(name, `inv7151-key-plaintext-${index}`);
      const keyReference = `{{resolve:ssm-secure:${name}}}`;
      // The map's last segment carries the reference as its KEY.
      const mapPath = c.path.slice(0, c.path.lastIndexOf(MAP_KEY));
      const source = placed(mapPath, { [keyReference]: 'plain-value-7151' });
      const secrets: RecordedSecretValues = new Map();
      const context = { template: { Resources: {} }, resources: {}, parameters: {}, recordedSecretValues: secrets } as unknown as ResolverContext;
      const resolved = (await new IntrinsicFunctionResolver().resolve(source, context)) as Record<string, unknown>;
      expect(at(resolved, mapPath)).toEqual({ [keyReference]: 'plain-value-7151' });
      expect(secrets.size).toBe(0);
    }
    expect(ssmSend).not.toHaveBeenCalled();
    // The placed map holds the case's value under `PLACED_MAP_KEY`, after a plain entry.
    expect(Object.keys(at(placed(maps[0]!.path, 'v'), maps[0]!.path.slice(0, maps[0]!.path.lastIndexOf(MAP_KEY))) as object)).toEqual(['PlainKey7151', PLACED_MAP_KEY]);
  });

  it('probe: a persist that skips the NoEcho arm fails on every NoEcho form under the needle floor', async () => {
    const sample = cases.slice(0, 10);
    for (const [index, c] of sample.entries()) {
      const s = await seeded(c, index, 'subfloor');
      // `scrubResourceRecord` alone, the choke point without `applyNoEchoPersist`.
      const scrubbedOnly = scrubResourceRecord(inMemoryRecord(c, s, 'subfloor'), s.secrets, s.source, undefined, {
        properties: 'same-generation',
        observed: 'same-generation',
      });
      expect(problemsOf(scrubbedOnly, s)).toEqual(['plaintext persisted']);
      expect(problemsOf((await written('deploy-persist', c, s, 'subfloor')).record, s)).toEqual([]);
    }
  });
});
