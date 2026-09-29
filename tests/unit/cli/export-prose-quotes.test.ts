import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vite-plus/test';

import { buildCdkdStateStackTree, cdkd2cfnStackName } from '../../../src/cli/commands/export.js';
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
 * Every `'${...}'` / `"${...}"` left in `export.ts`'s CODE, with why it may
 * stay. A new hand-quoted value fails the fence below by name. The reasons are
 * about who chooses the value: cdkd itself (a literal, a table, a generated
 * name), AWS's own schema, or the operator (the command line, their
 * environment or config), who is the one pasting.
 */
const ALLOWED_HAND_QUOTES: Readonly<Record<string, string>> = {
  compositeShape: "a cdkd literal id shape (`<a>|<b>`)",
  key: "a property name from cdkd's own splitter table",
  physicalIdShape: "a cdkd literal id shape from COMPOSITE_PHYSICAL_ID_IDENTIFIERS",
  'compositeIdentifier.field': "a field name from cdkd's own registry",
  f: "a primaryIdentifier field AWS's DescribeType schema declares",
  stackArg: 'the stack name the operator typed',
  flag: 'the --stack-region the operator typed',
  path: 'the template file path the operator typed',
  raw: 'the --cfn-child-stack-name value the operator typed',
  cfnName: 'the CFn name split out of the --cfn-child-stack-name value the operator typed',
  t: 'the --parameter token the operator typed',
  name: 'the --parameter override name the operator typed',
  'uploadOpts.stateBucket': "the operator's state bucket (flag, CDKD_STATE_BUCKET, cdk.json, or cdkd's default name)",
  bucket: "the operator's state bucket (flag, CDKD_STATE_BUCKET, cdk.json, or cdkd's default name)",
  changeSetName: 'a name cdkd generates',
  body: "showRecordValue's own JSON escape, which is the boundary",
  'String(value)': 'quotedOrNotShown itself, after its plain check',
};

function exportCode(): string[] {
  const raw = readFileSync(
    new URL('../../../src/cli/commands/export.ts', import.meta.url),
    'utf8'
  );
  // Newlines kept, so a hit's line number is the file's.
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
  it('leaves only the listed hand quotes in export.ts, each with its reason', () => {
    const code = exportCode();
    // Non-vacuity: the file was read and is the one this fence was written against.
    expect(code.length).toBeGreaterThan(5000);
    expect(code.join('\n')).toContain('function quotedOrNotShown(');
    const hits = code.flatMap((line, i) =>
      [...line.matchAll(/(['"])\$\{([^{}]*)\}\1/g)].map((m) => ({ expr: m[2]!, at: i + 1 }))
    );
    const unlisted = hits.filter(({ expr }) => !(expr in ALLOWED_HAND_QUOTES));
    expect(unlisted.map(({ expr, at }) => `export.ts:${at} '\${${expr}}'`)).toEqual([]);
    // Every listed entry is still live, so the list cannot rot into a blanket pass.
    const live = new Set(hits.map(({ expr }) => expr));
    expect(Object.keys(ALLOWED_HAND_QUOTES).filter((expr) => !live.has(expr))).toEqual([]);
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

  it('describes a value carrying a space, which could put a clause break inside the quote', async () => {
    expect(await refusal(async () => cdkd2cfnStackName('a b_'))).toContain(`cdkd stack name ${NOT_SHOWN}`);
    expect(await refusal(async () => cdkd2cfnStackName('a: b_'))).toContain(`cdkd stack name ${NOT_SHOWN}`);
  });
});
