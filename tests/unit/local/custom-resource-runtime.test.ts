import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { S3Client } from '@aws-sdk/client-s3';

import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * go-to-k/cdkd#6206: the pieces of the `--aws-emulator` custom-resource
 * runtime that decide WHAT runs (the gate, the `ServiceToken` function chosen
 * from the assembly, the runtime-error mapping) and WHERE the response goes
 * (the `ResponseURL` re-signed for port 443), plus the `.zip` layer extraction
 * `s3deploy.BucketDeployment`'s `AwsCliLayer` needs.
 */

const wiring = vi.hoisted(() => ({
  active: vi.fn((): unknown => undefined),
}));
vi.mock('cdk-local/internal', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getActiveWorkloadAwsWiring: wiring.active };
});

const {
  chooseServiceTokenFunction,
  findServiceTokenFunctions,
  isRuntimeError,
  resetLocalCustomResourceRuntimeForTest,
  responseUrlForContainer,
} = await import('../../../src/local/custom-resource-runtime.js');
const { localCustomResourceRuntimeActive, setLocalCustomResourceRuntimeEnabled } =
  await import('../../../src/local/custom-resource-runtime-gate.js');
const { layerAssetDirectory } = await import('../../../src/local/layer-tree-copy.js');

function fn(code: string, handler = 'index.handler', runtime = 'nodejs22.x') {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: { Code: { ZipFile: code }, Handler: handler, Runtime: runtime },
  };
}

function stack(name: string, resources: Record<string, unknown>): StackInfo {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: { Resources: resources },
  } as unknown as StackInfo;
}

const CR = (serviceToken: unknown, type = 'Custom::S3AutoDeleteObjects') => ({
  Type: type,
  Properties: { ServiceToken: serviceToken },
});

const DEPLOYED = { Handler: 'index.handler', Runtime: 'nodejs22.x' };

beforeEach(() => {
  resetLocalCustomResourceRuntimeForTest();
  wiring.active.mockReset().mockReturnValue(undefined);
});

describe('localCustomResourceRuntimeActive', () => {
  it('is off without --aws-emulator, even when enabled', () => {
    expect(localCustomResourceRuntimeActive()).toBe(false);
  });

  it('is off in a forwarding (non-emulator) wiring', () => {
    wiring.active.mockReturnValue({ mode: 'forward' });
    expect(localCustomResourceRuntimeActive()).toBe(false);
  });

  it('is on under --aws-emulator by default', () => {
    wiring.active.mockReturnValue({ mode: 'emulator' });
    expect(localCustomResourceRuntimeActive()).toBe(true);
  });

  it('is off under --aws-emulator with --no-local-custom-resources', () => {
    wiring.active.mockReturnValue({ mode: 'emulator' });
    setLocalCustomResourceRuntimeEnabled(false);
    expect(localCustomResourceRuntimeActive()).toBe(false);
  });
});

describe('findServiceTokenFunctions', () => {
  it('follows Fn::GetAtt [Fn, Arn] and the dotted form to a same-stack function', () => {
    const s = stack('S', {
      A: CR({ 'Fn::GetAtt': ['Handler', 'Arn'] }),
      B: CR({ 'Fn::GetAtt': 'Handler.Arn' }, 'AWS::CloudFormation::CustomResource'),
      Handler: fn('x'),
    });
    expect(findServiceTokenFunctions([s], 'A').map((c) => c.logicalId)).toEqual(['Handler']);
    expect(findServiceTokenFunctions([s], 'B').map((c) => c.logicalId)).toEqual(['Handler']);
  });

  it('skips a non-custom resource, a literal ARN token and a non-function target', () => {
    const s = stack('S', {
      NotCustom: { Type: 'AWS::S3::Bucket', Properties: { ServiceToken: { 'Fn::GetAtt': ['H', 'Arn'] } } },
      Literal: CR('arn:aws:lambda:us-east-1:1:function:x'),
      Topic: CR({ 'Fn::GetAtt': ['T', 'Arn'] }),
      H: fn('x'),
      T: { Type: 'AWS::SNS::Topic' },
    });
    expect(findServiceTokenFunctions([s], 'NotCustom')).toEqual([]);
    expect(findServiceTokenFunctions([s], 'Literal')).toEqual([]);
    expect(findServiceTokenFunctions([s], 'Topic')).toEqual([]);
    expect(findServiceTokenFunctions([s], 'Missing')).toEqual([]);
  });
});

