import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  buildCdkdStateStackTree,
  buildPerStackImportNodes,
  cdkd2cfnStackName,
  fsReadErrorCause,
  type CdkdStateStackTree,
} from '../../../src/cli/commands/export.js';
import { STACK_REF_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StackState } from '../../../src/types/state.js';
import { readAtKeyRegion } from '../_state-read-double.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

/**
 * go-to-k/cdkd#3950, `cdkd export`: its messages wrapped a stack name, a
 * logical id or a record value in a hand-written `'...'`, raw or through
 * `safeSegment`, which keeps `'`, `$`, `(` and a space. A `'` in the value
 * closed cdkd's quote, and pasting the sentence ran the rest as shell. Every
 * such site now goes through `quotedOrNotShown`: a plain value keeps its
 * quotes byte-identically, and any other reads `(not shown: it is not a plain
 * identifier)`.
 */

const NOT_SHOWN = '(not shown: it is not a plain identifier)';

/**
 * Every interpolation left inside a hand-written `'...'` / `"..."` in
 * `export.ts`'s CODE, with how many times it occurs and why it may stay. The
 * scan ({@link quotedInterpolations}) sees a quote holding text beside the
 * value (`'cdkd/${x}/state.json'`), not only `'${x}'`, and the COUNT keys each
 * entry to its sites: a generic name (`name`, `path`, `cfnName`) at a NEW site,
 * such as a state-derived local of the same spelling, changes the count and
 * fails (go-to-k/cdkd#4104 review M1, M2). The reasons are about who chooses
 * the value: cdkd itself (a literal, a table, a generated name), AWS's own
 * schema, or the operator (the command line, their environment or config),
 * who is the one pasting.
 */
const ALLOWED_HAND_QUOTES: Readonly<Record<string, { count: number; reason: string }>> = {
  VPC_CIDR_ASSOCIATION_ID_PREFIX: { count: 1, reason: 'a cdkd constant' },
  EIP_ALLOCATION_ID_PREFIX: { count: 1, reason: 'a cdkd constant' },
  compositeShape: { count: 2, reason: 'a cdkd literal id shape (`<a>|<b>`)' },
  key: { count: 1, reason: "a property name from cdkd's own splitter table" },
  physicalIdShape: { count: 1, reason: 'a cdkd literal id shape from COMPOSITE_PHYSICAL_ID_IDENTIFIERS' },
  'compositeIdentifier.field': { count: 1, reason: "a field name from cdkd's own registry" },
  f: { count: 1, reason: "a primaryIdentifier field AWS's DescribeType schema declares" },
  resourceType: {
    count: 2,
    reason: "matched against CloudFormation's own error text, never printed",
  },
  stackArg: { count: 1, reason: 'the stack name the operator typed' },
  flag: { count: 1, reason: 'the --stack-region the operator typed' },
  path: { count: 2, reason: 'the template file path the operator typed' },
  raw: { count: 4, reason: 'the --cfn-child-stack-name value the operator typed' },
  cfnName: {
    count: 1,
    reason: 'the CFn name split out of the --cfn-child-stack-name value the operator typed',
  },
  t: { count: 2, reason: 'the --parameter token the operator typed' },
  name: { count: 1, reason: 'the --parameter override name the operator typed' },
  'uploadOpts.stateBucket': {
    count: 1,
    reason: "the operator's state bucket (flag, CDKD_STATE_BUCKET, cdk.json, or cdkd's default name)",
  },
  bucket: {
    count: 1,
    reason: "the operator's state bucket (flag, CDKD_STATE_BUCKET, cdk.json, or cdkd's default name)",
  },
  changeSetName: { count: 2, reason: 'a name cdkd generates' },
  body: { count: 2, reason: "showRecordValue's own JSON escape, which is the boundary" },
  'String(value)': { count: 1, reason: 'quotedOrNotShown itself, after its plain check' },
};

