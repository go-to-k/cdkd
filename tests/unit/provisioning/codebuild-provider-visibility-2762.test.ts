import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('@aws-sdk/client-codebuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codebuild')>();
  return {
    ...actual,
    CodeBuildClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';
import {
  BatchGetProjectsCommand,
  CreateProjectCommand,
  UpdateProjectCommand,
  UpdateProjectVisibilityCommand,
} from '@aws-sdk/client-codebuild';
import {
  createdBeforeFailure,
  isAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::CodeBuild::Project';
const ARN = 'arn:aws:codebuild:us-east-1:111122223333:project/proj';
const ROLE = 'arn:aws:iam::111122223333:role/access';
const BASE = {
  Name: 'proj',
  Source: { Type: 'NO_SOURCE', BuildSpec: 'version: 0.2' },
  Artifacts: { Type: 'NO_ARTIFACTS' },
  Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'img' },
  ServiceRole: 'arn:aws:iam::111122223333:role/svc',
};

function sent<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

describe('CodeBuildProvider Visibility / ResourceAccessRole (go-to-k/cdkd#2762)', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ project: { name: 'proj', arn: ARN } });
    provider = new CodeBuildProvider();
  });

  it('declares both handled and leaves Triggers unhandled', () => {
    const handled = provider.handledProperties.get(TYPE);
    expect(handled?.has('Visibility')).toBe(true);
    expect(handled?.has('ResourceAccessRole')).toBe(true);
    expect(handled?.has('Triggers')).toBe(false);
  });

  it('sends the pair through UpdateProjectVisibility after CreateProject', async () => {
    await provider.create('L', TYPE, {
      ...BASE,
      Visibility: 'PUBLIC_READ',
      ResourceAccessRole: ROLE,
    });
    const order = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(order).toEqual(['CreateProjectCommand', 'UpdateProjectVisibilityCommand']);
    expect(sent(UpdateProjectVisibilityCommand)[0]?.input).toEqual({
      projectArn: ARN,
      projectVisibility: 'PUBLIC_READ',
      resourceAccessRole: ROLE,
    });
    // CreateProject has no visibility member: neither key may leak onto it.
    const create = sent(CreateProjectCommand)[0]?.input as unknown as Record<string, unknown>;
    expect(create).not.toHaveProperty('projectVisibility');
    expect(create).not.toHaveProperty('resourceAccessRole');
  });

  it('sends PRIVATE when only a ResourceAccessRole is declared (the call requires a visibility)', async () => {
    await provider.create('L', TYPE, { ...BASE, ResourceAccessRole: ROLE });
    expect(sent(UpdateProjectVisibilityCommand)[0]?.input).toEqual({
      projectArn: ARN,
      projectVisibility: 'PRIVATE',
      resourceAccessRole: ROLE,
    });
  });

  it('makes no visibility call for an undeclared or default-only pair', async () => {
    await provider.create('L', TYPE, { ...BASE });
    await provider.create('L', TYPE, { ...BASE, Visibility: 'PRIVATE' });
    await provider.create('L', TYPE, { ...BASE, ResourceAccessRole: '' });
    expect(sent(CreateProjectCommand)).toHaveLength(3);
    expect(sent(UpdateProjectVisibilityCommand)).toHaveLength(0);
  });

  it('refuses an unusable Visibility before CreateProject on a template-path create', async () => {
    await expect(
      provider.create('L', TYPE, { ...BASE, Visibility: { Ref: 'Unresolved' } })
    ).rejects.toThrow(/Visibility must be a non-empty string/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses an unusable ResourceAccessRole before CreateProject', async () => {
    await expect(
      provider.create('L', TYPE, { ...BASE, ResourceAccessRole: ['x'] })
    ).rejects.toThrow(/ResourceAccessRole must be a non-empty string/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('creates the project at the default with a warning on a state replay', async () => {
    await provider.create(
      'L',
      TYPE,
      { ...BASE, Visibility: 42 },
      { replayingState: true }
    );
    expect(sent(CreateProjectCommand)).toHaveLength(1);
    expect(sent(UpdateProjectVisibilityCommand)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Replaying a state record'));
  });

  it('marks a visibility failure as an auxiliary one naming the created project', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof UpdateProjectVisibilityCommand) {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
      }
      return Promise.resolve({ project: { name: 'proj', arn: ARN } });
    });
    const error = await provider
      .create('L', TYPE, { ...BASE, Visibility: 'PUBLIC_READ' })
      .catch((e: unknown) => e);
    expect(createdBeforeFailure(error, 'L', TYPE)).toBe('proj');
    expect(isAuxiliaryFailure((error as Error).cause)).toBe(true);
  });

  it("does not mark CreateProject's own failure", async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' })
    );
    const error = await provider
      .create('L', TYPE, { ...BASE, Visibility: 'PUBLIC_READ' })
      .catch((e: unknown) => e);
    expect(createdBeforeFailure(error, 'L', TYPE)).toBeUndefined();
  });

  it('updates the pair when it changed, using the ARN UpdateProject returned', async () => {
    await provider.update(
      'L',
      'proj',
      TYPE,
      { ...BASE, Visibility: 'PUBLIC_READ', ResourceAccessRole: ROLE },
      { ...BASE }
    );
    const order = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(order).toEqual(['UpdateProjectCommand', 'UpdateProjectVisibilityCommand']);
    expect(sent(UpdateProjectVisibilityCommand)[0]?.input).toEqual({
      projectArn: ARN,
      projectVisibility: 'PUBLIC_READ',
      resourceAccessRole: ROLE,
    });
  });

  it('resets a REMOVED pair to PRIVATE with no role, as CloudFormation does', async () => {
    await provider.update(
      'L',
      'proj',
      TYPE,
      { ...BASE },
      { ...BASE, Visibility: 'PUBLIC_READ', ResourceAccessRole: ROLE }
    );
    expect(sent(UpdateProjectVisibilityCommand)[0]?.input).toEqual({
      projectArn: ARN,
      projectVisibility: 'PRIVATE',
    });
  });

  it('clears a removed role while the visibility stays PUBLIC_READ', async () => {
    await provider.update(
      'L',
      'proj',
      TYPE,
      { ...BASE, Visibility: 'PUBLIC_READ' },
      { ...BASE, Visibility: 'PUBLIC_READ', ResourceAccessRole: ROLE }
    );
    expect(sent(UpdateProjectVisibilityCommand)[0]?.input).toEqual({
      projectArn: ARN,
      projectVisibility: 'PUBLIC_READ',
    });
  });

  it('makes no visibility call when the pair is unchanged', async () => {
    await provider.update(
      'L',
      'proj',
      TYPE,
      { ...BASE, Visibility: 'PUBLIC_READ', ResourceAccessRole: ROLE },
      { ...BASE, Visibility: 'PUBLIC_READ', ResourceAccessRole: ROLE }
    );
    // The readback placeholder '' and an absent role are the same "no role".
    await provider.update(
      'L',
      'proj',
      TYPE,
      { ...BASE, Visibility: 'PRIVATE', ResourceAccessRole: '' },
      { ...BASE }
    );
    expect(sent(UpdateProjectCommand)).toHaveLength(2);
    expect(sent(UpdateProjectVisibilityCommand)).toHaveLength(0);
  });

  it('warns and leaves the live pair alone when the UPDATE desired value is unusable', async () => {
    await provider.update(
      'L',
      'proj',
      TYPE,
      { ...BASE, Visibility: { Ref: 'X' } },
      { ...BASE, Visibility: 'PUBLIC_READ' }
    );
    expect(sent(UpdateProjectVisibilityCommand)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Leaving the visibility of CodeBuild Project proj unchanged')
    );
  });

  it('reads Visibility back from BatchGetProjects', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof BatchGetProjectsCommand) {
        return Promise.resolve({
          projects: [
            {
              name: 'proj',
              arn: ARN,
              projectVisibility: 'PUBLIC_READ',
              resourceAccessRole: ROLE,
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const result = (await provider.readCurrentState('proj', 'L', TYPE)) as Record<
      string,
      unknown
    >;
    expect(result['Visibility']).toBe('PUBLIC_READ');
    expect(result['ResourceAccessRole']).toBe(ROLE);
  });
});
