/**
 * Assembly-chosen IDENTIFIERS in cdkd's own prose (go-to-k/cdkd#3617).
 *
 * A stack name, a logical id (a template key), an asset's display name and a
 * template-chosen parameter or attribute name used to be printed inside quotes
 * of cdkd's own through `displaySafe`, which passes `'` — so a value carrying
 * one closed the quote and wrote a clause of its own into a refusal. They now
 * render through `displayIdent` / `displayStackName`: bare when the value is a
 * plain identifier, one JSON string otherwise.
 *
 * Both polarities per site family: a FORGING value stays inside its boundary
 * with nothing of it outside, and an ordinary identifier renders bare with no
 * quote of any kind. The forging row is the one that catches a site dropping
 * its boundary altogether (a bare `${displaySafe(x)}`), which prints an
 * ordinary identifier byte-identically.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import { renderNestedTemplateTreeDefect } from '../../../src/utils/nested-template-cycle.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import { indexNestedChildTemplates } from '../../../src/cli/commands/diff-recursive.js';
import { indexGrandchildTemplatePaths } from '../../../src/cli/commands/import.js';
import { resolveLambdaTarget } from '../../../src/local/lambda-resolver.js';
import { resolveLambdaByLogicalId } from '../../../src/cli/commands/local-start-api.js';
import { resolveFileAssetSourcePath } from '../../../src/assets/asset-manifest-loader.js';
import { resolveDockerContextDirectory } from '../../../src/assets/docker-build.js';
import { resolveVerboseTemplatePath } from '../../../src/cli/commands/synth.js';
import { AssetManifestLoader } from '../../../src/assets/asset-manifest-loader.js';
import { resolveAssetCodeDirectory } from '../../../src/local/lambda-resolver.js';
import {
  displayStackName,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../src/utils/display-safe.js';
import type { AssemblyManifest, ArtifactManifest } from '../../../src/types/assembly.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const warns: string[] = [];
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const quiet = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
  };
  return {
    ...(await importOriginal<object>()),
    getLogger: () => ({ ...quiet, child: () => quiet }),
  };
});

/** Inside cdkd's old `'...'`, this closed the quote and wrote a clause. */
const FORGED = "X'. Contained and healthy. Nothing 'Y";
const SHOWN = JSON.stringify(FORGED);

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-ident-display-')));
}