describe('chooseServiceTokenFunction', () => {
  const token = { 'Fn::GetAtt': ['H', 'Arn'] };

  it('picks the function when it agrees with the deployed handler and runtime', () => {
    const s = stack('S', { C: CR(token), H: fn('code') });
    const choice = chooseServiceTokenFunction(findServiceTokenFunctions([s], 'C'), DEPLOYED, undefined);
    expect('lambda' in choice && choice.lambda.logicalId).toBe('H');
  });

  it('refuses a candidate whose runtime differs from the deployed function', () => {
    const s = stack('S', { C: CR(token), H: fn('code', 'index.handler', 'python3.13') });
    const choice = chooseServiceTokenFunction(findServiceTokenFunctions([s], 'C'), DEPLOYED, undefined);
    expect(choice).toEqual({ reason: 'its function was not found in the local cloud assembly' });
  });

  it('narrows candidates in several stacks to the stack being deployed', () => {
    const a = stack('A', { C: CR(token), H: fn('code-a') });
    const b = stack('B', { C: CR(token), H: fn('code-b') });
    const candidates = findServiceTokenFunctions([a, b], 'C');
    const choice = chooseServiceTokenFunction(candidates, DEPLOYED, 'B');
    expect('lambda' in choice && choice.lambda.stack.stackName).toBe('B');
    expect(chooseServiceTokenFunction(candidates, DEPLOYED, undefined)).toEqual({
      reason: 'several functions in the local cloud assembly match it',
    });
  });

  it('accepts candidates in several stacks that run the same code', () => {
    const a = stack('A', { C: CR(token), H: fn('same') });
    const b = stack('B', { C: CR(token), H: fn('same') });
    const choice = chooseServiceTokenFunction(findServiceTokenFunctions([a, b], 'C'), DEPLOYED, undefined);
    expect('lambda' in choice).toBe(true);
  });
});

describe('isRuntimeError', () => {
  it('reads the runtime error answer, not a cfn-response or a null', () => {
    expect(isRuntimeError({ errorType: 'Error', errorMessage: 'boom' })).toBe(true);
    expect(isRuntimeError({ Status: 'SUCCESS' })).toBe(false);
    expect(isRuntimeError(null)).toBe(false);
    expect(isRuntimeError('null')).toBe(false);
  });
});

describe('responseUrlForContainer', () => {
  const s3 = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  });

  it('re-signs an emulator URL for the default HTTPS port and names the port to forward', async () => {
    wiring.active.mockReturnValue({ emulatorEndpoint: { url: 'https://127.0.0.1:9297' } });
    const out = await responseUrlForContainer(
      s3,
      'https://127.0.0.1:9297/cdkd-state-1/custom-resource-responses/r-1.json?X-Amz-Signature=old'
    );
    expect(out.forwardPort).toBe(9297);
    const url = new URL(out.url!);
    expect(url.origin).toBe('https://127.0.0.1');
    expect(url.pathname).toBe('/cdkd-state-1/custom-resource-responses/r-1.json');
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe('old');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('leaves a URL on another origin, and any URL without an emulator, as it is', async () => {
    wiring.active.mockReturnValue({ emulatorEndpoint: { url: 'https://127.0.0.1:9297' } });
    expect(await responseUrlForContainer(s3, 'https://s3:4566/b/k')).toEqual({});
    wiring.active.mockReturnValue(undefined);
    expect(await responseUrlForContainer(s3, 'https://127.0.0.1:9297/b/k')).toEqual({});
  });
});

describe('layerAssetDirectory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-layer-zip-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts a .zip file asset with its mode bits; the caller owns the tmpdir', async () => {
    const zip = new AdmZip();
    zip.addFile('awscli/aws', Buffer.from('#!/bin/sh\n'), '', 0o755);
    const zipPath = join(dir, 'asset.abc.zip');
    zip.writeZip(zipPath);

    const out = await layerAssetDirectory(zipPath);
    try {
      expect(out.tmpDir).toBe(out.dir);
      expect(readFileSync(join(out.dir, 'awscli/aws'), 'utf8')).toBe('#!/bin/sh\n');
      expect(statSync(join(out.dir, 'awscli/aws')).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  });

  it('returns a directory asset as it is', async () => {
    writeFileSync(join(dir, 'f'), 'x');
    expect(await layerAssetDirectory(dir)).toEqual({ dir });
  });
});
