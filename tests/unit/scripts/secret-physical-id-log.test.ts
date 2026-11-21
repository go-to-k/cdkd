/**
 * `scripts/check-secret-physical-id-log.ts` (go-to-k/cdkd#6716). The real-tree
 * case IS the enforcement: a new engine or CLI line rendering a physical id
 * without `displayPhysicalId` fails it, and so does a readback key the schema
 * fixtures show can carry a resolved template value under a name the
 * redaction does not pair.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import {
  type Exemption,
  type RenderedRow,
  analyzeFiles,
  analyzeSource,
  checkAll,
  declaredStringList,
  judgeRenderedRows,
  judgeSites,
  renderedReadbackRows,
} from '../../../scripts/check-secret-physical-id-log.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.ts';
import {
  SECRET_PHYSICAL_ID_TYPES,
  displayPhysicalId,
  secretPhysicalIdSegment,
} from '../../../src/provisioning/secret-physical-id.js';
import {
  clearRecordedSecretExpressions,
  redactForState,
  scrubResourceRecord,
} from '../../../src/deployment/secret-redaction.js';
import { warnUnretriedReplacedDeletes } from '../../../src/deployment/deploy-engine/replacement/deferred-deletes.js';
import {
  type ReplacementDeps,
  ReplacementRunState,
} from '../../../src/deployment/deploy-engine/replacement/run-state.js';
import { SecretsRunState } from '../../../src/deployment/deploy-engine/masking.js';
import { splitCompositePhysicalId } from '../../../src/cli/commands/export/composite-id-splitters.js';
import { revertReplacementOf } from '../../../src/cli/commands/drift/revert-apply.js';
import { displacedPhysicalIdShown } from '../../../src/deployment/nested-child-journal.js';

const IMPORT =
  "import { displayPhysicalId, withSecretPhysicalIdMasked } from '../provisioning/secret-physical-id.js';\n";

const verdicts = (body: string): string[] =>
  analyzeSource(IMPORT + body).map((s) => `${s.verdict}:${s.text}`);

describe('check-secret-physical-id-log (go-to-k/cdkd#6716)', () => {
  it(
    'the real tree: every rendering site is masked and every readback row is paired',
    () => {
      const { failures, scan, rows } = checkAll();
      expect(failures).toEqual([]);
      // A floor per input shape the parser claims to handle.
      const masked = scan.sites.filter((s) => s.verdict === 'masked');
      expect(masked.some((s) => s.file.startsWith('src/deployment/'))).toBe(true);
      expect(masked.some((s) => s.file.startsWith('src/cli/'))).toBe(true);
      expect(rows.some((r) => r.kind === 's3-object')).toBe(true);
    },
    CONTENDED_CASE_TIMEOUT_MS
  );

  describe('part 1: sites', () => {
    it.each([
      // Raw: a property, an identifier, an alias, a message built beforehand.
      ['logger.info(`Deleting ${r.physicalId}`)', ['raw:r.physicalId']],
      ['function f(physicalId) { logger.warn(safeMsg`old (${physicalId})`); }', ['raw:physicalId']],
      ['const id = r.physicalId; logger.info(`x ${id}`)', ['raw:r.physicalId']],
      ['const line = `x ${r.oldPhysicalId}`; this.logger.warn(line)', ['raw:r.oldPhysicalId']],
      ['logger.info("x " + r["physicalId"])', ['raw:r["physicalId"]']],
      ['logger.info(`x ${mask(String(op.physicalId))}`)', ['raw:op.physicalId']],
      ['logger.info(`x ${describe(r.physicalId)}`)', ['raw:r.physicalId']],
      ['console.log(`x ${r.physicalId}`)', ['raw:r.physicalId']],
      ['process.stdout.write(`x ${r.physicalId}\\n`)', ['raw:r.physicalId']],
      ['getLogger().debug(`x ${r.PhysicalResourceId}`)', ['raw:r.PhysicalResourceId']],
      // A literal type masks nothing.
      ['logger.info(`x ${displayPhysicalId(undefined, r.physicalId)}`)', ['raw:r.physicalId']],
      ["logger.info(`x ${displayPhysicalId('AWS::S3::Bucket', r.physicalId)}`)", ['raw:r.physicalId']],
      // The type argument does not mask the id it is not handed.
      ['logger.info(`x ${displayPhysicalId(r.physicalId, t)}`)', ['raw:r.physicalId']],
      // Masked.
      ['logger.info(`x ${displayPhysicalId(r.resourceType, r.physicalId)}`)', ['masked:r.physicalId']],
      [
        'logger.info(`x ${mask(String(displayPhysicalId(op.resourceType, op.physicalId)))}`)',
        ['masked:op.physicalId'],
      ],
      [
        'const shown = displayPhysicalId(t, r.physicalId); logger.info(`x ${shown}`)',
        ['masked:r.physicalId'],
      ],
      ['logger.info(`x ${withSecretPhysicalIdMasked(r).physicalId}`)', ['masked:withSecretPhysicalIdMasked(r).physicalId']],
      // Not a render: tested, counted, or not a sink.
      ['logger.info(`x ${r.physicalId === undefined ? "none" : "some"}`)', []],
      ['logger.info(`x ${r.physicalId.length}`)', []],
      ['logger.info(`x ${typeof r.physicalId}`)', []],
      // An error's message is a sink; its other arguments are fields.
      ['throw new Error(`x ${r.physicalId}`)', ['raw:r.physicalId']],
      ['throw new ProvisioningError(`x ${r.logicalId}`, r.resourceType, r.logicalId, r.physicalId)', []],
      // Not a sink, but prose all the same.
      ['throw new Thing(`x ${r.physicalId}`)', ['raw:r.physicalId']],
      ['throw new Thing(r.physicalId)', []],
      ['logger.info(`x ${r.logicalId}`)', []],
      // A logger renders an object argument's values too.
      ['logger.info(`x ${count}`, { physicalId: r.physicalId })', ['raw:r.physicalId']],
      ['function f(physicalId) { logger.info("x", { physicalId }); }', ['raw:physicalId']],
      ['this.log.warn(`x ${r.physicalId}`)', ['raw:r.physicalId']],
      // The id under another name.
      ['const { physicalId: id } = r; logger.info(`x ${id}`)', ['raw:id']],
      // Prose wherever it goes: a stored message, a callback, a helper's return.
      ['skips.set(k, `the old id ${r.physicalId} was not deleted`)', ['raw:r.physicalId']],
      ['const ids = xs.map((e) => `${e.logicalId} (${e.physicalId})`).join(", ")', ['raw:e.physicalId']],
      ['function f(r) { return "the old id " + r.physicalId; }', ['raw:r.physicalId']],
      ['const m = `State records ` + `(${r.physicalId}).`', ['raw:r.physicalId']],
      // A `.map` callback inside a root renders what it returns.
      ['logger.warn(`left: ${xs.map((x) => x.physicalId).join(", ")}`)', ['raw:x.physicalId']],
      [
        'logger.warn(`left: ${xs.map((x) => displayPhysicalId(x.resourceType, x.physicalId)).join(", ")}`)',
        ['masked:x.physicalId'],
      ],
      // A key or needle is compared, never shown.
      ['if (e.message.includes(`${r.physicalId} does not exist`)) return;', []],
      // A Set's `add` stores a value that is listed later: prose.
      ['notes.add(`old id ${r.physicalId} kept`)', ['raw:r.physicalId']],
      // A key method's receiver is only tested.
      ["logger.warn(`has pipe: ${r.physicalId.includes('|')}`)", []],
      ['skips.set(`key ${r.physicalId} x`, `the old id ${r.physicalId} was kept`)', ['raw:r.physicalId']],
      // A display helper the tree declares renders what it returns.
      [
        'function shownId(op) { return displaySafe(op.physicalId); }\nlogger.info(`id ${shownId(op)}`)',
        ['raw:op.physicalId'],
      ],
      [
        'function shownId(op) { return displaySafe(displayPhysicalId(op.resourceType, op.physicalId)); }\nlogger.info(`id ${shownId(op)}`)',
        ['masked:op.physicalId'],
      ],
      // ...through a `?:` arm, a `??` operand, or a local returned by name.
      [
        "function shownId(op) { return ok(op) ? displaySafe(op.physicalId) : 'described'; }\nlogger.info(`id ${shownId(op)}`)",
        ['raw:op.physicalId'],
      ],
      [
        "function shownId(op) { return displaySafe(op.physicalId) ?? 'described'; }\nlogger.info(`id ${shownId(op)}`)",
        ['raw:op.physicalId'],
      ],
      [
        'function shownId(op) { const s = displaySafe(op.physicalId); return s; }\nlogger.info(`id ${shownId(op)}`)',
        ['raw:op.physicalId'],
      ],
      // A helper returning a VALUE (a Ref, an ARN) is not a display helper.
      ['function refOf(r) { return cfnRef(r.physicalId); }\nconst v = refOf(r);', []],
      // Not prose: an ARN or a key has no space around the id.
      ['const arn = `arn:aws:sqs:${region}:${account}:${r.physicalId}`', []],
      ["const k = 'arn:' + r.physicalId", []],
      ['const m = safeMsg`old id ${r.physicalId} gone`', ['raw:r.physicalId']],
      ['this.log.warn(r.physicalId)', ['raw:r.physicalId']],
      // Each "only tested" arm on its own.
      ['logger.info(`x ${r.physicalId === y}`)', []],
      ["logger.info(`x ${r.physicalId ? 'a' : 'b'}`)", []],
      ["logger.info(`x ${r.physicalId && 'set'}`)", []],
      // A whole-record masker handed the record.
      ['logger.info(`x ${maskSecretSegmentsDeep(r.physicalId, s)}`)', ['raw:r.physicalId']],
      // An imported or declared FUNCTION whose name ends in PhysicalId is no id.
      ['function shownPhysicalId() { return 1; } logger.info(`x ${shownPhysicalId}`)', []],
    ])('%s', (body, expected) => {
      expect(verdicts(body)).toEqual(expected);
    });

    it('a literal type masks only as a listed type inside the entry keyed by it', () => {
      const entry = (key: string, literal: string): string =>
        `const T = { '${key}': (physicalId) => { throw new Error(\`bad \${displayPhysicalId('${literal}', physicalId)}\`); } };`;
      expect(verdicts(entry('AWS::AppSync::ApiKey', 'AWS::AppSync::ApiKey'))).toEqual([
        'masked:physicalId',
      ]);
      // A listed literal outside its own entry names a type the id may not have.
      expect(
        verdicts(
          "function f(physicalId) { logger.info(`x ${displayPhysicalId('AWS::AppSync::ApiKey', physicalId)}`); }"
        )
      ).toEqual(['raw:physicalId']);
      expect(verdicts(entry('AWS::EC2::Route', 'AWS::AppSync::ApiKey'))).toEqual([
        'non-secret-type:physicalId',
      ]);
      expect(
        analyzeSource(entry('AWS::AppSync::ApiKey', 'AWS::SQS::Queue')).map((x) => x.verdict)
      ).toEqual(['raw']);
    });

    it('a rendered parameter is judged at its callers', () => {
      const helper = 'function line(physicalId) { return `deleted ${physicalId}`; }\n';
      expect(
        verdicts(helper + 'logger.info(line(displayPhysicalId(r.resourceType, r.physicalId)))')
      ).toEqual(['masked:physicalId', 'masked:r.physicalId']);
      // A raw caller makes the parameter raw too, so an exemption at the call
      // cannot vouch for the function.
      expect(verdicts(helper + 'logger.info(line(r.physicalId))')).toEqual([
        'raw:physicalId',
        'raw:r.physicalId',
      ]);
      // Outside any sink, only the caller arm sees the raw argument.
      expect(verdicts(helper + 'const s = line(r.physicalId);')).toEqual([
        'raw:physicalId',
        'raw:r.physicalId',
      ]);
      // A caller handing a value that is not visibly an id, and not masked.
      expect(verdicts(helper + 'const x = pick(r); logger.info(line(x))')).toEqual([
        'raw:physicalId',
        'raw:x',
      ]);
      // A literal is no id.
      expect(verdicts(helper + "logger.info(line('none'))")).toEqual(['masked:physicalId']);
      // A FIXPOINT: a caller forwarding its own parameter defers to its callers.
      const twoLevels =
        helper +
        'function g(p) { return line(p); }\n' +
        'logger.info(g(displayPhysicalId(r.resourceType, r.physicalId)))';
      expect(verdicts(twoLevels).filter((v) => v.startsWith('raw'))).toEqual([]);
      const forwardedRaw = verdicts(
        helper + 'function g(p) { return line(p); }\nconst s = g(r.physicalId);'
      );
      // The root call, the forwarding position, and the inner parameter.
      expect(forwardedRaw).toEqual(['raw:physicalId', 'raw:p', 'raw:r.physicalId']);
      // A parameter spliced into the argument is forwarded too.
      const spliced = (arg: string): string[] =>
        verdicts(helper + 'function g(p) { return line(`x ${p}`); }\n' + `const s = g(${arg});`);
      expect(spliced('displayPhysicalId(r.resourceType, r.physicalId)')).toEqual([
        'masked:physicalId',
        'masked:p',
        'masked:r.physicalId',
      ]);
      expect(spliced('r.physicalId')).toEqual(['raw:physicalId', 'raw:p', 'raw:r.physicalId']);
      // An id-named parameter spliced in is forwarded through the found arm.
      const splicedId = (arg: string): string[] =>
        verdicts(
          helper +
            'function g(physicalId) { return line(`x ${physicalId}`); }\n' +
            `const s = g(${arg});`
        );
      expect(splicedId('displayPhysicalId(r.resourceType, r.physicalId)')).toEqual([
        'masked:physicalId',
        'masked:physicalId',
        'masked:r.physicalId',
      ]);
      expect(splicedId('r.physicalId')).toEqual([
        'raw:physicalId',
        'raw:physicalId',
        'raw:r.physicalId',
      ]);
      // A cycle of forwards with no outside caller vouches for nothing.
      const recursive =
        'function f(logger, physicalId, n) { logger.warn(`old id ${physicalId}`); f(logger, physicalId, n - 1); }';
      expect(verdicts(recursive)).toEqual(['raw:physicalId', 'raw:physicalId']);
      expect(
        verdicts(
          'function a(physicalId) { b(physicalId); return `old id ${physicalId}`; }\n' +
            'function b(x) { a(x); }'
        )
      ).toEqual(['raw:physicalId', 'raw:x', 'raw:physicalId']);
      // ...and one outside masked caller makes the recursive helper safe.
      expect(
        verdicts(
          recursive + '\nf(log, displayPhysicalId(r.resourceType, r.physicalId), 3);'
        ).filter((v) => v.startsWith('raw'))
      ).toEqual([]);
      // An arrow `const` and a method are named functions too.
      expect(
        verdicts(
          'const line = (physicalId) => `deleted ${physicalId}`;\n' +
            'logger.info(line(displayPhysicalId(r.resourceType, r.physicalId)))'
        )
      ).toEqual(['masked:physicalId', 'masked:r.physicalId']);
      // No caller found: the parameter stays raw, through a local alias too.
      expect(verdicts(helper)).toEqual(['raw:physicalId']);
      expect(
        verdicts('function g(physicalId) { const s = physicalId; return `deleted ${s}`; }')
      ).toEqual(['raw:physicalId']);
      // Across files, by name, only where the caller's file imports the name.
      const across = (callerText: string): string[] =>
        analyzeFiles([
          { text: IMPORT + helper, fileName: 'a.ts' },
          { text: callerText, fileName: 'b.ts' },
        ]).map((x) => `${x.file}:${x.verdict}`);
      expect(across("import { line } from './a.js';\nlogger.info(line(r.physicalId))")).toEqual([
        'a.ts:raw',
        'b.ts:raw',
      ]);
      expect(
        across(
          IMPORT +
            "import { line } from './a.js';\nlogger.info(line(displayPhysicalId(r.resourceType, r.physicalId)))"
        )
      ).toEqual(['a.ts:masked', 'b.ts:masked']);
      // A same-named local function elsewhere vouches for nothing.
      expect(across('function line(x) { return x; }\nline(1);')).toEqual(['a.ts:raw']);
      // Nor does a file that neither imports nor declares the name.
      expect(
        across(IMPORT + 'logger.info(line(displayPhysicalId(r.resourceType, r.physicalId)))')
      ).toEqual(['a.ts:raw', 'b.ts:masked']);
      // A method call reaches a method of that name, in another file too.
      expect(
        analyzeFiles([
          {
            text: IMPORT + 'export const o = { line(physicalId) { return `deleted ${physicalId}`; } };',
            fileName: 'a.ts',
          },
          {
            text: IMPORT + 'logger.info(o.line(displayPhysicalId(r.resourceType, r.physicalId)))',
            fileName: 'b.ts',
          },
        ]).map((x) => `${x.file}:${x.verdict}`)
      ).toEqual(['a.ts:masked', 'b.ts:masked']);
      const method = 'const o = { line(physicalId) { return `deleted ${physicalId}`; } };\n';
      expect(
        verdicts(method + 'logger.info(o.line(displayPhysicalId(r.resourceType, r.physicalId)))')
      ).toEqual(['masked:physicalId', 'masked:r.physicalId']);
      expect(verdicts(method + 'const s = o.line(r.physicalId);')).toEqual([
        'raw:physicalId',
        'raw:r.physicalId',
      ]);
    });

    it('a per-type table entry renders its own type: raw only when that type is listed', () => {
      const table = (type: string): string =>
        `const T = { '${type}': (physicalId) => { throw new Error(\`bad \${physicalId}\`); } };`;
      expect(verdicts(table('AWS::EC2::Route'))).toEqual(['non-secret-type:physicalId']);
      expect(verdicts(table('AWS::AppSync::ApiKey'))).toEqual(['raw:physicalId']);
      // The list is read, not hardcoded: a type joining it turns its entry raw.
      expect(
        analyzeSource(table('AWS::EC2::Route'), 'x.ts', new Set(['AWS::EC2::Route'])).map(
          (x) => x.verdict
        )
      ).toEqual(['raw']);
      // A key that is not a CloudFormation type name proves nothing.
      expect(verdicts(table('route'))).toEqual(['raw:physicalId']);
    });

    it('follows an import alias of displayPhysicalId, and refuses an unrelated same-named callee', () => {
      const aliased =
        "import { displayPhysicalId as show } from '../provisioning/secret-physical-id.js';\n" +
        'logger.info(`x ${show(r.resourceType, r.physicalId)}`)';
      expect(analyzeSource(aliased).map((s) => s.verdict)).toEqual(['masked']);
      const unrelated = 'logger.info(`x ${show(r.resourceType, r.physicalId)}`)';
      expect(analyzeSource(unrelated).map((s) => s.verdict)).toEqual(['raw']);
      // The right NAME from the wrong place masks nothing.
      const local =
        'const displayPhysicalId = (t, id) => id;\n' +
        'logger.info(`x ${displayPhysicalId(r.resourceType, r.physicalId)}`)';
      expect(analyzeSource(local).map((s) => s.verdict)).toEqual(['raw']);
      const elsewhere =
        "import { displayPhysicalId } from './somewhere-else.js';\n" +
        'logger.info(`x ${displayPhysicalId(r.resourceType, r.physicalId)}`)';
      expect(analyzeSource(elsewhere).map((s) => s.verdict)).toEqual(['raw']);
    });

    it('refuses a file that does not parse instead of reading it as clean', () => {
      expect(() => analyzeSource('function f( {\nlogger.info(`${r.physicalId}`)')).toThrow(
        /does not parse/
      );
    });

    it('an exemption must match its function count exactly, in both directions', () => {
      const sites = analyzeSource(
        'function f(r) { logger.info(`a ${r.physicalId}`); logger.info(`b ${r.physicalId}`); }',
        'src/x.ts'
      );
      const exempt = (count: number): Exemption[] => [
        { file: 'src/x.ts', fn: 'f', count, reason: 'test' },
      ];
      expect(judgeSites(sites, exempt(2))).toEqual([]);
      expect(judgeSites(sites, exempt(1))).toHaveLength(2);
      expect(judgeSites(sites, [])).toHaveLength(2);
      expect(judgeSites([], exempt(1))).toEqual([expect.stringContaining('matches no raw site')]);
    });
  });

  describe('part 2: readback keys', () => {
    beforeEach(() => clearRecordedSecretExpressions());
    afterEach(() => clearRecordedSecretExpressions());

    const rows = renderedReadbackRows();

    it('derives the Step Functions rows from the schema fixtures', () => {
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            resourceType: 'AWS::StepFunctions::StateMachine',
            renderedKey: 'Definition',
            sourceKey: 'DefinitionSubstitutions',
            kind: 'template-value',
          },
          {
            resourceType: 'AWS::StepFunctions::StateMachine',
            renderedKey: 'Definition',
            sourceKey: 'DefinitionString',
            kind: 'template-value',
          },
          {
            resourceType: 'AWS::ApiGateway::RestApi',
            renderedKey: 'Body',
            sourceKey: 'BodyS3Location',
            kind: 's3-object',
          },
        ])
      );
    });

    it('fails a template-value row whose keys the redaction does not pair', () => {
      const row: RenderedRow = {
        resourceType: 'AWS::X::Y',
        renderedKey: 'Template',
        sourceKey: 'TemplateString',
        kind: 'template-value',
      };
      expect(judgeRenderedRows([row], ['Definition'], ['DefinitionString'])).toHaveLength(1);
      // Each key on its own: pairing one half is not pairing the row.
      expect(judgeRenderedRows([row], ['Template'], [])).toHaveLength(1);
      expect(judgeRenderedRows([row], [], ['TemplateString'])).toHaveLength(1);
      expect(judgeRenderedRows([row], ['Template'], ['TemplateString'])).toEqual([]);
      expect(judgeRenderedRows([{ ...row, kind: 's3-object' }], [], [])).toEqual([]);
    });

    it('reads the redaction key lists as string lists', () => {
      const text = 'const A = [\'x\', \'y\'];\nexport const B: ReadonlySet<string> = new Set([\'z\']);';
      expect(declaredStringList(text, 'A')).toEqual(['x', 'y']);
      expect(declaredStringList(text, 'B')).toEqual(['z']);
      expect(declaredStringList(text, 'C')).toBeUndefined();
    });

    const EXPR = '{{resolve:secretsmanager:app/api:SecretString:key}}';
    const PLAIN = 'sk-live-resolved-readback-secret';
    const templateRows = rows.filter((r) => r.kind === 'template-value');

    /** A record holding the secret in `sourceKey`, read back rendered under `renderedKey`. */
    const shapes = (row: RenderedRow): { props: Record<string, unknown>; bag: Record<string, unknown> } => {
      const stem = row.renderedKey;
      const props: Record<string, unknown> = row.sourceKey.endsWith('Substitutions')
        ? { [`${stem}String`]: JSON.stringify({ Auth: '${k}' }), [row.sourceKey]: { k: EXPR } }
        : { [row.sourceKey]: JSON.stringify({ Auth: EXPR }) };
      return { props, bag: { [stem]: { Auth: PLAIN } } };
    };

    it.each(templateRows.map((r) => [`${r.resourceType} ${r.sourceKey} -> ${r.renderedKey}`, r] as const))(
      'never persists the resolved value: %s',
      (_name, row) => {
        const { props, bag } = shapes(row);
        const refreshed = redactForState(bag, {
          provenance: 'state-baseline',
          secrets: new Map<string, string>(),
          source: props,
        });
        expect(JSON.stringify(refreshed)).not.toContain(PLAIN);
        const scrubbed = scrubResourceRecord(
          { properties: props, observedProperties: bag },
          new Map<string, string>(),
          undefined,
          undefined,
          { observed: 'same-generation' }
        );
        expect(JSON.stringify(scrubbed)).not.toContain(PLAIN);
      }
    );
  });

  describe('runtime twin: an engine line with no bag holding the key', () => {
    // The critic checks shape; this proves a fixed site masks at runtime with
    // nothing bound (an empty registry), so only `displayPhysicalId` can.
    it('the unretried replaced-delete warning masks an ApiKey and a signal URL, and keeps a plain id', () => {
      const lines: string[] = [];
      const push = (m: string): void => {
        lines.push(m);
      };
      const run = new ReplacementRunState();
      run.deferredReplacedDeletes = new Map([
        [
          'Key',
          {
            physicalId: 'abcapi123|da2-thesecretapikeyvalue',
            resourceType: 'AWS::AppSync::ApiKey',
            provisionedBy: 'sdk',
            failureMessage: 'boom',
            retry: async () => {},
          },
        ],
        [
          'Handle',
          {
            physicalId: 'https://bucket.s3.amazonaws.com/x?X-Amz-Signature=thesignaturevalue',
            resourceType: 'AWS::CloudFormation::WaitConditionHandle',
            provisionedBy: 'sdk',
            failureMessage: undefined,
            retry: async () => {},
          },
        ],
        [
          'Queue',
          {
            physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/plain-queue',
            resourceType: 'AWS::SQS::Queue',
            provisionedBy: 'sdk',
            failureMessage: 'boom',
            retry: async () => {},
          },
        ],
      ]);
      const secrets = new SecretsRunState();
      const deps = {
        logger: { debug: push, info: push, warn: push, error: push },
        secretsRun: () => secrets,
      } as unknown as ReplacementDeps;
      warnUnretriedReplacedDeletes(run, deps, 'failed');
      const text = lines.join('\n');
      expect(lines).toHaveLength(3);
      expect(text).not.toContain('da2-thesecretapikeyvalue');
      expect(text).not.toContain('thesignaturevalue');
      expect(text).toContain('abcapi123|****alue');
      expect(text).toContain('plain-queue');
    });
  });

  describe('runtime twin: a displaced journal op', () => {
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    it('masks an API key and a signal URL with no derived name to mask them, and keeps a plain id', () => {
      const shown = (resourceType: string, physicalId: string): string | undefined =>
        displacedPhysicalIdShown(
          { logicalId: 'X', resourceType, physicalId },
          logger as unknown as Parameters<typeof displacedPhysicalIdShown>[1]
        );
      const key = shown('AWS::AppSync::ApiKey', 'apiid123|da2-thesecretapikey0123');
      expect(key).not.toContain('thesecretapikey');
      expect(key).toBe('apiid123|****0123');
      expect(
        shown('AWS::CloudFormation::WaitConditionHandle', 'https://b.s3.amazonaws.com/k?X-Amz-Signature=sig1234567')
      ).not.toContain('sig1234567');
      expect(shown('AWS::SQS::Queue', 'https://sqs/q')).toBe('https://sqs/q');
    });
    it("names a replacement's old id by the OLD record's type", () => {
      const text = displacedPhysicalIdShown(
        {
          logicalId: 'X',
          resourceType: 'AWS::SQS::Queue',
          previousState: { resourceType: 'AWS::AppSync::ApiKey', physicalId: 'apiid123|da2-oldkeyvalue9876' },
        },
        logger as unknown as Parameters<typeof displacedPhysicalIdShown>[1],
        'apiid123|da2-oldkeyvalue9876',
        'AWS::AppSync::ApiKey'
      );
      expect(text).toBe('apiid123|****9876');
    });
  });

  describe('runtime twin: a drift revert that replaced an API key', () => {
    it('names both ids masked, and still tells a replacement from none', () => {
      const old = 'abcapi123|da2-theoldsecretkeyvalue';
      const text = revertReplacementOf(
        old,
        { physicalId: 'abcapi123|da2-thenewsecretkeyvalue', wasReplaced: true },
        'AWS::AppSync::ApiKey'
      );
      expect(text).toBeDefined();
      expect(text).not.toContain('theoldsecretkeyvalue');
      expect(text).not.toContain('thenewsecretkeyvalue');
      expect(text).toContain('abcapi123|****alue');
      expect(
        revertReplacementOf(old, { physicalId: old, wasReplaced: false }, 'AWS::AppSync::ApiKey')
      ).toBeUndefined();
    });
  });

  describe('runtime twin: an export refusal of a malformed API key id', () => {
    it.each([
      ['three segments', 'abcapi123|da2-thesecretapikeyvalue|extra'],
      ['an empty segment', ' |da2-thesecretapikeyvalue'],
      ['an ARN of another resource', 'arn:aws:appsync:us-east-1:123456789012:apis/x/da2-thesecretapikeyvalue'],
    ])('%s: the message never carries the key', (_name, id) => {
      let message = '';
      try {
        splitCompositePhysicalId('AWS::AppSync::ApiKey', id);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('thesecretapikeyvalue');
    });
  });

  describe('the secret physical id list', () => {
    const schemaTypes = readdirSync(join(import.meta.dirname, '../../fixtures/cfn-schemas'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map(
        (f) =>
          (
            JSON.parse(
              readFileSync(join(import.meta.dirname, '../../fixtures/cfn-schemas', f), 'utf8')
            ) as { resourceType: string }
          ).resourceType
      );
    const SAMPLES = [
      'abc123|def456ghi',
      'https://example.com/path?X-Amz-Signature=abcdef123456',
      'arn:aws:appsync:us-east-1:123456789012:apis/abc123/apikeys/da2-secretkey',
      'plain-id',
    ];

    it('a type declares a secret segment exactly when it is listed', () => {
      expect(schemaTypes.length).toBeGreaterThan(100);
      for (const type of new Set([...schemaTypes, ...SECRET_PHYSICAL_ID_TYPES])) {
        const declares = SAMPLES.some((id) => secretPhysicalIdSegment(type, id) !== undefined);
        expect({ type, declares }).toEqual({ type, declares: SECRET_PHYSICAL_ID_TYPES.has(type) });
      }
    });

    it('every type the function branches on is listed, and the reverse', () => {
      // The list gates the function, so a branch for an unlisted type is dead:
      // read the branches off the source instead of calling past the gate.
      const text = readFileSync(
        join(import.meta.dirname, '../../../src/provisioning/secret-physical-id.ts'),
        'utf8'
      );
      const body = text.slice(text.indexOf('export function secretPhysicalIdSegment('));
      const fnText = body.slice(0, body.indexOf('\n}\n'));
      const branched = new Set(
        [...fnText.matchAll(/resourceType [!=]== ['"`](AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)['"`]/g)].map((m) => m[1]!)
      );
      expect(branched.size).toBeGreaterThan(0);
      expect([...branched].sort()).toEqual([...SECRET_PHYSICAL_ID_TYPES].sort());
    });

    it('displayPhysicalId leaves every unlisted type unchanged', () => {
      for (const type of schemaTypes.filter((t) => !SECRET_PHYSICAL_ID_TYPES.has(t))) {
        for (const id of SAMPLES) expect(displayPhysicalId(type, id)).toBe(id);
      }
    });
  });
});
