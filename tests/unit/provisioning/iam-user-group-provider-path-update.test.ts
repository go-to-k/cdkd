import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetGroupCommand,
  GetUserCommand,
  UpdateGroupCommand,
  UpdateUserCommand,
} from '@aws-sdk/client-iam';

// #3723: an IAM User's or Group's `Path` is mutable in place (the schema does
// not make it create-only, and CloudFormation applies it with UpdateUser /
// UpdateGroup `NewPath`), but update() never sent it, so a changed Path
// deployed green while the principal stayed where it was.

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

// IAM's ARN embeds the path: the moved one is answered only once the move was
// sent, so a read placed before the move records the stale ARN and fails.
const arnOf = (kind: 'user' | 'group', name: string, moved: boolean): string =>
  `arn:aws:iam::123456789012:${kind}/${moved ? 'b' : 'a'}/${name}`;
const USER_ARN = arnOf('user', 'alice', true);
const GROUP_ARN = arnOf('group', 'devs', true);

function moves(): Array<[string, unknown]> {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => c instanceof UpdateUserCommand || c instanceof UpdateGroupCommand)
    .map((c) => [c.constructor.name, (c as UpdateUserCommand | UpdateGroupCommand).input]);
}

beforeEach(() => {
  mockSend.mockReset();
  let moved = false;
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof UpdateUserCommand || command instanceof UpdateGroupCommand) {
      moved = true;
    }
    if (command instanceof GetUserCommand) return { User: { Arn: arnOf('user', 'alice', moved) } };
    if (command instanceof GetGroupCommand) {
      return { Group: { Arn: arnOf('group', 'devs', moved) }, Users: [] };
    }
    return {};
  });
});

describe.each([
  {
    type: 'AWS::IAM::User',
    name: 'alice',
    nameKey: 'UserName',
    command: 'UpdateUserCommand',
    arn: USER_ARN,
  },
  {
    type: 'AWS::IAM::Group',
    name: 'devs',
    nameKey: 'GroupName',
    command: 'UpdateGroupCommand',
    arn: GROUP_ARN,
  },
])('$type Path on update', ({ type, name, nameKey, command, arn }) => {
  const update = (next: Record<string, unknown>, prev: Record<string, unknown>) =>
    new IAMUserGroupProvider().update(
      'Principal',
      name,
      type,
      { [nameKey]: name, ...next },
      { [nameKey]: name, ...prev }
    );

  it('moves the principal to a changed Path, and returns the ARN read after the move', async () => {
    const result = await update({ Path: '/b/' }, { Path: '/a/' });
    expect(moves()).toEqual([[command, { [nameKey]: name, NewPath: '/b/' }]]);
    expect(result.attributes).toEqual({ Arn: arn });
  });

  it('moves it back to the default / when the Path is removed', async () => {
    await update({}, { Path: '/a/' });
    expect(moves()).toEqual([[command, { [nameKey]: name, NewPath: '/' }]]);
  });

  it('moves it from the default / to a newly declared Path', async () => {
    await update({ Path: '/b/' }, {});
    expect(moves()).toEqual([[command, { [nameKey]: name, NewPath: '/b/' }]]);
  });

  it.each([
    ['an unchanged Path', { Path: '/a/' }, { Path: '/a/' }],
    ['an explicit / against none', { Path: '/' }, {}],
    ['no Path on either side', {}, {}],
  ])('sends no move for %s', async (_label, next, prev) => {
    await update(next, prev);
    expect(moves()).toEqual([]);
  });
});
