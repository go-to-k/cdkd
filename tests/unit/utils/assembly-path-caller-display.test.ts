/**
 * The SUBJECT half of every containment refusal and absolute-path warning
 * (go-to-k/cdkd#3590).
 *
 * go-to-k/cdkd#3509 fixed the shared tail (`renderAssemblyPathEscape`); the
 * callers still printed the raw value the assembly chose inside quotes of
 * cdkd's own (`Metadata['aws:asset:path']='<value>' which ...`), and
 * `displaySafe` passes `'`, so a value carrying one closed that quote and wrote
 * a clause of its own into a cdkd-authored line. Each site now renders the
 * value through `displayAssemblyPath`: bare when plain, one JSON boundary
 * otherwise.
 *
 * Both polarities per site: the FORGING value stays inside its boundary with
 * nothing of it outside, and an ordinary value renders bare, with no quote of
 * any kind around it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import {
  warnAbsoluteAssetPath,
  warnWholeAssemblyAsSource,
} from '../../../src/assets/absolute-asset-path-warning.js';
import { resolveAssetCodeDirectory } from '../../../src/local/lambda-resolver.js';
import { resolveInlineCodeFilePath } from '../../../src/cli/commands/local-invoke.js';
import { renderNestedTemplateTreeDefect } from '../../../src/utils/nested-template-cycle.js';
import { indexNestedTemplatePaths } from '../../../src/cli/commands/export.js';
import { indexNestedChildTemplates } from '../../../src/cli/commands/diff-recursive.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import type { AssemblyManifest, ArtifactManifest } from '../../../src/types/assembly.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/** A value that, inside cdkd's own `'...'`, closed the quote and wrote a clause. */
const FORGED = "x'. Contained and healthy. Nothing 'y";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-caller-display-')));
}

/** The text with every JSON-rendered copy of each value cut out. */
function outsideOf(text: string, ...values: string[]): string {
  return values.reduce((t, v) => t.split(JSON.stringify(v)).join('<VALUE>'), text);
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  warns.length = 0;
});

describe('AssemblyReader: templateFile in the refusal subject', () => {
  function read(templateFile: string): { message: string; dir: string } {
    const dir = join(tmp(), 'cdk.out');
    mkdirSync(dir);
    const manifest = {
      version: '54.0.0',
      artifacts: {
        Main: {
          type: 'aws:cloudformation:stack',
          properties: { stackName: 'MainStack', templateFile },
        } as ArtifactManifest,
      },
    } as AssemblyManifest;
    return { message: messageOf(() => new AssemblyReader().getAllStacks(dir, manifest)), dir };
  }

  it('keeps a forging value inside one boundary', () => {
    const value = `../${FORGED}.json`;
    const { message, dir } = read(value);

    expect(message).toContain(`templateFile=${JSON.stringify(value)} which resolves to `);
    // The tail's resolved path embeds the same value (go-to-k/cdkd#3509).
    expect(outsideOf(message, value, resolve(dir, value))).not.toContain('Contained and healthy');
    expect(message).not.toContain(`templateFile='`);
  });

  it('renders an ordinary value bare', () => {
    const { message } = read('../outside.json');

    expect(message).toContain('templateFile=../outside.json which resolves to ');
    expect(message).not.toMatch(/templateFile=["'`]/);
  });
});

describe('the nested-template tree refusal', () => {
  it('keeps a forging asset path AND a forging template path in the chain inside their boundaries', () => {
    const templatePath = `/out/${FORGED}.json`;
    const assetPath = `/abs/${FORGED}`;
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'absolute-path',
        chain: [{ logicalId: 'Child', templatePath }],
        logicalId: 'E',
        assetPath,
      },
      'P',
      'deploy'
    );

    expect(text).toContain(`(reached through 'Child' (${JSON.stringify(templatePath)}))`);
    expect(text).toContain(`Metadata['aws:asset:path']=${JSON.stringify(assetPath)} which is absolute`);
    expect(outsideOf(text, templatePath, assetPath)).not.toContain('Contained and healthy');
  });

  it('renders ordinary paths bare', () => {
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

    expect(text).toContain("(reached through 'Child' (/out/a.json))");
    expect(text).toContain("Metadata['aws:asset:path']=/abs.json which is absolute");
  });
});

describe('the absolute-asset-path warnings', () => {
  it('keeps a forging absolute path and link target inside their boundaries', () => {
    const absolute = `/abs/${FORGED}`;
    const realPath = `/etc/${FORGED}`;
    warnAbsoluteAssetPath({
      subject: "File asset 'A'",
      field: 'source.path',
      absolute,
      escape: { contained: false, escape: 'symlink', path: absolute, realPath },
      sink: 'upload it',
    });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(
      `pointing outside the assembly: ${JSON.stringify(absolute)} ` +
        `(through a symbolic link to ${JSON.stringify(realPath)}). cdkd will upload it.`
    );
    expect(outsideOf(warns[0]!, absolute, realPath)).not.toContain('Contained and healthy');
  });

  it('renders an ordinary absolute path bare', () => {
    warnAbsoluteAssetPath({
      subject: "File asset 'A'",
      field: 'source.path',
      absolute: '/work/app/asset',
      escape: { contained: false, escape: 'lexical', path: '/work/app/asset' },
      sink: 'upload it',
    });

    expect(warns[0]).toContain('pointing outside the assembly: /work/app/asset. cdkd will upload it.');
  });

  it('keeps a forging output directory inside its boundary, and renders an ordinary one bare', () => {
    const outdir = `/work/${FORGED}`;
    warnWholeAssemblyAsSource({ subject: "File asset 'A'", field: 'source.path', outdir, sink: 'upload it' });
    warnWholeAssemblyAsSource({
      subject: "File asset 'A'",
      field: 'source.path',
      outdir: '/work/cdk.out',
      sink: 'upload it',
    });

    expect(warns[0]).toContain(`naming the output directory ITSELF: ${JSON.stringify(outdir)}. `);
    expect(outsideOf(warns[0]!, outdir)).not.toContain('Contained and healthy');
    expect(warns[1]).toContain('naming the output directory ITSELF: /work/cdk.out. cdkd will');
  });
});