/**
 * Every `${...}` a hand-written quote on `line` holds, found three ways and
 * reported once each (per position):
 *
 * - a whole quoted RUN: a `'` or `"` opening after a non-word character,
 *   closed by the same character before a non-word character or right after a
 *   `}`, so an apostrophe in prose (`parent's`, `Lambda's`) is neither;
 * - LEFT adjacency: walking left from `${` across no whitespace reaches such
 *   an opening quote (`'cdkd/${x}/state.json's`, `'${x}~'s`);
 * - RIGHT adjacency: walking right from its `}` across no whitespace reaches
 *   the same quote character (`see ${x}'.`).
 *
 * KNOWN BOUNDS: a quote whose opener follows a word character is read as an
 * apostrophe (`prefix' ${x} suffix'.`), and one holding whitespace on BOTH
 * sides of the value whose closer is also followed by a word character
 * (`'a ${x} b's`) is none of the three. Braces nest, so `${f(g())}` is one
 * interpolation.
 */
export function quotedInterpolations(line: string): string[] {
  const word = /[\w$]/;
  const found = new Map<number, string>();
  const interpolationsIn = (from: number, to: number): void => {
    for (let at = line.indexOf('${', from); at >= 0 && at < to; at = line.indexOf('${', at + 2)) {
      found.set(at, line.slice(at + 2, endOf(at)));
    }
  };
  const endOf = (at: number): number => {
    let depth = 0;
    let end = at + 1;
    for (; end < line.length; end++) {
      if (line[end] === '{') depth++;
      else if (line[end] === '}' && --depth === 0) break;
    }
    return end;
  };
  const opensAt = (i: number): boolean =>
    (line[i] === "'" || line[i] === '"') && (i === 0 || !word.test(line[i - 1]!));
  // Whole runs.
  for (let i = 0; i < line.length; i++) {
    if (!opensAt(i)) continue;
    const q = line[i]!;
    for (let k = i + 1; k < line.length; k++) {
      if (
        line[k] === q &&
        (k + 1 === line.length || !word.test(line[k + 1]!) || line[k - 1] === '}')
      ) {
        interpolationsIn(i + 1, k);
        i = k;
        break;
      }
    }
  }
  // Adjacency on either side of each interpolation.
  for (let at = line.indexOf('${'); at >= 0; at = line.indexOf('${', at + 2)) {
    let l = at - 1;
    // Each walk stops at whitespace, at another interpolation or template
    // (`$`, `{`, `}`, a backtick), whose quotes are JavaScript rather than
    // prose, and at the first quote character; only an OPENING quote on the
    // left, or any quote on the right, counts.
    while (l >= 0 && !/[\s{}$`'"]/.test(line[l]!)) l--;
    const end = endOf(at);
    let r = end + 1;
    while (r < line.length && !/[\s{}$`'"]/.test(line[r]!)) r++;
    if ((l >= 0 && opensAt(l)) || (r < line.length && (line[r] === "'" || line[r] === '"'))) {
      found.set(at, line.slice(at + 2, end));
    }
  }
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, expr]) => expr);
}

function exportCode(): string[] {
  const raw = readFileSync(
    new URL('../../../src/cli/commands/export.ts', import.meta.url),
    'utf8'
  );
  // Newlines kept, so a hit's line number is the file's. KNOWN BOUND: a `//`
  // inside a template string also strips the rest of its line, so a hand quote
  // after one would be hidden (none exists today).
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, (span) => '\n'.repeat((span.match(/\n/g) ?? []).length))
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'));
}

function stateOf(args: {
  stackName: string;
  region: string;
  resources?: Record<string, string>;
  parentStack?: string;
}): StackState {
  const resources: StackState['resources'] = {};
  for (const [logicalId, resourceType] of Object.entries(args.resources ?? {})) {
    resources[logicalId] = {
      physicalId: `phy-${logicalId}`,
      resourceType,
      properties: {},
      attributes: {},
      dependencies: [],
    };
  }
  return {
    version: 6,
    stackName: args.stackName,
    region: args.region,
    resources,
    outputs: {},
    lastModified: 0,
    ...(args.parentStack !== undefined && {
      parentStack: args.parentStack,
      parentLogicalId: 'Child',
      parentRegion: 'us-east-1',
    }),
  } as StackState;
}

function backend(states: Record<string, StackState>): S3StateBackend {
  return {
    async getState(stackName: string, region: string) {
      const s = states[`${stackName}|${region}`];
      return s ? readAtKeyRegion(s, region) : null;
    },
  } as unknown as S3StateBackend;
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e as Error
  );
  expect(err, 'expected a refusal').toBeDefined();
  return err!.message;
}

