/**
 * `AssemblyReader` renders NOTHING from the cloud assembly raw
 * (issue go-to-k/cdkd#3277).
 *
 * Every value in this file's messages and log lines is chosen by whoever wrote
 * the assembly — a manifest key, a `stackName` property, a template key, a
 * `Metadata['aws:asset:path']` string, a `directoryName` the reader joins into
 * a path, and the `readFileSync` / `JSON.parse` failure text that quotes a
 * hand-fed file. Synthesis is the FIRST layer the CLI reaches, so on a hostile
 * assembly these are the lines a user is asked to trust; `formatError`
 * sanitizes only an error's `cause`, so a bare `message` reaches the terminal
 * as written and a C1 byte or a bidi override forges what reads as a second,
 * cdkd-authored line.
 *
 * Both polarities are pinned, and the HOSTILE cases carry a DISTINCT marker per
 * interpolated value rather than one shared marker: go-to-k/cdkd#3243 measured
 * that poisoning a single value leaves the message's other interpolations
 * unpinned, so dropping `displaySafe` from any one of them must red.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// `vi.hoisted` because these spies are referenced from the `vi.mock` factory,
// which is hoisted above ordinary top-level declarations. They must be STABLE
// objects: `AssemblyReader` captures `getLogger().child(...)` once per
// instance, so a factory minting a fresh spy per call records nothing readable.
const { loggerSpies } = vi.hoisted(() => ({
  loggerSpies: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerSpies, child: () => loggerSpies }),
}));

import { readFileSync } from 'node:fs';
import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import type { AssemblyManifest } from '../../../src/types/assembly.js';

/**
 * The class `displaySafe` deletes: C0 + DEL + the C1 range (`U+009B` is read as
 * CSI by xterm in UTF-8), the two Unicode line terminators, and the
 * Trojan-Source bidi overrides / isolates. Spelled here rather than imported so
 * the assertion cannot be satisfied by a helper that changed underneath it.
 */
// eslint-disable-next-line no-control-regex
const FORGING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** One hostile marker per interpolated value, each with its own sanitized twin. */
const HOSTILE = {
  stackName: { raw: 'Bad\u009bStack', clean: 'Bad Stack' },
  otherStack: { raw: 'Other\u0085Stack', clean: 'Other Stack' },
  logicalId: { raw: 'Child\u202eRow', clean: 'Child Row' },
  assetPath: { raw: '/abs/\u2028child.template.json', clean: '/abs/ child.template.json' },
  assetArtifact: { raw: 'Assets\u009dId', clean: 'Assets Id' },
  directory: { raw: 'stage\u0007dir', clean: 'stage dir' },
  version: { raw: '38.0.0\u009b31m', clean: '38.0.0 31m' },
  readError: { raw: 'EACCES: denied\nfake cdkd line', clean: 'EACCES: denied fake cdkd line' },
} as const;

function everyLoggedLine(): string[] {
  return [loggerSpies.debug, loggerSpies.info, loggerSpies.warn, loggerSpies.error].flatMap((spy) =>
    spy.mock.calls.map((call) => String(call[0]))
  );
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw');
}

