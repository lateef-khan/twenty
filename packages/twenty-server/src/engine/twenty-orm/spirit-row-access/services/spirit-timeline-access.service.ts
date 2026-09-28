import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';
import { In, type FindOptionsWhere } from 'typeorm';

import { getFlatFieldsFromFlatObjectMetadata } from 'src/engine/api/graphql/workspace-schema-builder/utils/get-flat-fields-for-flat-object-metadata.util';
import { RelatedPersonIdsService } from 'src/engine/core-modules/related-person-ids/services/related-person-ids.service';
import {
  findRelationPathsToPerson,
  type RelationPathToPerson,
} from 'src/engine/core-modules/related-person-ids/utils/find-relation-paths-to-person.util';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { isMorphOrRelationFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { buildObjectIdByNameMaps } from 'src/engine/metadata-modules/flat-object-metadata/utils/build-object-id-by-name-maps.util';
import { PermissionsException } from 'src/engine/metadata-modules/permissions/permissions.exception';
import { TwentyOrmException } from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';
import { isSpiritRowAccessEnforced } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { resolveSpiritCallerScope } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-caller-scope.util';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';

const PERSON_OBJECT_NAME_SINGULAR = 'person';

type RelationWalkRecord = { id: string } & Record<string, unknown>;

// The timeline guard (design §5.10). The root must be visible to the caller,
// and a caller who is not see-all walks every hop with their own role,
// including the object each foreign key points at: a person reached through
// a hidden company is not related for them.
@Injectable()
export class SpiritTimelineAccessService {
  constructor(
    private readonly relatedPersonIdsService: RelatedPersonIdsService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly workspaceCacheService: WorkspaceCacheService,
  ) {}

  async getRelatedPersonIdsForCaller({
    workspaceId,
    objectNameSingular,
    recordId,
  }: {
    workspaceId: string;
    objectNameSingular: string;
    recordId: string;
  }): Promise<{ isRootVisible: boolean; personIds: string[] }> {
    if (!isSpiritRowAccessEnforced()) {
      return {
        isRootVisible: true,
        personIds: await this.relatedPersonIdsService.getRelatedPersonIds({
          workspaceId,
          objectNameSingular,
          recordId,
        }),
      };
    }

    const scope = await this.workspaceOrmManager.executeInWorkspaceContext(() =>
      resolveSpiritCallerScope(getWorkspaceContext()),
    );

    if (scope.kind === 'none') {
      return { isRootVisible: false, personIds: [] };
    }

    if (scope.kind === 'bypass') {
      return {
        isRootVisible: true,
        personIds: await this.relatedPersonIdsService.getRelatedPersonIds({
          workspaceId,
          objectNameSingular,
          recordId,
        }),
      };
    }

    const { rolePermissionConfig } = scope;

    const { flatObjectMetadataMaps, flatFieldMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
      ]);

    return this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      const visibleRootIds = await this.findVisibleIdsAsCaller({
        objectNameSingular,
        ids: [recordId],
        rolePermissionConfig,
      });

      if (!visibleRootIds.includes(recordId)) {
        return { isRootVisible: false, personIds: [] };
      }

      if (objectNameSingular === PERSON_OBJECT_NAME_SINGULAR) {
        return { isRootVisible: true, personIds: [recordId] };
      }

      const relationPaths = findRelationPathsToPerson({
        rootObjectNameSingular: objectNameSingular,
        flatObjectMetadataMaps,
        flatFieldMetadataMaps,
      });

      const personIds = new Set<string>();

      for (const relationPath of relationPaths) {
        const personIdsForPath = await this.walkRelationPathAsCaller({
          recordId,
          relationPath,
          rolePermissionConfig,
          flatObjectMetadataMaps,
          flatFieldMetadataMaps,
        });

        personIdsForPath.forEach((personId) => personIds.add(personId));
      }

      return { isRootVisible: true, personIds: [...personIds] };
    });
  }

  private async findVisibleIdsAsCaller({
    objectNameSingular,
    ids,
    rolePermissionConfig,
  }: {
    objectNameSingular: string;
    ids: string[];
    rolePermissionConfig: RolePermissionConfig;
  }): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }

    try {
      const records = await this.workspaceOrmManager
        .getRepository<RelationWalkRecord>(
          objectNameSingular,
          rolePermissionConfig,
        )
        .find({
          where: { id: In(ids) } as FindOptionsWhere<RelationWalkRecord>,
          select: { id: true },
          withDeleted: true,
        });

      return records.map((record) => record.id);
    } catch (error) {
      if (
        error instanceof PermissionsException ||
        error instanceof TwentyOrmException
      ) {
        return [];
      }

      throw error;
    }
  }

  private resolveManyToOneTargetObjectNameSingular({
    queryObjectNameSingular,
    joinColumnName,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
  }: {
    queryObjectNameSingular: string;
    joinColumnName: string;
    flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
    flatFieldMetadataMaps: FlatEntityMaps<FlatFieldMetadata>;
  }): string | undefined {
    const { idByNameSingular } = buildObjectIdByNameMaps(
      flatObjectMetadataMaps,
    );
    const queryObjectMetadataId = idByNameSingular[queryObjectNameSingular];
    const queryObjectMetadata = isDefined(queryObjectMetadataId)
      ? findFlatEntityByIdInFlatEntityMaps({
          flatEntityId: queryObjectMetadataId,
          flatEntityMaps: flatObjectMetadataMaps,
        })
      : undefined;

    if (!isDefined(queryObjectMetadata)) {
      return undefined;
    }

    const joinField = getFlatFieldsFromFlatObjectMetadata(
      queryObjectMetadata,
      flatFieldMetadataMaps,
    ).find(
      (field) =>
        isMorphOrRelationFlatFieldMetadata(field) &&
        field.settings?.relationType === RelationType.MANY_TO_ONE &&
        field.settings?.joinColumnName === joinColumnName,
    );

    if (!isDefined(joinField?.relationTargetObjectMetadataId)) {
      return undefined;
    }

    return findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: joinField.relationTargetObjectMetadataId,
      flatEntityMaps: flatObjectMetadataMaps,
    })?.nameSingular;
  }

  private async walkRelationPathAsCaller({
    recordId,
    relationPath,
    rolePermissionConfig,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
  }: {
    recordId: string;
    relationPath: RelationPathToPerson;
    rolePermissionConfig: RolePermissionConfig;
    flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
    flatFieldMetadataMaps: FlatEntityMaps<FlatFieldMetadata>;
  }): Promise<string[]> {
    let currentIds = [recordId];

    for (const hop of relationPath) {
      if (currentIds.length === 0) {
        return [];
      }

      try {
        const repository =
          this.workspaceOrmManager.getRepository<RelationWalkRecord>(
            hop.queryObjectNameSingular,
            rolePermissionConfig,
          );

        if (hop.direction === RelationType.MANY_TO_ONE) {
          const records = await repository.find({
            where: {
              id: In(currentIds),
            } as FindOptionsWhere<RelationWalkRecord>,
            select: [hop.joinColumnName],
          });

          const targetIds = [
            ...new Set(
              records
                .map((record) => record[hop.joinColumnName])
                .filter(
                  (value): value is string =>
                    typeof value === 'string' && isDefined(value),
                ),
            ),
          ];

          // A foreign key is readable even when its target is hidden, so the
          // target ids must pass the caller's rule on the target object.
          const targetObjectNameSingular =
            this.resolveManyToOneTargetObjectNameSingular({
              queryObjectNameSingular: hop.queryObjectNameSingular,
              joinColumnName: hop.joinColumnName,
              flatObjectMetadataMaps,
              flatFieldMetadataMaps,
            });

          currentIds = isDefined(targetObjectNameSingular)
            ? await this.findVisibleIdsAsCaller({
                objectNameSingular: targetObjectNameSingular,
                ids: targetIds,
                rolePermissionConfig,
              })
            : [];
        } else {
          const records = await repository.find({
            where: {
              [hop.joinColumnName]: In(currentIds),
            } as FindOptionsWhere<RelationWalkRecord>,
            select: { id: true },
          });

          currentIds = [...new Set(records.map((record) => record.id))];
        }
      } catch (error) {
        if (
          error instanceof PermissionsException ||
          error instanceof TwentyOrmException
        ) {
          return [];
        }

        throw error;
      }
    }

    return currentIds;
  }
}
