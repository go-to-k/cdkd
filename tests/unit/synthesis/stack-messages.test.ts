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

  it('throws SynthesisError with all error lines + "Found errors" (CDK CLI parity)', () => {
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
    const message = (thrown as Error).message;
    expect(message).toContain('[Error at /MyStack] first problem');
    expect(message).toContain('[Error at /MyStack/Bucket] second problem');
    expect(message).toContain('Found errors');
    // The warning is still displayed before the throw
    expect(logger.warn).toHaveBeenCalledWith('[Warning at /MyStack] also this');
  });

  it('aggregates errors across multiple stacks', () => {
    const logger = makeLogger();
    const stackA = { ...makeStack([{ level: 'error', path: '/A', message: 'a' }]), stackName: 'A' };
    const stackB = { ...makeStack([{ level: 'error', path: '/B', message: 'b' }]), stackName: 'B' };

    expect(() => processStackMessages([stackA, stackB], logger)).toThrow(/\[Error at \/A\] a[\s\S]*\[Error at \/B\] b/);
  });

  it('is a no-op for stacks without a messages field', () => {
    const logger = makeLogger();

    expect(() => processStackMessages([makeStack(undefined)], logger)).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
