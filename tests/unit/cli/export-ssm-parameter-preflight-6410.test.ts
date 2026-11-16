import { describe, expect, it } from 'vite-plus/test';
import {
  findMissingSsmParameters,
  missingSsmParametersMessage,
} from '../../../src/cli/commands/export/ssm-parameter-preflight.js';

// go-to-k/cdkd#6410: CloudFormation resolves every SSM-typed Parameter when
// it creates the IMPORT changeset, so a missing one failed the export after a
// clean `--dry-run`.

const BOOTSTRAP_PATH = '/cdk-bootstrap/hnb659fds/version';

function cdkTemplate(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Parameters: {
      BootstrapVersion: {
        Type: 'AWS::SSM::Parameter::Value<String>',
        Default: BOOTSTRAP_PATH,
      },
      ...extra,
    },
    Resources: {},
  };
}

function notFound(): Error {
  return Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
}

/** A reader over `existing`; records every name it is asked for. */
function reader(existing: Set<string>, asked: string[] = []) {
  return async (name: string) => {
    asked.push(name);
    if (!existing.has(name)) throw notFound();
    return { value: '30', type: 'String' };
  };
}

describe('findMissingSsmParameters (go-to-k/cdkd#6410)', () => {
  it('reports BootstrapVersion when /cdk-bootstrap/<q>/version does not exist', async () => {
    const missing = await findMissingSsmParameters(cdkTemplate(), undefined, reader(new Set()));
    expect(missing).toEqual([{ parameterKey: 'BootstrapVersion', ssmName: BOOTSTRAP_PATH }]);
  });

  it('reports nothing when the parameter exists', async () => {
    const missing = await findMissingSsmParameters(
      cdkTemplate(),
      undefined,
      reader(new Set([BOOTSTRAP_PATH]))
    );
    expect(missing).toEqual([]);
  });

  it('checks the --parameter override, not the Default', async () => {
    const asked: string[] = [];
    const missing = await findMissingSsmParameters(
      cdkTemplate(),
      ['BootstrapVersion=/other/version'],
      reader(new Set(['/other/version']), asked)
    );
    expect(asked).toEqual(['/other/version']);
    expect(missing).toEqual([]);
  });

  it('never reads a parameter that is not SSM-typed', async () => {
    const asked: string[] = [];
    await findMissingSsmParameters(
      cdkTemplate({ Env: { Type: 'String', Default: '/looks/like/a/path' } }),
      undefined,
      reader(new Set([BOOTSTRAP_PATH]), asked)
    );
    expect(asked).toEqual([BOOTSTRAP_PATH]);
  });

  it('leaves any failure other than ParameterNotFound to CloudFormation', async () => {
    const missing = await findMissingSsmParameters(cdkTemplate(), undefined, async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    });
    expect(missing).toEqual([]);
  });

  it('reports nothing for a template with no Parameters', async () => {
    const missing = await findMissingSsmParameters({ Resources: {} }, undefined, reader(new Set()));
    expect(missing).toEqual([]);
  });
});

describe('missingSsmParametersMessage (go-to-k/cdkd#6410)', () => {
  it('names the path and sends a CDK bootstrap path to cdk bootstrap', () => {
    const msg = missingSsmParametersMessage(
      [{ parameterKey: 'BootstrapVersion', ssmName: BOOTSTRAP_PATH }],
      'us-east-1'
    );
    expect(msg).toContain(`'BootstrapVersion': SSM parameter ${BOOTSTRAP_PATH}`);
    expect(msg).toContain("created by 'cdk bootstrap',");
    expect(msg).toContain("'us-east-1'");
    expect(msg).toContain('Nothing was changed');
  });

  it('names a custom qualifier', () => {
    const msg = missingSsmParametersMessage(
      [{ parameterKey: 'BootstrapVersion', ssmName: '/cdk-bootstrap/myq123/version' }],
      'us-east-1'
    );
    expect(msg).toContain("Run it with --qualifier 'myq123' for");
  });

  it('offers --parameter for any other path', () => {
    const msg = missingSsmParametersMessage(
      [{ parameterKey: 'AmiId', ssmName: '/my/ami' }],
      'us-east-1'
    );
    expect(msg).toContain('--parameter AmiId=<an existing SSM parameter name>');
    expect(msg).not.toContain('cdk bootstrap');
  });

  it('never puts a non-plain key into the --parameter flag', () => {
    const msg = missingSsmParametersMessage(
      [{ parameterKey: 'A;rm -rf ~', ssmName: '/my/ami' }],
      'us-east-1'
    );
    expect(msg).not.toContain('rm -rf');
    expect(msg).toContain('--parameter <Key>=');
  });
});
