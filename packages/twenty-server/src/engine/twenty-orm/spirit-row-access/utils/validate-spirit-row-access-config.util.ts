import { isNonEmptyString } from '@sniptt/guards';
import { isDefined, isPlainObject } from 'twenty-shared/utils';

import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type FlatRoleMaps } from 'src/engine/metadata-modules/flat-role/types/flat-role-maps.type';
import {
  type SpiritRowAccessConfig,
  type SpiritRowAccessRule,
} from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-config.type';
import { isSpiritRuleObjectAllowed } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-rule-object-allowed.util';
import { resolveSpiritOwnerJoinColumnName } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-join-column-name.util';

export type SpiritRowAccessConfigValidation =
  | {
      isValid: true;
      config: SpiritRowAccessConfig;
      droppedSeeAllRoleIds: string[];
    }
  | { isValid: false; problems: string[] };

const CONFIG_KEYS = ['version', 'rules', 'seeAllRoleIds'];
const RULE_KEYS = ['objectMetadataId', 'ownerFieldMetadataId', 'isEnabled'];

const findUnknownKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).filter((key) => !allowed.includes(key));

// Strict: an unknown key, a wrong type, a duplicate, or a rule id that does
// not resolve makes the whole config invalid, and an invalid config fails
// closed. Only enabled rules are checked against the metadata: a disabled
// rule filters nothing, so a field deleted under it cannot open or close rows.
// An enabled rule must sit on an audited object (company, opportunity, task,
// an object of the workspace's custom application, or of one of our own apps). A see-all role id that
// does not exist is dropped, not refused: nobody holds a deleted role, so
// dropping it opens nothing. The dropped ids are returned so the caller can
// log them: a role later created with the same id would be see-all at once.
export const validateSpiritRowAccessConfig = ({
  rawConfig,
  flatObjectMetadataMaps,
  flatFieldMetadataMaps,
  flatRoleMaps,
  workspaceMemberObjectMetadataId,
  workspaceCustomApplicationId,
  ownApplicationIds,
}: {
  rawConfig: unknown;
  flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
  flatRoleMaps: FlatRoleMaps;
  workspaceMemberObjectMetadataId: string | undefined;
  workspaceCustomApplicationId: string | undefined;
  ownApplicationIds: string[];
}): SpiritRowAccessConfigValidation => {
  const problems: string[] = [];

  if (!isPlainObject(rawConfig)) {
    return { isValid: false, problems: ['config is not a JSON object'] };
  }

  const config = rawConfig as Record<string, unknown>;

  for (const unknownKey of findUnknownKeys(config, CONFIG_KEYS)) {
    problems.push(`unknown key "${unknownKey}"`);
  }

  if (config.version !== 1) {
    problems.push('version must be 1');
  }

  const rules: SpiritRowAccessRule[] = [];

  if (!Array.isArray(config.rules)) {
    problems.push('rules must be an array');
  } else {
    const seenObjectIds = new Set<string>();

    config.rules.forEach((candidate: unknown, index) => {
      if (!isPlainObject(candidate)) {
        problems.push(`rules[${index}] is not an object`);

        return;
      }

      const rule = candidate as Record<string, unknown>;

      for (const unknownKey of findUnknownKeys(rule, RULE_KEYS)) {
        problems.push(`rules[${index}] has unknown key "${unknownKey}"`);
      }

      if (
        !isNonEmptyString(rule.objectMetadataId) ||
        !isNonEmptyString(rule.ownerFieldMetadataId) ||
        typeof rule.isEnabled !== 'boolean'
      ) {
        problems.push(
          `rules[${index}] needs objectMetadataId, ownerFieldMetadataId (strings) and isEnabled (boolean)`,
        );

        return;
      }

      if (seenObjectIds.has(rule.objectMetadataId)) {
        problems.push(
          `rules[${index}] repeats object ${rule.objectMetadataId}`,
        );
      }

      seenObjectIds.add(rule.objectMetadataId);

      const typedRule: SpiritRowAccessRule = {
        objectMetadataId: rule.objectMetadataId,
        ownerFieldMetadataId: rule.ownerFieldMetadataId,
        isEnabled: rule.isEnabled,
      };

      if (typedRule.isEnabled) {
        const flatObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
          flatEntityId: typedRule.objectMetadataId,
          flatEntityMaps: flatObjectMetadataMaps,
        });

        if (
          !isDefined(flatObjectMetadata) ||
          flatObjectMetadata.isActive === false
        ) {
          problems.push(
            `rules[${index}] object ${typedRule.objectMetadataId} does not exist`,
          );
        } else if (
          !isSpiritRuleObjectAllowed({
            flatObjectMetadata,
            workspaceCustomApplicationId,
            ownApplicationIds,
          })
        ) {
          problems.push(
            `rules[${index}] object ${flatObjectMetadata.nameSingular} cannot hold a rule: only company, opportunity, task, the workspace's own custom objects and objects of our own apps can`,
          );
        } else {
          const joinColumnName = resolveSpiritOwnerJoinColumnName({
            rule: typedRule,
            ownerFieldMetadata: findFlatEntityByIdInFlatEntityMaps({
              flatEntityId: typedRule.ownerFieldMetadataId,
              flatEntityMaps: flatFieldMetadataMaps,
            }),
            workspaceMemberObjectMetadataId,
          });

          if (!isDefined(joinColumnName)) {
            problems.push(
              `rules[${index}] owner field ${typedRule.ownerFieldMetadataId} is not an active MANY_TO_ONE relation from ${flatObjectMetadata.nameSingular} to workspaceMember`,
            );
          }
        }
      }

      rules.push(typedRule);
    });
  }

  const seeAllRoleIds: string[] = [];
  const droppedSeeAllRoleIds: string[] = [];
  const seenRoleIds = new Set<string>();

  if (!Array.isArray(config.seeAllRoleIds)) {
    problems.push('seeAllRoleIds must be an array');
  } else {
    config.seeAllRoleIds.forEach((roleId: unknown, index) => {
      if (!isNonEmptyString(roleId)) {
        problems.push(`seeAllRoleIds[${index}] is not a string`);

        return;
      }

      if (seenRoleIds.has(roleId)) {
        problems.push(`seeAllRoleIds[${index}] repeats role ${roleId}`);
      }

      seenRoleIds.add(roleId);

      if (
        isDefined(
          findFlatEntityByIdInFlatEntityMaps({
            flatEntityId: roleId,
            flatEntityMaps: flatRoleMaps,
          }),
        )
      ) {
        seeAllRoleIds.push(roleId);
      } else {
        droppedSeeAllRoleIds.push(roleId);
      }
    });
  }

  if (problems.length > 0) {
    return { isValid: false, problems };
  }

  return {
    isValid: true,
    config: { version: 1, rules, seeAllRoleIds },
    droppedSeeAllRoleIds,
  };
};
