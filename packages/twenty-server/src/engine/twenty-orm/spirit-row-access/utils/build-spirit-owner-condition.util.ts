import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';

import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import {
  SPIRIT_OWNER_ALWAYS_FALSE_SQL,
  SPIRIT_OWNER_PARAMETER_PREFIX,
} from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-owner-condition.constant';
import { type SpiritRowAccessCaller } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-caller.type';
import { type SpiritRowAccessRule } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-config.type';
import { resolveSpiritOwnerJoinColumnName } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-join-column-name.util';
import { type SqlCondition } from 'src/engine/twenty-orm/types/row-access-policy.type';
import {
  escapeIdentifier,
  removeSqlDDLInjection,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const ALWAYS_FALSE: SqlCondition = {
  sql: SPIRIT_OWNER_ALWAYS_FALSE_SQL,
  parameters: {},
};

export const buildSpiritOwnerCondition = ({
  rule,
  caller,
  alias,
  ownerFieldMetadata,
  workspaceMemberObjectMetadataId,
}: {
  rule: SpiritRowAccessRule | undefined;
  caller: SpiritRowAccessCaller;
  alias: string;
  ownerFieldMetadata: OrmFlatFieldMetadata | undefined;
  workspaceMemberObjectMetadataId: string | undefined;
}): SqlCondition | undefined => {
  if (!isDefined(rule) || !rule.isEnabled) {
    return undefined;
  }

  if (caller.kind === 'see-all') {
    return undefined;
  }

  if (!isNonEmptyString(caller.workspaceMemberId)) {
    return ALWAYS_FALSE;
  }

  const joinColumnName = resolveSpiritOwnerJoinColumnName({
    rule,
    ownerFieldMetadata,
    workspaceMemberObjectMetadataId,
  });

  if (!isDefined(joinColumnName)) {
    return ALWAYS_FALSE;
  }

  // compileNamedParameters only reads [A-Za-z0-9_] in a parameter name
  const parameterName = `${SPIRIT_OWNER_PARAMETER_PREFIX}${removeSqlDDLInjection(alias)}`;

  return {
    sql: `${escapeIdentifier(alias)}.${escapeIdentifier(joinColumnName)} = :${parameterName}`,
    parameters: { [parameterName]: caller.workspaceMemberId },
  };
};