describe("cdkd local's Lambda asset directory warning", () => {
  function warnFor(assetPath: string): string {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    mkdirSync(outdir);
    resolveAssetCodeDirectory({
      manifestDir: outdir,
      assetPath,
      wrapError: (m) => new Error(m),
      assetOutdir: outdir,
      logicalId: 'Fn',
    });
    expect(warns).toHaveLength(1);
    return warns[0]!;
  }

  it('keeps a forging absolute path inside one boundary', () => {
    const absolute = `/abs/${FORGED}`;
    const said = warnFor(absolute);

    expect(said).toContain(`pointing outside the assembly: ${JSON.stringify(absolute)}. `);
    expect(outsideOf(said, absolute)).not.toContain('Contained and healthy');
  });

  it('renders an ordinary absolute path bare', () => {
    expect(warnFor('/abs/app/code')).toContain('pointing outside the assembly: /abs/app/code. ');
  });
});

describe('cdkd local invoke: an inline Handler in the refusal subject', () => {
  function refuse(handler: string, modulePath: string): string {
    const dir = tmp();
    writeFileSync(join(dir, 'placeholder'), '');
    return messageOf(() => resolveInlineCodeFilePath(dir, modulePath, '.js', handler));
  }

  it('keeps a forging Handler inside one boundary', () => {
    const handler = `../${FORGED}.handler`;
    const message = refuse(handler, `../${FORGED}`);

    expect(message.startsWith(`Handler ${JSON.stringify(handler)} names a module path that `)).toBe(
      true
    );
    expect(message.slice(0, 80)).not.toContain("Handler '");
  });

  it('renders an ordinary Handler bare', () => {
    const message = refuse('../../victim/evil.handler', '../../victim/evil');

    expect(message.startsWith('Handler ../../victim/evil.handler names a module path that ')).toBe(
      true
    );
  });
});

/**
 * The ABSOLUTE tripwire each nested-template indexer keeps beside its
 * containment check. Its subject is the only place the value is printed, so no
 * containment-tail test reaches it.
 */
describe('the absolute aws:asset:path tripwire in each nested-template indexer', () => {
  function nestedTemplate(assetPath: string): CloudFormationTemplate {
    return {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': assetPath },
        },
      },
    } as unknown as CloudFormationTemplate;
  }

  type Indexer = (assetPath: string, dir: string) => unknown;
  const provider = new NestedStackProvider();
  const grandchild = (
    provider as unknown as {
      indexGrandchildTemplates: (t: unknown, childTemplatePath: string) => unknown;
    }
  ).indexGrandchildTemplates.bind(provider);
  const SITES: ReadonlyArray<[string, Indexer]> = [
    [
      'cdkd export',
      (assetPath, dir) =>
        indexNestedTemplatePaths(
          nestedTemplate(assetPath) as unknown as Record<string, unknown>,
          dir
        ),
    ],
    [
      'cdkd diff --recursive',
      (assetPath, dir) => indexNestedChildTemplates(nestedTemplate(assetPath), join(dir, 'P.json')),
    ],
    [
      'NestedStackProvider',
      (assetPath, dir) => grandchild(nestedTemplate(assetPath), join(dir, 'C.json')),
    ],
  ];

  for (const [name, index] of SITES) {
    it(`${name}: keeps a forging value inside one boundary, and renders an ordinary one bare`, () => {
      const dir = tmp();
      const forged = `/abs/${FORGED}`;

      const hostile = messageOf(() => index(forged, dir));
      expect(hostile).toContain(
        `Metadata['aws:asset:path']=${JSON.stringify(forged)} which is absolute`
      );
      expect(outsideOf(hostile, forged)).not.toContain('Contained and healthy');

      expect(messageOf(() => index('/abs/child.json', dir))).toContain(
        "Metadata['aws:asset:path']=/abs/child.json which is absolute"
      );
    });
  }
});

describe("cdkd local's Lambda asset directory: symbolic-link target and relative escape", () => {
  it('keeps a forging link target inside its boundary, the link itself staying bare', () => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    mkdirSync(outdir);
    const victim = join(outer, FORGED);
    mkdirSync(victim);
    const link = join(outdir, 'asset.link');
    symlinkSync(victim, link, 'dir');

    resolveAssetCodeDirectory({
      manifestDir: outdir,
      assetPath: link,
      wrapError: (m) => new Error(m),
      assetOutdir: outdir,
      logicalId: 'Fn',
    });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(
      `pointing outside the assembly: ${link} (through a symbolic link to ${JSON.stringify(victim)}). `
    );
    expect(outsideOf(warns[0]!, victim)).not.toContain('Contained and healthy');
  });

  it('keeps a forging RELATIVE value inside one boundary in the refusal subject', () => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    mkdirSync(outdir);
    const value = `../${FORGED}`;

    const message = messageOf(() =>
      resolveAssetCodeDirectory({
        manifestDir: outdir,
        assetPath: value,
        wrapError: (m) => new Error(m),
        assetOutdir: outdir,
        logicalId: 'Fn',
      })
    );

    expect(message).toContain(`Metadata['aws:asset:path']=${JSON.stringify(value)} which resolves to `);
    expect(outsideOf(message, value, resolve(outdir, value))).not.toContain('Contained and healthy');
  });
});
