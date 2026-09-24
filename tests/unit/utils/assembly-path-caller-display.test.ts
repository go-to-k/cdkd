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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
import type { AssemblyManifest, ArtifactManifest } from '../../../src/types/assembly.js';

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
