import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { resolveSpiritRowAccessCaller } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-row-access-caller.util';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config';

const ADMIN_ROLE_ID = 'admin-role';
const MANAGER_ROLE_ID = 'manager-role';
const MEMBER_ROLE_ID = 'member-role';
const ALICE_MEMBER_ID = 'alice-member';

const STATE: SpiritRowAccessState = {
  adminRoleId: ADMIN_ROLE_ID,
  config: { version: 1, rules: [], seeAllRoleIds: [MANAGER_ROLE_ID] },
  configStatus: 'ok',
  configProblems: [],
};

const FAIL_CLOSED_STATE: SpiritRowAccessState = {
  adminRoleId: ADMIN_ROLE_ID,
  config: null,
  configStatus: 'invalid',
  configProblems: ['bad'],
};

const USER_AUTH_CONTEXT = {
  type: 'user',
  workspace: { id: 'workspace-1' },
  userWorkspaceId: 'user-workspace-1',
  user: { id: 'user-1' },
  workspaceMemberId: ALICE_MEMBER_ID,
  workspaceMember: { id: ALICE_MEMBER_ID },
} as unknown as WorkspaceAuthContext;

const APPLICATION_AUTH_CONTEXT = {
  type: 'application',
  workspace: { id: 'workspace-1' },
  application: { id: 'application-1', defaultRoleId: MEMBER_ROLE_ID },
} as unknown as WorkspaceAuthContext;

const API_KEY_AUTH_CONTEXT = {
  type: 'apiKey',
  workspace: { id: 'workspace-1' },
  apiKey: { id: 'api-key-1' },
} as unknown as WorkspaceAuthContext;

const SYSTEM_AUTH_CONTEXT = {
  type: 'system',
  workspace: { id: 'workspace-1' },
} as unknown as WorkspaceAuthContext;

const resolve = ({
  authContext = USER_AUTH_CONTEXT,
  rolePermissionConfig,
  shouldBypassPermissionChecks = false,
  state = STATE,
}: {
  authContext?: WorkspaceAuthContext;
  rolePermissionConfig: RolePermissionConfig | undefined;
  shouldBypassPermissionChecks?: boolean;
  state?: SpiritRowAccessState | undefined;
}) =>
  resolveSpiritRowAccessCaller({
    authContext,
    rolePermissionConfig,
    shouldBypassPermissionChecks,
    state,
  });