/** Each family's message for `value`, and the text its site must carry. */
async function familiesFor(
  value: string
): Promise<Array<{ family: string; message: string; quoted: string; described: string }>> {
  const nested = { Child: 'AWS::CloudFormation::Stack' };
  return [
    {
      family: 'root-not-found refusal',
      message: await refusal(() => buildCdkdStateStackTree(value, 'us-east-1', backend({}))),
      quoted: `No cdkd state found for stack '${value}' (us-east-1)`,
      described: `No cdkd state found for stack ${NOT_SHOWN} (us-east-1)`,
    },
    {
      family: 'missing-child refusal (root name)',
      message: await refusal(() =>
        buildCdkdStateStackTree(
          value,
          'us-east-1',
          backend({ [`${value}|us-east-1`]: stateOf({ stackName: value, region: 'us-east-1', resources: nested }) })
        )
      ),
      quoted: `missing nested-child '${value}~Child' (us-east-1). Parent stack '${value}' lists 'Child'`,
      described: `missing nested-child ${NOT_SHOWN} (us-east-1). Parent stack ${NOT_SHOWN} lists 'Child'`,
    },
    {
      family: 'missing-child refusal (logical id)',
      message: await refusal(() =>
        buildCdkdStateStackTree(
          'Root',
          'us-east-1',
          backend({
            'Root|us-east-1': stateOf({
              stackName: 'Root',
              region: 'us-east-1',
              resources: { [value]: 'AWS::CloudFormation::Stack' },
            }),
          })
        )
      ),
      quoted: `missing nested-child 'Root~${value}' (us-east-1). Parent stack 'Root' lists '${value}'`,
      described: `missing nested-child ${NOT_SHOWN} (us-east-1). Parent stack 'Root' lists ${NOT_SHOWN}`,
    },
    {
      family: 'region-mismatch refusal (record region)',
      message: await refusal(() =>
        buildCdkdStateStackTree(
          'Root',
          'us-east-1',
          backend({
            'Root|us-east-1': stateOf({ stackName: 'Root', region: 'us-east-1', resources: nested }),
            'Root~Child|us-east-1': stateOf({ stackName: 'Root~Child', region: value, parentStack: 'Root' }),
          })
        )
      ),
      quoted: `nested-child 'Root~Child' has state.region='${value}' but its parent 'Root'`,
      described: `nested-child 'Root~Child' has state.region=${NOT_SHOWN} but its parent 'Root'`,
    },
    {
      family: 'CFn stack-name refusal',
      message: await refusal(async () => cdkd2cfnStackName(`${value}_`)),
      quoted: `cdkd stack name '${value}_' maps to CFn stack name '${value}_'`,
      described: `cdkd stack name ${NOT_SHOWN} maps to CFn stack name ${NOT_SHOWN}`,
    },
  ];
}

