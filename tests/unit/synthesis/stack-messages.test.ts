import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock node:fs
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import {
  collectStackMessages,
  processStackMessages,
} from '../../../src/synthesis/stack-messages.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ArtifactManifest } from '../../../src/types/assembly.js';
import { SynthesisError } from '../../../src/utils/error-handler.js';

function stackArtifact(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    type: 'aws:cloudformation:stack',
    properties: { templateFile: 'MyStack.template.json' },
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeStack(messages: StackInfo['messages']): StackInfo {
  return {
    stackName: 'MyStack',
    displayName: 'MyStack',
    artifactId: 'MyStack',
    template: { Resources: {} },
    dependencyNames: [],
    ...(messages !== undefined && { messages }),
  } as StackInfo;
}

describe('collectStackMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collects error/warning/info entries from inline manifest metadata', () => {
    const artifact = stackArtifact({
      metadata: {
        '/MyStack': [
          { type: 'aws:cdk:error', data: 'boom' },
          { type: 'aws:cdk:warning', data: 'careful' },
        ],
        '/MyStack/Bucket': [{ type: 'aws:cdk:info', data: 'fyi' }],
      },
    });

    const messages = collectStackMessages('/asm', artifact);

    expect(messages).toEqual(
      expect.arrayContaining([
        { level: 'error', path: '/MyStack', message: 'boom' },
        { level: 'warning', path: '/MyStack', message: 'careful' },
        { level: 'info', path: '/MyStack/Bucket', message: 'fyi' },
      ])
    );
    expect(messages).toHaveLength(3);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('ignores non-message metadata entry types (aws:cdk:logicalId etc.)', () => {
    const artifact = stackArtifact({
      metadata: {
        '/MyStack/Bucket': [
          { type: 'aws:cdk:logicalId', data: 'Bucket12345' },
          { type: 'aws:cdk:path', data: 'MyStack/Bucket/Resource' },
        ],
      },
    });

    expect(collectStackMessages('/asm', artifact)).toEqual([]);
  });

  it('reads the additionalMetadataFile side file (current aws-cdk-lib layout)', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        '/MyStack': [{ type: 'aws:cdk:error', data: 'from side file', trace: ['a', 'b'] }],
      })
    );
    const artifact = stackArtifact({ additionalMetadataFile: 'MyStack.metadata.json' });

    const messages = collectStackMessages('/asm', artifact);

    expect(readFileSync).toHaveBeenCalledWith('/asm/MyStack.metadata.json', 'utf-8');
    expect(messages).toEqual([{ level: 'error', path: '/MyStack', message: 'from side file' }]);
  });

  it('merges inline metadata with the side file entries', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ '/MyStack': [{ type: 'aws:cdk:warning', data: 'side' }] })
    );
    const artifact = stackArtifact({
      metadata: { '/MyStack': [{ type: 'aws:cdk:error', data: 'inline' }] },
      additionalMetadataFile: 'MyStack.metadata.json',
    });

    const messages = collectStackMessages('/asm', artifact);

    expect(messages).toEqual(
      expect.arrayContaining([
        { level: 'error', path: '/MyStack', message: 'inline' },
        { level: 'warning', path: '/MyStack', message: 'side' },
      ])
    );
    expect(messages).toHaveLength(2);
  });

  it('throws SynthesisError when a referenced side file cannot be read', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    const artifact = stackArtifact({ additionalMetadataFile: 'MyStack.metadata.json' });

    expect(() => collectStackMessages('/asm', artifact)).toThrow(SynthesisError);
    expect(() => collectStackMessages('/asm', artifact)).toThrow(/MyStack\.metadata\.json/);
  });

  it('throws SynthesisError when the side file is malformed JSON', () => {
    vi.mocked(readFileSync).mockReturnValue('{not json');
    const artifact = stackArtifact({ additionalMetadataFile: 'MyStack.metadata.json' });

    expect(() => collectStackMessages('/asm', artifact)).toThrow(SynthesisError);
  });

  it('throws SynthesisError (not a raw TypeError) when the side file is valid JSON of the wrong shape', () => {
    const artifact = stackArtifact({ additionalMetadataFile: 'MyStack.metadata.json' });

    // Non-array path value: spreading it would otherwise throw a raw TypeError
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ '/MyStack': 42 }));
    expect(() => collectStackMessages('/asm', artifact)).toThrow(SynthesisError);

    // String path value: would otherwise spread into per-character garbage entries
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ '/MyStack': 'oops' }));
    expect(() => collectStackMessages('/asm', artifact)).toThrow(SynthesisError);

    // Top-level array / null instead of a record
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([{ type: 'aws:cdk:error' }]));
    expect(() => collectStackMessages('/asm', artifact)).toThrow(SynthesisError);
    vi.mocked(readFileSync).mockReturnValue('null');
    expect(() => collectStackMessages('/asm', artifact)).toThrow(SynthesisError);
  });

  it('renders an entry with no data as an empty message, not "undefined"', () => {
    const artifact = stackArtifact({
      metadata: { '/MyStack': [{ type: 'aws:cdk:warning' }] },
    });

    expect(collectStackMessages('/asm', artifact)).toEqual([
      { level: 'warning', path: '/MyStack', message: '' },
    ]);
  });

  it('ignores entry types that collide with Object.prototype keys', () => {
    const artifact = stackArtifact({
      metadata: { '/MyStack': [{ type: 'constructor', data: 'x' }, { type: 'toString', data: 'y' }] },
    });

    expect(collectStackMessages('/asm', artifact)).toEqual([]);
  });

  it('JSON-stringifies non-string message data', () => {
    const artifact = stackArtifact({
      metadata: { '/MyStack': [{ type: 'aws:cdk:error', data: { code: 42 } }] },
    });

    expect(collectStackMessages('/asm', artifact)).toEqual([
      { level: 'error', path: '/MyStack', message: '{"code":42}' },
    ]);
  });

  it('returns empty for an artifact with no metadata at all', () => {
    expect(collectStackMessages('/asm', stackArtifact())).toEqual([]);
  });

  it('tolerates a non-array metadata value without throwing', () => {
    const artifact = stackArtifact({
      metadata: { '/MyStack': 'garbage' } as unknown as ArtifactManifest['metadata'],
    });

    expect(collectStackMessages('/asm', artifact)).toEqual([]);
  });
});