describe('resolveSpiritRowAccessCaller', () => {
  const originalEnforced = process.env.SPIRIT_ROW_ACCESS_ENFORCED;

  beforeEach(() => {
    process.env.SPIRIT_ROW_ACCESS_ENFORCED = 'true';
  });

  afterAll(() => {
    if (originalEnforced === undefined) {
      delete process.env.SPIRIT_ROW_ACCESS_ENFORCED;
    } else {
      process.env.SPIRIT_ROW_ACCESS_ENFORCED = originalEnforced;
    }
  });

  it('treats every caller as see-all while enforcement is off', () => {
    process.env.SPIRIT_ROW_ACCESS_ENFORCED = 'false';

    expect(
      resolve({
        rolePermissionConfig: { intersectionOf: [MEMBER_ROLE_ID] },
        state: FAIL_CLOSED_STATE,
      }),
    ).toEqual({ kind: 'see-all' });
  });

  it('treats the Admin role as see-all even though the config does not list it', () => {
    expect(
      resolve({ rolePermissionConfig: { intersectionOf: [ADMIN_ROLE_ID] } }),
    ).toEqual({ kind: 'see-all' });
  });

  it('treats a role listed in seeAllRoleIds as see-all', () => {
    expect(
      resolve({ rolePermissionConfig: { intersectionOf: [MANAGER_ROLE_ID] } }),
    ).toEqual({ kind: 'see-all' });
  });

  it('gives a Member user their own member id', () => {
    expect(
      resolve({ rolePermissionConfig: { intersectionOf: [MEMBER_ROLE_ID] } }),
    ).toEqual({ kind: 'owner', workspaceMemberId: ALICE_MEMBER_ID });
  });

  it('keeps a Member acting through an Admin app a Member', () => {
    expect(
      resolve({
        rolePermissionConfig: {
          intersectionOf: [MEMBER_ROLE_ID, ADMIN_ROLE_ID],
        },
      }),
    ).toEqual({ kind: 'owner', workspaceMemberId: ALICE_MEMBER_ID });
  });

  it('makes an Admin acting through a Manager app see-all, since both roles are see-all', () => {
    expect(
      resolve({
        rolePermissionConfig: {
          intersectionOf: [ADMIN_ROLE_ID, MANAGER_ROLE_ID],
        },
      }),
    ).toEqual({ kind: 'see-all' });
  });

  it('gives an app token with a non-see-all role no member id', () => {
    expect(
      resolve({
        authContext: APPLICATION_AUTH_CONTEXT,
        rolePermissionConfig: { intersectionOf: [MEMBER_ROLE_ID] },
      }),
    ).toEqual({ kind: 'owner', workspaceMemberId: null });
  });

  it('makes an API key with the Admin role see-all', () => {
    expect(
      resolve({
        authContext: API_KEY_AUTH_CONTEXT,
        rolePermissionConfig: { intersectionOf: [ADMIN_ROLE_ID] },
      }),
    ).toEqual({ kind: 'see-all' });
  });

  it('gives an API key with a non-see-all role no member id', () => {
    expect(
      resolve({
        authContext: API_KEY_AUTH_CONTEXT,
        rolePermissionConfig: { intersectionOf: [MEMBER_ROLE_ID] },
      }),
    ).toEqual({ kind: 'owner', workspaceMemberId: null });
  });

  it('reads an explicit agent role config, not the user behind the auth context', () => {
    expect(
      resolve({ rolePermissionConfig: { unionOf: [MEMBER_ROLE_ID] } }),
    ).toEqual({ kind: 'owner', workspaceMemberId: ALICE_MEMBER_ID });
  });

  it('treats a bypass repository as see-all', () => {
    expect(
      resolve({
        rolePermissionConfig: undefined,
        shouldBypassPermissionChecks: true,
      }),
    ).toEqual({ kind: 'see-all' });
  });

  it('treats a bypass role config as see-all', () => {
    expect(
      resolve({
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      }),
    ).toEqual({ kind: 'see-all' });
  });

  it('does not treat an empty role list as see-all', () => {
    expect(resolve({ rolePermissionConfig: { intersectionOf: [] } })).toEqual({
      kind: 'owner',
      workspaceMemberId: ALICE_MEMBER_ID,
    });
  });

  it('keeps the Admin role see-all when the config is missing', () => {
    expect(
      resolve({
        rolePermissionConfig: { intersectionOf: [ADMIN_ROLE_ID] },
        state: FAIL_CLOSED_STATE,
      }),
    ).toEqual({ kind: 'see-all' });
  });

  it('drops the Manager from see-all when the config is missing', () => {
    expect(
      resolve({
        rolePermissionConfig: { intersectionOf: [MANAGER_ROLE_ID] },
        state: FAIL_CLOSED_STATE,
      }),
    ).toEqual({ kind: 'owner', workspaceMemberId: ALICE_MEMBER_ID });
  });

  it('treats a system read with no role config as see-all (sync, import, timeline assembly)', () => {
    expect(
      resolve({
        authContext: SYSTEM_AUTH_CONTEXT,
        rolePermissionConfig: undefined,
      }),
    ).toEqual({ kind: 'see-all' });
  });

  it('keeps a system read with an explicit Member role config a Member with no member id', () => {
    expect(
      resolve({
        authContext: SYSTEM_AUTH_CONTEXT,
        rolePermissionConfig: { intersectionOf: [MEMBER_ROLE_ID] },
      }),
    ).toEqual({ kind: 'owner', workspaceMemberId: null });
  });
});
