import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { buildSpiritVisibilityCondition } from 'src/engine/twenty-orm/spirit-row-access/utils/build-spirit-visibility-condition.util';
import { resolveSpiritOwnerJoinColumnName } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-join-column-name.util';
import { resolveSpiritOwnerRuleTarget } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-rule-target.util';
import { resolveSpiritRowAccessCaller } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-row-access-caller.util';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config';
import { type RowAccessPolicy } from 'src/engine/twenty-orm/types/row-access-policy.type';
import { combineSqlConditions } from 'src/engine/twenty-orm/utils/combine-sql-conditions.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

// The part of the repository options the rule reads. Structural, so the
// repository passes its own options object.
export type SpiritRepositoryOptions = {
  internalContext: WorkspaceInternalContext;
  authContext: WorkspaceAuthContext;
  rolePermissionConfig?: RolePermissionConfig;
  shouldBypassPermissionChecks: boolean;
  flatObjectMetadata: FlatObjectMetadata;
  tableShapeByObjectMetadataId: (
    objectMetadataId: string,
  ) => WorkspaceTableShape;
};

const resolveCaller = (options: SpiritRepositoryOptions) =>
  resolveSpiritRowAccessCaller({
    authContext: options.authContext,
    rolePermissionConfig: options.rolePermissionConfig,
    shouldBypassPermissionChecks: options.shouldBypassPermissionChecks,
    state: options.internalContext.spiritRowAccess,
  });

const resolveTableExpression =
  (options: SpiritRepositoryOptions) =>
  (objectMetadataId: string): string => {
    const tableShape = options.tableShapeByObjectMetadataId(objectMetadataId);

    return `${escapeIdentifier(tableShape.schemaName)}.${escapeIdentifier(
      tableShape.tableName,
    )}`;
  };

// flatObjectMetadata is the object behind the alias, which for a join is not
// the repository's own object.
export const applySpiritOwnerRuleToPolicy = ({
  policy,
  repositoryOptions,
  flatObjectMetadata,
  alias,
}: {
  policy: RowAccessPolicy;
  repositoryOptions: SpiritRepositoryOptions;
  flatObjectMetadata: FlatObjectMetadata;
  alias: string;
}): RowAccessPolicy => {
  const { internalContext } = repositoryOptions;

  const condition = buildSpiritVisibilityCondition({
    context: {
      state: internalContext.spiritRowAccess,
      caller: resolveCaller(repositoryOptions),
      flatObjectMetadataMaps: internalContext.flatObjectMetadataMaps,
      flatFieldMetadataMaps: internalContext.flatFieldMetadataMaps,
      objectIdByNameSingular: internalContext.objectIdByNameSingular,
      resolveTableExpression: resolveTableExpression(repositoryOptions),
    },
    flatObjectMetadata,
    alias,
  });

  if (!isDefined(condition)) {
    return policy;
  }

  switch (policy.kind) {
    case 'denied':
      return policy;
    case 'open':
      return { kind: 'gated', condition };
    case 'gated':
      return {
        kind: 'gated',
        condition: combineSqlConditions([policy.condition, condition]),
      };
  }
};

const resolveOwnerInsertOverride = (
  options: SpiritRepositoryOptions,
): { joinColumnName: string; workspaceMemberId: string | null } | undefined => {
  const caller = resolveCaller(options);

  if (caller.kind === 'see-all') {
    return undefined;
  }

  const { internalContext } = options;

  const { rule, ownerFieldMetadata, workspaceMemberObjectMetadataId } =
    resolveSpiritOwnerRuleTarget({
      state: internalContext.spiritRowAccess,
      flatObjectMetadata: options.flatObjectMetadata,
      flatFieldMetadataMaps: internalContext.flatFieldMetadataMaps,
      objectIdByNameSingular: internalContext.objectIdByNameSingular,
    });

  if (!isDefined(rule)) {
    return undefined;
  }

  const joinColumnName = resolveSpiritOwnerJoinColumnName({
    rule,
    ownerFieldMetadata,
    workspaceMemberObjectMetadataId,
  });

  if (!isDefined(joinColumnName)) {
    return undefined;
  }

  return { joinColumnName, workspaceMemberId: caller.workspaceMemberId };
};


export const isSpiritInsertHiddenFromCaller = (
  options: SpiritRepositoryOptions,
): boolean => resolveOwnerInsertOverride(options)?.workspaceMemberId === null;

export const prepareSpiritOwnerInsert = <
  TRecord extends Record<string, unknown>,
>(
  options: SpiritRepositoryOptions,
  records: TRecord[],
): {
  records: TRecord[];
  lockCheckedColumns: (columnNames: string[]) => string[];
} => {
  const override = resolveOwnerInsertOverride(options);

  if (!isDefined(override)) {
    return { records, lockCheckedColumns: (columnNames) => columnNames };
  }

  return {
    records: records.map((record) => ({
      ...record,
      [override.joinColumnName]: override.workspaceMemberId,
    })),
    lockCheckedColumns: (columnNames) =>
      columnNames.filter(
        (columnName) => columnName !== override.joinColumnName,
      ),
  };
};
