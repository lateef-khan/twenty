import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';

import { isSystemAuthContext } from 'src/engine/core-modules/auth/guards/is-system-auth-context.guard';
import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type SpiritRowAccessCaller } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-caller.type';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { isSpiritRowAccessEnforced } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config';
import { getRoleIdsFromRolePermissionConfig } from 'src/engine/twenty-orm/utils/get-role-ids-from-role-permission-config.util';

// The role ids in force are the ones the repository computed its object
// permissions from: the user's role and an app's role for a user acting
// through an app, or an explicit config such as an AI agent's. Every one of
// them must be see-all, so a Member acting through an Admin app stays a Member.
export const resolveSpiritRowAccessCaller = ({
  authContext,
  rolePermissionConfig,
  shouldBypassPermissionChecks,
  state,
}: {
  authContext: WorkspaceAuthContext;
  rolePermissionConfig: RolePermissionConfig | undefined;
  shouldBypassPermissionChecks: boolean;
  state: SpiritRowAccessState | undefined;
}): SpiritRowAccessCaller => {
  if (
    !isSpiritRowAccessEnforced() ||
    shouldBypassPermissionChecks ||
    (isDefined(rolePermissionConfig) &&
      'shouldBypassPermissionChecks' in rolePermissionConfig)
  ) {
    return { kind: 'see-all' };
  }

  // Server-internal reads (sync, import, timeline assembly) run as the system
  // with no role config and rely on system objects being exempt from object
  // permissions. They are trusted like a bypass; code that returns such reads
  // to a user must guard the entry point itself (timeline, navigate tool).
  if (!isDefined(rolePermissionConfig) && isSystemAuthContext(authContext)) {
    return { kind: 'see-all' };
  }

  return resolveSpiritRowAccessCallerFromRoleIds({
    roleIdsInForce: isDefined(rolePermissionConfig)
      ? getRoleIdsFromRolePermissionConfig(rolePermissionConfig)
      : [],
    workspaceMemberId:
      isUserAuthContext(authContext) &&
      isNonEmptyString(authContext.workspaceMemberId)
        ? authContext.workspaceMemberId
        : null,
    state,
  });
};

// Callers that hold role ids but no repository (the live-update publisher)
// resolve the same way.
export const resolveSpiritRowAccessCallerFromRoleIds = ({
  roleIdsInForce,
  workspaceMemberId,
  state,
}: {
  roleIdsInForce: string[];
  workspaceMemberId: string | null;
  state: SpiritRowAccessState | undefined;
}): SpiritRowAccessCaller => {
  if (!isSpiritRowAccessEnforced()) {
    return { kind: 'see-all' };
  }

  const seeAllRoleIds = new Set<string>([
    ...(isNonEmptyString(state?.adminRoleId) ? [state.adminRoleId] : []),
    ...(state?.config?.seeAllRoleIds ?? []),
  ]);

  if (
    roleIdsInForce.length > 0 &&
    roleIdsInForce.every((roleId) => seeAllRoleIds.has(roleId))
  ) {
    return { kind: 'see-all' };
  }

  return {
    kind: 'owner',
    workspaceMemberId: isNonEmptyString(workspaceMemberId)
      ? workspaceMemberId
      : null,
  };
};