/** The text with every rendered copy of the forging value cut out. */
function outside(text: string): string {
  return text.split(SHOWN).join('<VALUE>');
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

function nestedRow(logicalId: string, assetPath: string): CloudFormationTemplate {
  return {
    Resources: {
      [logicalId]: {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': assetPath },
      },
    },
  } as unknown as CloudFormationTemplate;
}

describe('displayStackName', () => {
  it('is displayIdent with the stack-reference cap', () => {
    expect(displayStackName('Parent~Child~Grandchild')).toBe('Parent~Child~Grandchild');
    expect(displayStackName(FORGED)).toBe(SHOWN);
    // A nested name longer than displayIdent's 255 default is not cut.
    const long = Array.from({ length: 4 }, () => 'A'.repeat(200)).join('~');
    expect(long.length).toBeLessThan(STACK_REF_MAX_CODE_POINTS);
    expect(displayStackName(long)).toBe(long);
  });
});

describe('AssemblyReader: a stack name in the refusal subject', () => {
  function refuse(stackName: string): string {
    const dir = join(tmp(), 'cdk.out');
    mkdirSync(dir);
    return messageOf(() =>
      new AssemblyReader().getAllStacks(dir, {
        version: '54.0.0',
        artifacts: {
          Main: { type: 'aws:cloudformation:stack', properties: { stackName } } as ArtifactManifest,
        },
      } as AssemblyManifest)
    );
  }

  it('keeps a forging stack name inside one boundary', () => {
    const message = refuse(FORGED);
    expect(message).toBe(`Stack ${SHOWN} has no templateFile property`);
    expect(outside(message)).not.toContain('Contained and healthy');
  });

  it('renders an ordinary stack name bare', () => {
    expect(refuse('MainStack')).toBe('Stack MainStack has no templateFile property');
  });
});

describe('the nested-template tree refusal', () => {
  it('keeps a forging stack name, closing row and chain row inside their boundaries', () => {
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'cycle',
        chain: [
          { logicalId: FORGED, templatePath: '/out/a.json' },
          { logicalId: FORGED, templatePath: '/out/a.json' },
        ],
      } as never,
      FORGED,
      'deploy'
    );

    expect(text).toContain(`under stack ${SHOWN} contains a cycle`);
    expect(text).toContain(`${SHOWN} (/out/a.json) -> ${SHOWN} (/out/a.json)`);
    // The CLOSING row, named on its own.
    expect(text).toContain(`. Nested stack ${SHOWN} (declared in stack `);
    // The OWNING stack is built from the same values, `~`-joined.
    expect(text).toContain(`(declared in stack ${JSON.stringify(`${FORGED}~${FORGED}`)})`);
    expect(outside(text.split(JSON.stringify(`${FORGED}~${FORGED}`)).join(''))).not.toContain(
      'Contained and healthy'
    );
  });

  it('keeps a forging nested-stack logical id inside one boundary on the absolute and escaping arms', () => {
    const absolute = renderNestedTemplateTreeDefect(
      {
        kind: 'absolute-path',
        chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }],
        logicalId: FORGED,
        assetPath: '/abs.json',
      },
      FORGED,
      'deploy'
    );
    expect(absolute).toContain(`under stack ${SHOWN} has nested stack ${SHOWN} (reached through`);
    expect(outside(absolute)).not.toContain('Contained and healthy');

    const escaping = renderNestedTemplateTreeDefect(
      {
        kind: 'escaping-path',
        chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }],
        logicalId: FORGED,
        assetPath: '../x.json',
        escape: { contained: false, escape: 'lexical', path: '/x.json' },
        dir: '/out',
      },
      FORGED,
      'deploy'
    );
    expect(escaping).toContain(`under stack ${SHOWN} has nested stack ${SHOWN} (reached through`);
    expect(outside(escaping)).not.toContain('Contained and healthy');
  });

  it('keeps a forging stack and tail id inside their own boundaries when the owner name is elided', () => {
    // More than 8 hops: the owner is rendered as a head and a tail around
    // cdkd's `...N more...` marker, each end with its own boundary.
    const chain = Array.from({ length: 30 }, (_, i) => ({
      logicalId: i === 29 ? FORGED : `L${i}`,
      templatePath: `/out/t${i}.json`,
    }));
    chain.push({ logicalId: 'Closer', templatePath: '/out/t0.json' });

    const text = renderNestedTemplateTreeDefect({ kind: 'cycle', chain }, FORGED, 'deploy');

    const head = JSON.stringify(`${FORGED}~L0~L1~L2~L3`);
    const tail = JSON.stringify(`L26~L27~L28~${FORGED}`);
    expect(text).toContain(`(declared in stack ${head}~...22 more...~${tail})`);
    expect(
      [head, tail, SHOWN].reduce((t, v) => t.split(v).join(''), text)
    ).not.toContain('Contained and healthy');
  });

  it('renders ordinary identifiers bare', () => {
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'absolute-path',
        chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }],
        logicalId: 'E',
        assetPath: '/abs.json',
      },
      'P',
      'deploy'
    );
    expect(text).toContain("under stack P has nested stack E (reached through Child (/out/a.json))");
    expect(text).not.toMatch(/'(P|E|Child)'/);
  });
});