describe('processStackMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs warnings and infos in CDK CLI format without throwing', () => {
    const logger = makeLogger();
    const stack = makeStack([
      { level: 'warning', path: '/MyStack/Fn', message: 'deprecated runtime' },
      { level: 'info', path: '/MyStack', message: 'heads up' },
    ]);

    processStackMessages([stack], logger);

    expect(logger.warn).toHaveBeenCalledWith('[Warning at /MyStack/Fn] deprecated runtime');
    expect(logger.info).toHaveBeenCalledWith('[Info at /MyStack] heads up');
  });

  it('logs all error lines and throws "Found errors" (CDK CLI parity)', () => {
    const logger = makeLogger();
    const stack = makeStack([
      { level: 'error', path: '/MyStack', message: 'first problem' },
      { level: 'warning', path: '/MyStack', message: 'also this' },
      { level: 'error', path: '/MyStack/Bucket', message: 'second problem' },
    ]);

    let thrown: unknown;
    try {
      processStackMessages([stack], logger);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SynthesisError);
    expect((thrown as Error).message).toBe('Found errors');
    expect(logger.error).toHaveBeenCalledWith('[Error at /MyStack] first problem');
    expect(logger.error).toHaveBeenCalledWith('[Error at /MyStack/Bucket] second problem');
    // The warning is still displayed before the throw
    expect(logger.warn).toHaveBeenCalledWith('[Warning at /MyStack] also this');
  });

  it('logs errors across multiple stacks before throwing', () => {
    const logger = makeLogger();
    const stackA = { ...makeStack([{ level: 'error', path: '/A', message: 'a' }]), stackName: 'A' };
    const stackB = { ...makeStack([{ level: 'error', path: '/B', message: 'b' }]), stackName: 'B' };

    expect(() => processStackMessages([stackA, stackB], logger)).toThrow('Found errors');
    expect(logger.error).toHaveBeenCalledWith('[Error at /A] a');
    expect(logger.error).toHaveBeenCalledWith('[Error at /B] b');
  });

  it('is a no-op for stacks without a messages field', () => {
    const logger = makeLogger();

    expect(() => processStackMessages([makeStack(undefined)], logger)).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('--strict: fails on warnings with "Found warnings (--strict mode)" (issue #1230)', () => {
    const logger = makeLogger();
    const stack = makeStack([{ level: 'warning', path: '/S', message: 'w' }]);

    expect(() => processStackMessages([stack], logger, { strict: true })).toThrow(
      'Found warnings (--strict mode)'
    );
    // The warning line is still displayed
    expect(logger.warn).toHaveBeenCalledWith('[Warning at /S] w');
  });

  it('--strict: info-only stacks still pass', () => {
    const logger = makeLogger();
    const stack = makeStack([{ level: 'info', path: '/S', message: 'i' }]);

    expect(() => processStackMessages([stack], logger, { strict: true })).not.toThrow();
  });

  it('--strict: errors win over strict warnings ("Found errors" thrown)', () => {
    const logger = makeLogger();
    const stack = makeStack([
      { level: 'warning', path: '/S', message: 'w' },
      { level: 'error', path: '/S', message: 'e' },
    ]);

    expect(() => processStackMessages([stack], logger, { strict: true })).toThrow('Found errors');
  });

  it('--ignore-errors: errors are displayed but the run proceeds (issue #1230)', () => {
    const logger = makeLogger();
    const stack = makeStack([{ level: 'error', path: '/S', message: 'e' }]);

    expect(() => processStackMessages([stack], logger, { ignoreErrors: true })).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[Error at /S] e');
  });

  it('--strict wins when combined with --ignore-errors (CDK CLI precedence)', () => {
    const logger = makeLogger();
    const errorStack = makeStack([{ level: 'error', path: '/S', message: 'e' }]);
    const warnStack = makeStack([{ level: 'warning', path: '/S', message: 'w' }]);

    expect(() =>
      processStackMessages([errorStack], logger, { strict: true, ignoreErrors: true })
    ).toThrow('Found errors');
    expect(() =>
      processStackMessages([warnStack], logger, { strict: true, ignoreErrors: true })
    ).toThrow('Found warnings (--strict mode)');
  });
});
