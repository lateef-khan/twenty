import { isNonEmptyString } from '@sniptt/guards';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { isFlatFieldMetadataOfType } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-flat-field-metadata-of-type.util';
import { type SpiritRowAccessRule } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-config.type';

// Returns undefined when the owner field cannot back the rule (missing,
// inactive, on another object, or not MANY_TO_ONE to workspaceMember); the
// caller must then fail closed.
export const resolveSpiritOwnerJoinColumnName = ({
  rule,
  ownerFieldMetadata,
  workspaceMemberObjectMetadataId,
}: {
  rule: SpiritRowAccessRule;
  ownerFieldMetadata: OrmFlatFieldMetadata | undefined;
  workspaceMemberObjectMetadataId: string | undefined;
}): string | undefined => {
  if (
    !isDefined(ownerFieldMetadata) ||
    !isNonEmptyString(workspaceMemberObjectMetadataId) ||
    ownerFieldMetadata.isActive === false ||
    ownerFieldMetadata.objectMetadataId !== rule.objectMetadataId ||
    ownerFieldMetadata.relationTargetObjectMetadataId !==
      workspaceMemberObjectMetadataId ||
    !isFlatFieldMetadataOfType(ownerFieldMetadata, FieldMetadataType.RELATION)
  ) {
    return undefined;
  }

  const settings = ownerFieldMetadata.settings;

  if (
    !isDefined(settings) ||
    settings.relationType !== RelationType.MANY_TO_ONE ||
    !isNonEmptyString(settings.joinColumnName)
  ) {
    return undefined;
  }

  return settings.joinColumnName;
};