describe('a nested-stack logical id in each indexer', () => {
  const provider = new NestedStackProvider();
  const grandchild = (
    provider as unknown as {
      indexGrandchildTemplates: (t: unknown, childTemplatePath: string) => unknown;
    }
  ).indexGrandchildTemplates.bind(provider);
  const SITES: ReadonlyArray<[string, (t: CloudFormationTemplate, dir: string) => unknown, string]> =
    [
      ['NestedStackProvider', (t, dir) => grandchild(t, join(dir, 'C.json')), 'nested-stack'],
      [
        'cdkd diff --recursive',
        (t, dir) => indexNestedChildTemplates(t, join(dir, 'P.json')),
        'Nested stack',
      ],
      [
        'cdkd import --migrate-from-cloudformation',
        (t, dir) => indexGrandchildTemplatePaths(t, join(dir, 'C.json')),
        'grandchild nested-stack',
      ],
    ];

  for (const [name, index, noun] of SITES) {
    it(`${name}: a forging logical id stays inside one boundary, an ordinary one is bare`, () => {
      const dir = tmp();
      const hostile = messageOf(() => index(nestedRow(FORGED, '/abs/child.json'), dir));
      expect(hostile).toContain(`${noun} ${SHOWN} has Metadata['aws:asset:path']=`);
      expect(outside(hostile)).not.toContain('Contained and healthy');

      // The escaping arm, a separate subject from the absolute tripwire above.
      const escaping = messageOf(() => index(nestedRow(FORGED, '../out.json'), dir));
      expect(escaping).toContain(`${noun} ${SHOWN} has Metadata['aws:asset:path']=../out.json which`);
      expect(outside(escaping)).not.toContain('Contained and healthy');

      const plain = messageOf(() => index(nestedRow('Child', '/abs/child.json'), dir));
      expect(plain).toContain(`${noun} Child has Metadata['aws:asset:path']=/abs/child.json`);
    });
  }
});

describe("cdkd local invoke: a Lambda's logical id", () => {
  function refuse(logicalId: string): string {
    const stack = {
      stackName: 'Stk',
      displayName: 'Stk',
      artifactId: 'Stk',
      dependencyNames: [],
      template: {
        Resources: {
          [logicalId]: {
            Type: 'AWS::Lambda::Function',
            Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Code: {} },
          },
        },
      },
    } as unknown as StackInfo;
    return messageOf(() => resolveLambdaTarget(`Stk:${logicalId}`, [stack]));
  }

  it('keeps a forging logical id inside one boundary', () => {
    const message = refuse(FORGED);
    expect(message).toContain(`Lambda ${SHOWN} has no Metadata['aws:asset:path']`);
    expect(outside(message)).not.toContain('Contained and healthy');
  });

  it('renders an ordinary logical id bare', () => {
    expect(refuse('Fn')).toContain("Lambda Fn has no Metadata['aws:asset:path']");
  });
});

describe("cdkd local invoke: a contained Lambda asset directory that does not exist", () => {
  function refuse(logicalId: string): string {
    const outdir = join(tmp(), 'cdk.out');
    mkdirSync(outdir);
    writeFileSync(join(outdir, 'Stk.assets.json'), JSON.stringify({ version: '54.0.0' }));
    const stack = {
      stackName: 'Stk',
      displayName: 'Stk',
      artifactId: 'Stk',
      assetManifestPath: join(outdir, 'Stk.assets.json'),
      assetOutdir: outdir,
      dependencyNames: [],
      template: {
        Resources: {
          [logicalId]: {
            Type: 'AWS::Lambda::Function',
            Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Code: {} },
            Metadata: { 'aws:asset:path': 'asset.missing' },
          },
        },
      },
    } as unknown as StackInfo;
    return messageOf(() => resolveLambdaTarget(`Stk:${logicalId}`, [stack]));
  }

  it('keeps a forging logical id inside one boundary, and renders an ordinary one bare', () => {
    const hostile = refuse(FORGED);
    expect(hostile).toContain(`Lambda ${SHOWN} asset directory `);
    expect(outside(hostile)).not.toContain('Contained and healthy');
    expect(refuse('Fn')).toContain('Lambda Fn asset directory ');
  });
});

describe("cdkd local start-api: a Lambda's logical id", () => {
  function refuse(logicalId: string): string {
    const stack = {
      stackName: 'Stk',
      displayName: 'Stk',
      artifactId: 'Stk',
      dependencyNames: [],
      template: {
        Resources: {
          [logicalId]: {
            Type: 'AWS::Lambda::Function',
            Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Code: {} },
          },
        },
      },
    } as unknown as StackInfo;
    return messageOf(() => resolveLambdaByLogicalId(logicalId, [stack]));
  }

  it('keeps a forging logical id inside one boundary, and renders an ordinary one bare', () => {
    const hostile = refuse(FORGED);
    expect(hostile).toContain(`Lambda ${SHOWN} has no Metadata['aws:asset:path']`);
    expect(outside(hostile)).not.toContain('Contained and healthy');
    expect(refuse('Fn')).toContain("Lambda Fn has no Metadata['aws:asset:path']");
  });
});

