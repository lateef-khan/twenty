import { type ObjectRecord } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { type ToolExecutionContext } from 'src/engine/core-modules/tool/types/tool-execution-context.type';
import { PermissionsException } from 'src/engine/metadata-modules/permissions/permissions.exception';
import { isSpiritRowAccessEnforced } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';

// The navigate tool matches records from a bypass read. Keep only the ones
// the caller can read with their own role; a caller with no role config
// matches nothing.
export const filterSpiritNavigableRecords = async ({
  workspaceOrmManager,
  context,
  objectNameSingular,
  records,
}: {
  workspaceOrmManager: WorkspaceOrmManager;
  context: ToolExecutionContext;
  objectNameSingular: string;
  records: ObjectRecord[];
}): Promise<ObjectRecord[]> => {
  if (!isSpiritRowAccessEnforced()) {
    return records;
  }

  const { rolePermissionConfig } = context;

  if (!isDefined(rolePermissionConfig)) {
    return [];
  }

  const visibleRecords = await workspaceOrmManager.executeInWorkspaceContext(
    async () => {
      try {
        return await workspaceOrmManager
          .getRepository<ObjectRecord>(objectNameSingular, rolePermissionConfig)
          .find({ select: ['id'] });
      } catch (error) {
        if (error instanceof PermissionsException) {
          return [];
        }

        throw error;
      }
    },
    context.authContext ?? buildSystemAuthContext(context.workspaceId),
  );

  const visibleRecordIds = new Set(visibleRecords.map((record) => record.id));

  return records.filter((record) => visibleRecordIds.has(record.id));
};