describe('cdkd export puts no state or template value inside its own quotes (go-to-k/cdkd#3950)', () => {
  it('leaves only the listed hand quotes in export.ts, each with its count and reason', () => {
    const code = exportCode();
    // Non-vacuity: the file was read and is the one this fence was written against.
    expect(code.length).toBeGreaterThan(5000);
    expect(code.join('\n')).toContain('function quotedOrNotShown(');
    const seen = new Map<string, number[]>();
    code.forEach((line, i) => {
      for (const expr of quotedInterpolations(line)) {
        seen.set(expr, [...(seen.get(expr) ?? []), i + 1]);
      }
    });
    const unlisted = [...seen].filter(([expr]) => !(expr in ALLOWED_HAND_QUOTES));
    expect(unlisted.map(([expr, at]) => `export.ts:${at.join(',')} \${${expr}}`)).toEqual([]);
    // Each entry at exactly its count: a same-named new site, or a dead entry,
    // fails here.
    const counts = Object.fromEntries(
      Object.keys(ALLOWED_HAND_QUOTES).map((expr) => [expr, seen.get(expr)?.length ?? 0])
    );
    expect(counts).toEqual(
      Object.fromEntries(Object.entries(ALLOWED_HAND_QUOTES).map(([expr, { count }]) => [expr, count]))
    );
  });

  it('the scan sees a value beside literal text inside a quote, and skips an apostrophe', () => {
    expect(quotedInterpolations("`at 'cdkd/${safeSegment(x)}/state.json'.`")).toEqual([
      'safeSegment(x)',
    ]);
    expect(quotedInterpolations("`stack '${x}~' here`")).toEqual(['x']);
    expect(quotedInterpolations('`got "${f(g(1))}" back`')).toEqual(['f(g(1))']);
    // Braces NEST: an object literal inside is part of the one interpolation.
    expect(quotedInterpolations("`see '${f({ a: { b: 1 } })}' now`")).toEqual(['f({ a: { b: 1 } })']);
    expect(quotedInterpolations("`stack '${x}'s state`")).toEqual(['x']);
    expect(quotedInterpolations("`stack '${x}~'s state`")).toEqual(['x']);
    expect(quotedInterpolations("`read 'cdkd/${x}/state.json's contents`")).toEqual(['x']);
    expect(quotedInterpolations("`see ${x}'.`")).toEqual(['x']);
    // Each adjacency detector on its own: LEFT only (the closer follows
    // whitespace, then a word character), and RIGHT only (no opener).
    expect(quotedInterpolations("`read 'cdkd/${x} suffix's contents`")).toEqual(['x']);
    expect(quotedInterpolations("`read ${x}/state.json' here`")).toEqual(['x']);
    // And the whole-RUN detector alone: whitespace on both sides of the value.
    expect(quotedInterpolations("`say 'a ${x} b' now`")).toEqual(['x']);
    expect(quotedInterpolations("`the parent's ${x} row is Lambda's`")).toEqual([]);
    expect(quotedInterpolations('`bare ${x} value`')).toEqual([]);
  });

  it('keeps a plain value quoted, byte-identical to before', async () => {
    const families = await familiesFor('Plain1');
    expect(families).toHaveLength(5);
    for (const { family, message, quoted } of families) {
      expect(message, family).toContain(quoted);
      expect(message, family).not.toContain(NOT_SHOWN);
    }
  });

  it('describes every payload, names none of it, and no pasted span of the whole message runs', async () => {
    const rendered: Array<{ label: string; value: string; message: string; described: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      for (const f of await familiesFor(value)) {
        rendered.push({ label: `${f.family}: ${value}`, value, message: f.message, described: f.described });
      }
    }
    expect(rendered).toHaveLength(PASTE_PAYLOADS.length * 5);
    withPasteDir((dir) => {
      for (const { label, value, message, described } of rendered) {
        expect(message, label).toContain(described);
        expect(message, label).not.toContain(value);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);

  it('quotes exactly the characters displayIdent keeps plain, one printable ASCII character at a time', async () => {
    // The invariant, not a payload instance. `_` is refused by CloudFormation,
    // so every name here reaches the stack-name refusal.
    const plain = /[A-Za-z0-9:_@./+=,~-]/;
    let quoted = 0;
    for (let code = 0x21; code <= 0x7e; code++) {
      const c = String.fromCharCode(code);
      const name = `a${c}_b`;
      const message = await refusal(async () => cdkd2cfnStackName(name));
      if (plain.test(c)) {
        quoted++;
        expect(message, name).toContain(`cdkd stack name '${name}' maps`);
      } else {
        expect(message, name).toContain(`cdkd stack name ${NOT_SHOWN} maps`);
      }
    }
    // 62 alphanumerics plus the 10 listed punctuation characters.
    expect(quoted).toBe(72);
  });

  it('quotes a plain name up to the stack-ref cap, and describes one a character longer', async () => {
    // `_` keeps every name refused by CloudFormation, so each reaches the refusal.
    const atCap = `a${'_'.repeat(STACK_REF_MAX_CODE_POINTS - 1)}`;
    expect(await refusal(async () => cdkd2cfnStackName(atCap))).toContain(`cdkd stack name '${atCap}' maps`);
    expect(await refusal(async () => cdkd2cfnStackName(`${atCap}_`))).toContain(
      `cdkd stack name ${NOT_SHOWN} maps`
    );
  });

  it("describes a name that ends in displayIdent's own cut marker, which round-trips unchanged", async () => {
    const forged = `${'a'.repeat(STACK_REF_MAX_CODE_POINTS)} [cut: 35 more characters withheld]`;
    const message = await refusal(async () => cdkd2cfnStackName(forged));
    expect(message).toContain(`cdkd stack name ${NOT_SHOWN} maps`);
    expect(message).not.toContain('[cut:');
  });

  it('quotes a plain child name near the cap in the head, and describes the longer state-key path', async () => {
    // The child name fits the stack-ref cap; `cdkd/<child>/<region>/state.json`
    // around it does not, so the same name is quoted in the head and the path
    // is described (`displayIdent` would cut it).
    const root = 'r'.repeat(STACK_REF_MAX_CODE_POINTS - 10);
    const child = `${root}~Child`;
    const message = await refusal(() =>
      buildCdkdStateStackTree(
        root,
        'us-east-1',
        backend({
          [`${root}|us-east-1`]: stateOf({
            stackName: root,
            region: 'us-east-1',
            resources: { Child: 'AWS::CloudFormation::Stack' },
          }),
        })
      )
    );
    expect(child.length).toBeLessThanOrEqual(STACK_REF_MAX_CODE_POINTS);
    expect(message).toContain(`missing nested-child '${child}' (us-east-1)`);
    expect(message).toContain(`no child state file exists at ${NOT_SHOWN}.`);
  });

  it('describes a value carrying a space, which could put a clause break inside the quote', async () => {
    expect(await refusal(async () => cdkd2cfnStackName('a b_'))).toContain(`cdkd stack name ${NOT_SHOWN}`);
    expect(await refusal(async () => cdkd2cfnStackName('a: b_'))).toContain(`cdkd stack name ${NOT_SHOWN}`);
  });

  describe('the nested-template read and parse refusals print no error text (go-to-k/cdkd#4104 review M0)', () => {
    /** The refusal `buildPerStackImportNodes` throws for a child whose template is at `path`. */
    function refusalFor(path: string): string {
      const tree: CdkdStateStackTree = {
        stackName: 'Root',
        region: 'us-east-1',
        state: {} as StackState,
        nestedChildren: new Map([
          [
            'Child',
            { stackName: 'Root~Child', region: 'us-east-1', state: {} as StackState, nestedChildren: new Map() },
          ],
        ]),
      };
      try {
        buildPerStackImportNodes('Root', { Resources: {} }, { Child: path }, 'json', tree);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error(`expected a refusal for ${path}`);
    }

    it('the READ arm prints the fs code, never Node message quoting the path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-export-read-'));
      try {
        const messages = PASTE_PAYLOADS.map(({ value }) => ({
          value,
          message: refusalFor(join(dir, `${value}.json`)),
        }));
        withPasteDir((pasteDir) => {
          for (const { value, message } of messages) {
            expect(message, value).toMatch(/: ENOENT$/);
            expect(message, value).not.toContain(value);
            expect(spansThatRun(message, pasteDir), value).toEqual([]);
          }
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);

    it('prints only an fs-shaped code, and a fixed phrase for anything else', () => {
      // Node's codes, with an underscore and a digit too.
      for (const code of ['EACCES', 'ERR_FS_FILE_TOO_LARGE', 'E2BIG']) {
        expect(fsReadErrorCause(Object.assign(new Error('x'), { code }))).toBe(code);
      }
      for (const err of [
        Object.assign(new Error("open 'x'"), { code: "x'$(touch OWNED)" }),
        Object.assign(new Error('x'), { code: 42 }),
        Object.assign(new Error('x'), { code: 'enoent' }),
        // Each anchor on its own: a valid prefix, then a valid suffix.
        Object.assign(new Error('x'), { code: "ENOENT'$(touch OWNED) #" }),
        Object.assign(new Error('x'), { code: "'$(touch OWNED) #ENOENT" }),
        new Error("ENOENT: open 'x'$(touch OWNED)'"),
        null,
        'ENOENT',
      ]) {
        expect(fsReadErrorCause(err), String(err)).toBe('the file could not be read');
      }
    });

    it("the PARSE arm prints no parser message, which quotes the file's text", () => {
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-export-parse-'));
      try {
        const messages = PASTE_PAYLOADS.map(({ value }, i) => {
          const path = join(dir, `child${i}.json`);
          // Invalid JSON whose parser message echoes the WHOLE body
          // (`Unexpected token 'x', "[x…" is not valid JSON`), payload included.
          writeFileSync(path, `[${value}`, 'utf-8');
          return { value, message: refusalFor(path) };
        });
        withPasteDir((pasteDir) => {
          for (const { value, message } of messages) {
            expect(message, value).toContain('it is not a template cdkd can parse');
            expect(message, value).not.toContain(value);
            expect(spansThatRun(message, pasteDir), value).toEqual([]);
          }
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