describe("an asset's display name and id in the containment subject", () => {
  it('file asset: a forging display name stays inside one boundary, an ordinary one is bare', () => {
    const dir = tmp();
    const run = (displayName: string): string =>
      messageOf(() =>
        resolveFileAssetSourcePath(
          dir,
          { displayName, source: { path: '../out.json', packaging: 'file' }, destinations: {} } as never,
          { assetOutdir: dir, sink: 'upload it' }
        )
      );

    const hostile = run(FORGED);
    expect(hostile).toContain(`File asset ${SHOWN} has source.path=`);
    expect(outside(hostile)).not.toContain('Contained and healthy');
    expect(run('MyStack/MyAsset')).toContain('File asset MyStack/MyAsset has source.path=');
    // A display name is free-form construct-path text: a non-ASCII construct
    // id stays READABLE (`displayAssemblyPath`), where `displayIdent` would
    // blank every such character to a space.
    expect(run('MyStack/\u8cc7\u7523')).toContain(
      'File asset MyStack/\u8cc7\u7523 has source.path='
    );
  });

  it('Docker asset: a forging id stays inside one boundary in the warning, an ordinary one is bare', () => {
    const dir = tmp();
    // An absolute context outside the bound is HONOURED with a warning (what
    // `cdk synth --no-staging` emits), and the warning names the asset.
    const warnFor = (assetId: string): string => {
      warns.length = 0;
      resolveDockerContextDirectory({
        manifestDir: dir,
        directory: '/abs/elsewhere',
        wrapError: (m) => new Error(m),
        assetOutdir: dir,
        sink: 'build it',
        assetId,
      });
      expect(warns).toHaveLength(1);
      return warns[0]!;
    };

    const hostile = warnFor(FORGED);
    expect(hostile.startsWith(`Docker asset ${SHOWN} has an absolute source.directory`)).toBe(true);
    expect(outside(hostile)).not.toContain('Contained and healthy');
    expect(warnFor('abc123').startsWith('Docker asset abc123 has an absolute source.directory')).toBe(
      true
    );
  });
});

describe('cdkd synth --verbose: the stack name in the refusal subject', () => {
  it('keeps a forging stack name inside one boundary, and renders an ordinary one bare', () => {
    const out = tmp();
    const value = `../${FORGED}`;

    const hostile = messageOf(() => resolveVerboseTemplatePath(out, value));
    expect(hostile).toContain(`Stack ${JSON.stringify(value)} would write its template`);
    // The tail's resolved path embeds the same value, with its own boundary.
    const resolvedPath = JSON.stringify(resolve(out, `${value}.template.json`));
    expect(
      hostile.split(JSON.stringify(value)).join('').split(resolvedPath).join('')
    ).not.toContain('Contained and healthy');

    expect(messageOf(() => resolveVerboseTemplatePath(out, '../evil'))).toContain(
      'Stack ../evil would write its template'
    );
  });
});

/**
 * The remaining sites, each driven with a FORGING value. None of them has an
 * ordinary-value pin that could tell `displayIdent` from a bare interpolation,
 * so the forging row is the whole of their coverage.
 */