describe('AssemblyReader renders assembly-controlled values display-safe (#3277)', () => {
  let reader: AssemblyReader;

  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
    loggerSpies.debug.mockReset();
    loggerSpies.info.mockReset();
    loggerSpies.warn.mockReset();
    loggerSpies.error.mockReset();
    reader = new AssemblyReader();
  });

  describe('the absolute aws:asset:path refusal', () => {
    it('sanitizes the stack name, the logical id AND the asset path', () => {
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          Artifact: {
            type: 'aws:cloudformation:stack',
            properties: {
              templateFile: 'Artifact.template.json',
              stackName: HOSTILE.stackName.raw,
            },
          },
        },
      };
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          Resources: {
            [HOSTILE.logicalId.raw]: {
              Type: 'AWS::CloudFormation::Stack',
              Metadata: { 'aws:asset:path': HOSTILE.assetPath.raw },
              Properties: {},
            },
          },
        })
      );

      const message = messageOf(() => reader.getAllStacks('/tmp/cdk.out', manifest));

      // The refusal still fires and still NAMES the row it refused.
      expect(message).toMatch(/which is absolute/);
      expect(message).toContain(`Stack '${HOSTILE.stackName.clean}'`);
      expect(message).toContain(`nested-stack '${HOSTILE.logicalId.clean}'`);
      expect(message).toContain(`Metadata['aws:asset:path']='${HOSTILE.assetPath.clean}'`);
      // ...and nothing that could forge a line survived any of the three.
      expect(message).not.toMatch(FORGING);
      expect(message).not.toContain(HOSTILE.stackName.raw);
      expect(message).not.toContain(HOSTILE.logicalId.raw);
      expect(message).not.toContain(HOSTILE.assetPath.raw);
    });

    it('leaves an ordinary long absolute path byte-identical and unquoted', () => {
      // The other polarity, and the reason the helper is `displaySafe` rather
      // than `displayIdent`: a legitimate asset path is long and carries `/`,
      // and a message whose only job is to say WHICH path was refused must not
      // truncate it, quote it or annotate it.
      const longPath = `/${'a'.repeat(300)}/nested/Child.nested.template.json`;
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          MyStack: {
            type: 'aws:cloudformation:stack',
            properties: { templateFile: 'MyStack.template.json', stackName: 'MyStack' },
          },
        },
      };
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          Resources: {
            ChildStack: {
              Type: 'AWS::CloudFormation::Stack',
              Metadata: { 'aws:asset:path': longPath },
              Properties: {},
            },
          },
        })
      );

      const message = messageOf(() => reader.getAllStacks('/tmp/cdk.out', manifest));

      expect(message).toContain(
        `Stack 'MyStack' nested-stack 'ChildStack' has Metadata['aws:asset:path']='${longPath}' which is absolute.`
      );
      // `displayIdent`'s 255-code-point cap would append `[cut: N ...]` here.
      expect(message).not.toContain('cut:');
    });

    it('leaves an ordinary path containing a space unquoted', () => {
      // The assertion the previous case cannot make: a SPACE is printable, so
      // `displaySafe` passes it through, while `displayIdent` reads it as a
      // non-plain identifier and renders the whole value as a JSON string
      // literal. A directory with a space in it is an ordinary `cdk.out`
      // parent on macOS and Windows, so the bare rendering is the correct one
      // and the quote is what must not appear.
      const spacedPath = '/Users/me/My Projects/cdk.out/Child.nested.template.json';
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          MyStack: {
            type: 'aws:cloudformation:stack',
            properties: { templateFile: 'MyStack.template.json', stackName: 'MyStack' },
          },
        },
      };
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          Resources: {
            ChildStack: {
              Type: 'AWS::CloudFormation::Stack',
              Metadata: { 'aws:asset:path': spacedPath },
              Properties: {},
            },
          },
        })
      );

      const message = messageOf(() => reader.getAllStacks('/tmp/cdk.out', manifest));

      expect(message).toContain(`Metadata['aws:asset:path']='${spacedPath}'`);
      expect(message).not.toMatch(/='"/);
    });
  });

  describe('the manifest and template read failures', () => {
    it('sanitizes the manifest path and the underlying read error', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error(HOSTILE.readError.raw);
      });

      const message = messageOf(() => reader.readManifest(`/tmp/${HOSTILE.directory.raw}`));

      expect(message).toContain(`/tmp/${HOSTILE.directory.clean}/manifest.json`);
      expect(message).toContain(HOSTILE.readError.clean);
      expect(message).not.toMatch(FORGING);
    });

    it('sanitizes the manifest version it logs on a successful read', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ version: HOSTILE.version.raw, artifacts: {} })
      );

      reader.readManifest('/tmp/cdk.out');

      expect(everyLoggedLine()).toContain(`Loaded manifest: version=${HOSTILE.version.clean}`);
      for (const line of everyLoggedLine()) expect(line).not.toMatch(FORGING);
    });

    it('sanitizes the nested-assembly directory name it warns about', () => {
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          Stage: {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: HOSTILE.directory.raw },
          },
        },
      };
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error(HOSTILE.readError.raw);
      });

      expect(reader.getAllStacks('/tmp/cdk.out', manifest)).toEqual([]);

      const warned = loggerSpies.warn.mock.calls.map((call) => String(call[0]));
      expect(warned.some((line) => line.includes(HOSTILE.directory.clean))).toBe(true);
      for (const line of everyLoggedLine()) expect(line).not.toMatch(FORGING);
    });

    it('sanitizes the stack name and the error in the template read failure', () => {
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          Artifact: {
            type: 'aws:cloudformation:stack',
            properties: {
              templateFile: 'Artifact.template.json',
              stackName: HOSTILE.stackName.raw,
            },
          },
        },
      };
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error(HOSTILE.readError.raw);
      });

      const message = messageOf(() => reader.getAllStacks('/tmp/cdk.out', manifest));

      expect(message).toContain(`Failed to read template for stack '${HOSTILE.stackName.clean}'`);
      expect(message).toContain(HOSTILE.readError.clean);
      expect(message).not.toMatch(FORGING);
    });

    it('sanitizes the stack name in the missing-templateFile refusal', () => {
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          Artifact: {
            type: 'aws:cloudformation:stack',
            properties: { stackName: HOSTILE.stackName.raw },
          },
        },
      };

      const message = messageOf(() => reader.getAllStacks('/tmp/cdk.out', manifest));

      expect(message).toBe(
        `Stack '${HOSTILE.stackName.clean}' has no templateFile property`
      );
      expect(message).not.toMatch(FORGING);
    });
  });

  describe('the stack-not-found refusal', () => {
    it('sanitizes both the requested name and every available name it lists', () => {
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          Artifact: {
            type: 'aws:cloudformation:stack',
            properties: {
              templateFile: 'Artifact.template.json',
              stackName: HOSTILE.stackName.raw,
            },
          },
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ Resources: {} }));

      const message = messageOf(() =>
        reader.getStack('/tmp/cdk.out', manifest, HOSTILE.otherStack.raw)
      );

      expect(message).toContain(`Stack '${HOSTILE.otherStack.clean}' not found in assembly.`);
      // The LISTED names take `displayIdent`, not `displaySafe`
      // (go-to-k/cdkd#3482): a stack name is an identifier interpolated into
      // prose, and the denylist passes the spaces this C1 byte collapses to.
      // A real CloudFormation name is `[A-Za-z0-9-]` and a display path adds
      // `/`, both inside `PLAIN_IDENT`, so only a crafted value is quoted —
      // which is what stops it reading as cdkd's own clause.
      expect(message).toContain(`Available: ${JSON.stringify(HOSTILE.stackName.clean)}`);
      // The REQUESTED name keeps `displaySafe`: it is the user's own argument
      // echoed back, already quoted by the sentence around it.
      expect(message).not.toMatch(FORGING);
      expect(message).not.toContain(HOSTILE.stackName.raw);
      expect(message).not.toContain(HOSTILE.otherStack.raw);
    });
  });

  describe('the debug lines a successful read emits', () => {
    it('sanitizes the stack name, the asset-manifest artifact id and each dependency name', () => {
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          [HOSTILE.assetArtifact.raw]: {
            type: 'cdk:asset-manifest',
            properties: { file: 'assets.json' },
          },
          Producer: {
            type: 'aws:cloudformation:stack',
            properties: {
              templateFile: 'Producer.template.json',
              stackName: HOSTILE.otherStack.raw,
            },
          },
          Consumer: {
            type: 'aws:cloudformation:stack',
            properties: {
              templateFile: 'Consumer.template.json',
              stackName: HOSTILE.stackName.raw,
            },
            dependencies: [HOSTILE.assetArtifact.raw, 'Producer'],
          },
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ Resources: {} }));

      reader.getAllStacks('/tmp/cdk.out', manifest);

      const lines = everyLoggedLine();
      expect(lines).toContain(`Stack: ${HOSTILE.stackName.clean}, Resources: 0`);
      expect(lines).toContain(
        `Found asset manifest for ${HOSTILE.stackName.clean}: ${HOSTILE.assetArtifact.clean}`
      );
      expect(lines).toContain(
        `Stack '${HOSTILE.stackName.clean}' depends on: [${HOSTILE.otherStack.clean}]`
      );
      for (const line of lines) expect(line).not.toMatch(FORGING);
    });

    it('leaves an ordinary assembly byte-identical in every line it logs', () => {
      const manifest: AssemblyManifest = {
        version: '38.0.0',
        artifacts: {
          MyStackAssets: { type: 'cdk:asset-manifest', properties: { file: 'assets.json' } },
          Producer: {
            type: 'aws:cloudformation:stack',
            properties: { templateFile: 'Producer.template.json', stackName: 'Producer' },
          },
          MyStack: {
            type: 'aws:cloudformation:stack',
            properties: { templateFile: 'MyStack.template.json', stackName: 'MyStack' },
            dependencies: ['MyStackAssets', 'Producer'],
          },
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ Resources: { Bucket: {} } }));

      reader.getAllStacks('/tmp/cdk.out', manifest);

      const lines = everyLoggedLine();
      expect(lines).toContain('Stack: MyStack, Resources: 1');
      expect(lines).toContain('Found asset manifest for MyStack: MyStackAssets');
      expect(lines).toContain("Stack 'MyStack' depends on: [Producer]");
    });
  });
});
