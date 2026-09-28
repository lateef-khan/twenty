import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { getFlatFieldsFromFlatObjectMetadata } from 'src/engine/api/graphql/workspace-schema-builder/utils/get-flat-fields-for-flat-object-metadata.util';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { isFlatFieldMetadataOfType } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-flat-field-metadata-of-type.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type SpiritRowAccessRule } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-config.type';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';

export type SpiritOwnerRuleTarget = {
  rule: SpiritRowAccessRule | undefined;
  ownerFieldMetadata: OrmFlatFieldMetadata | undefined;
  workspaceMemberObjectMetadataId: string | undefined;
};

const FAIL_CLOSED_RULE_OWNER_FIELD_ID = 'spirit-row-access-config-unavailable';

const hasManyToOneRelationToWorkspaceMember = ({
  flatObjectMetadata,
  flatFieldMetadataMaps,
  workspaceMemberObjectMetadataId,
}: {
  flatObjectMetadata: FlatObjectMetadata;
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
  workspaceMemberObjectMetadataId: string | undefined;
}): boolean =>
  getFlatFieldsFromFlatObjectMetadata(
    flatObjectMetadata,
    flatFieldMetadataMaps,
  ).some(
    (field) =>
      isFlatFieldMetadataOfType(field, FieldMetadataType.RELATION) &&
      field.settings?.relationType === RelationType.MANY_TO_ONE &&
      field.relationTargetObjectMetadataId === workspaceMemberObjectMetadataId,
  );

// With no usable config every object that has an owner-shaped relation is
// treated as ruled with an unusable owner field, so non-see-all callers get
// always-false on it (fail closed).
export const resolveSpiritOwnerRuleTarget = ({
  state,
  flatObjectMetadata,
  flatFieldMetadataMaps,
  objectIdByNameSingular,
}: {
  state: SpiritRowAccessState | undefined;
  flatObjectMetadata: FlatObjectMetadata;
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
  objectIdByNameSingular: Record<string, string>;
}): SpiritOwnerRuleTarget => {
  const workspaceMemberObjectMetadataId =
    objectIdByNameSingular.workspaceMember;

  if (!isDefined(state?.config)) {
    const isOwnerShaped = hasManyToOneRelationToWorkspaceMember({
      flatObjectMetadata,
      flatFieldMetadataMaps,
      workspaceMemberObjectMetadataId,
    });

    return {
      rule: isOwnerShaped
        ? {
            objectMetadataId: flatObjectMetadata.id,
            ownerFieldMetadataId: FAIL_CLOSED_RULE_OWNER_FIELD_ID,
            isEnabled: true,
          }
        : undefined,
      ownerFieldMetadata: undefined,
      workspaceMemberObjectMetadataId,
    };
  }

  const rule = state.config.rules.find(
    (candidate) =>
      candidate.isEnabled &&
      candidate.objectMetadataId === flatObjectMetadata.id,
  );

  return {
    rule,
    ownerFieldMetadata: isDefined(rule)
      ? findFlatEntityByIdInFlatEntityMaps({
          flatEntityId: rule.ownerFieldMetadataId,
          flatEntityMaps: flatFieldMetadataMaps,
        })
      : undefined,
    workspaceMemberObjectMetadataId,
  };
};