describe('every other identifier site keeps a forging value inside one boundary', () => {
  it('file asset warnings: absolute path, absolute outdir and relative outdir', () => {
    const dir = tmp();
    const run = (path: string, displayName: string): string => {
      warns.length = 0;
      resolveFileAssetSourcePath(
        dir,
        { displayName, source: { path, packaging: 'zip' }, destinations: {} } as never,
        { assetOutdir: dir, sink: 'upload it' }
      );
      expect(warns).toHaveLength(1);
      return warns[0]!;
    };
    for (const path of ['/abs/elsewhere', dir, '.']) {
      const said = run(path, FORGED);
      expect(said.startsWith(`File asset ${SHOWN} has `)).toBe(true);
      expect(outside(said)).not.toContain('Contained and healthy');
      // A non-ASCII construct id stays readable in every warning arm too.
      expect(run(path, 'MyStack/\u8cc7\u7523').startsWith('File asset MyStack/\u8cc7\u7523 has ')).toBe(
        true
      );
    }
  });

  it("an asset manifest's stack name", async () => {
    const dir = tmp();
    const value = `../${FORGED}`;
    const message = await new AssetManifestLoader().loadManifest(dir, value).then(
      () => '',
      (e: unknown) => (e as Error).message
    );
    expect(message).toContain(`Asset manifest for stack ${JSON.stringify(value)} resolves to `);
    const rest = message
      .split(JSON.stringify(value))
      .join('')
      .split(JSON.stringify(resolve(dir, `${value}.assets.json`)))
      .join('');
    expect(rest).not.toContain('Contained and healthy');
  });

  it("AssemblyReader: an asset-manifest artifact id, a templateFile's stack, a nested row", () => {
    const dir = join(tmp(), 'cdk.out');
    mkdirSync(dir);
    const read = (artifacts: Record<string, unknown>): string =>
      messageOf(() =>
        new AssemblyReader().getAllStacks(dir, {
          version: '54.0.0',
          artifacts,
        } as unknown as AssemblyManifest)
      );

    const artifact = read({
      [FORGED]: { type: 'cdk:asset-manifest', properties: { file: '../out.json' } },
    });
    expect(artifact).toContain(`Asset manifest artifact ${SHOWN} has file=`);
    expect(outside(artifact)).not.toContain('Contained and healthy');

    const template = read({
      Main: {
        type: 'aws:cloudformation:stack',
        properties: { stackName: FORGED, templateFile: '../out.json' },
      },
    });
    expect(template).toContain(`Stack ${SHOWN} has templateFile=`);
    expect(outside(template)).not.toContain('Contained and healthy');

    writeFileSync(join(dir, 'Main.template.json'), JSON.stringify(nestedRow(FORGED, '../out.json')));
    const nested = read({
      Main: {
        type: 'aws:cloudformation:stack',
        properties: { stackName: FORGED, templateFile: 'Main.template.json' },
      },
    });
    expect(nested).toContain(`Stack ${SHOWN} nested-stack ${SHOWN} has `);
    expect(outside(nested)).not.toContain('Contained and healthy');
  });

  it('the nested-template tree refusal: too-large and too-deep', () => {
    for (const kind of ['too-large', 'too-deep'] as const) {
      const text = renderNestedTemplateTreeDefect(
        { kind, chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }] },
        FORGED,
        'deploy'
      );
      expect(text).toContain(`under stack ${SHOWN} `);
      expect(outside(text)).not.toContain('Contained and healthy');
    }
  });

  it("cdkd local: a Lambda's absolute-path warning and escape refusal", () => {
    const outdir = join(tmp(), 'cdk.out');
    mkdirSync(outdir);
    const opts = {
      manifestDir: outdir,
      wrapError: (m: string) => new Error(m),
      assetOutdir: outdir,
      logicalId: FORGED,
    };

    warns.length = 0;
    resolveAssetCodeDirectory({ ...opts, assetPath: '/abs/elsewhere' });
    expect(warns[0]).toContain(`Lambda ${SHOWN} has an absolute `);
    expect(outside(warns[0]!)).not.toContain('Contained and healthy');

    const refusal = messageOf(() => resolveAssetCodeDirectory({ ...opts, assetPath: '../out' }));
    expect(refusal).toContain(`Lambda ${SHOWN} has Metadata['aws:asset:path']=`);
    expect(outside(refusal)).not.toContain('Contained and healthy');
  });

  it('NestedStackProvider: a missing child state names the child stack', async () => {
    const provider = new NestedStackProvider();
    const read = (
      provider as unknown as {
        readChildOutputsAsAttributes: (ctx: unknown, name: string, region: string) => Promise<unknown>;
      }
    ).readChildOutputsAsAttributes.bind(provider);
    const message = await read(
      { stateBackend: { getState: () => Promise.resolve(undefined) } },
      FORGED,
      'us-east-1'
    ).then(
      () => '',
      (e: unknown) => (e as Error).message
    );
    expect(message).toContain(`Child stack state ${SHOWN} not found after deploy`);
    expect(outside(message)).not.toContain('Contained and healthy');
  });
});
