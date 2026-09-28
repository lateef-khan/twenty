import { isDefined } from 'twenty-shared/utils';

import { type ORMWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { isSpiritRowAccessEnforced } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { resolveSpiritRowAccessCaller } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-row-access-caller.util';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config';
import { resolveRolePermissionConfig } from 'src/engine/twenty-orm/utils/resolve-role-permission-config.util';

// How a service that reads with bypass today should read for the current
// caller: see-all callers keep the upstream bypass, everyone else reads with
// their own role, and a caller with no role reads nothing.
export type SpiritCallerScope =
  | { kind: 'bypass' }
  | { kind: 'caller'; rolePermissionConfig: RolePermissionConfig }
  | { kind: 'none' };

export const resolveSpiritCallerScope = (
  workspaceContext: ORMWorkspaceContext,
): SpiritCallerScope => {
  if (!isSpiritRowAccessEnforced()) {
    return { kind: 'bypass' };
  }

  const rolePermissionConfig = resolveRolePermissionConfig({
    authContext: workspaceContext.authContext,
    userWorkspaceRoleMap: workspaceContext.userWorkspaceRoleMap,
    apiKeyRoleMap: workspaceContext.apiKeyRoleMap,
  });

  if (!isDefined(rolePermissionConfig)) {
    return { kind: 'none' };
  }

  const caller = resolveSpiritRowAccessCaller({
    authContext: workspaceContext.authContext,
    rolePermissionConfig,
    shouldBypassPermissionChecks: false,
    state: workspaceContext.spiritRowAccess,
  });

  return caller.kind === 'see-all'
    ? { kind: 'bypass' }
    : { kind: 'caller', rolePermissionConfig };
};
