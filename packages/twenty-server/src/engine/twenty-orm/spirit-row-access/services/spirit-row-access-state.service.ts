import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { type ApplicationVariableCacheMaps } from 'src/engine/core-modules/application/application-variable/types/application-variable-cache-maps.type';
import { type FlatApplicationCacheMaps } from 'src/engine/core-modules/application/types/flat-application-cache-maps.type';
import { SecretEncryptionService } from 'src/engine/core-modules/secret-encryption/secret-encryption.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { buildObjectIdByNameMaps } from 'src/engine/metadata-modules/flat-object-metadata/utils/build-object-id-by-name-maps.util';
import { type FlatRoleMaps } from 'src/engine/metadata-modules/flat-role/types/flat-role-maps.type';
import {
  SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER,
  SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
  SPIRIT_ROW_ACCESS_OWN_APPLICATION_UNIVERSAL_IDENTIFIERS,
} from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-row-access-application.constant';
import {
  type SpiritRowAccessConfigStatus,
  type SpiritRowAccessState,
} from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { type SpiritRowAccessWorkspaceSnapshot } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-workspace-snapshot.type';
import { isSpiritRowAccessEnforced } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { validateSpiritRowAccessConfig } from 'src/engine/twenty-orm/spirit-row-access/utils/validate-spirit-row-access-config.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';

type DecodedVariable =
  | { kind: 'missing'; status: SpiritRowAccessConfigStatus }
  | { kind: 'unreadable'; problem: string }
  | { kind: 'parsed'; value: unknown };

type StateInputs = {
  decodedVariable: DecodedVariable;
  flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
  flatRoleMaps: FlatRoleMaps;
  workspaceCustomApplicationId: string | undefined;
  ownApplicationIds: string[];
};

@Injectable()
export class SpiritRowAccessStateService {
  private readonly logger = new Logger(SpiritRowAccessStateService.name);

  private readonly decodedByWorkspaceId = new Map<
    string,
    { encryptedValue: string; decodedVariable: DecodedVariable }
  >();

  private readonly snapshotByWorkspaceId = new Map<
    string,
    { inputs: StateInputs; snapshot: SpiritRowAccessWorkspaceSnapshot }
  >();

  // A workspace's custom application never changes, so it is read once.
  private readonly workspaceCustomApplicationIdByWorkspaceId = new Map<
    string,
    string
  >();

  constructor(
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly secretEncryptionService: SecretEncryptionService,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Pick<
      Repository<WorkspaceEntity>,
      'findOne'
    >,
  ) {}

  async loadState(
    workspaceId: string,
  ): Promise<SpiritRowAccessState | undefined> {
    return (await this.loadSnapshot(workspaceId))?.state;
  }

  // Undefined while enforcement is off.
  async loadSnapshot(
    workspaceId: string,
  ): Promise<SpiritRowAccessWorkspaceSnapshot | undefined> {
    if (!isSpiritRowAccessEnforced()) {
      return undefined;
    }

    const [
      {
        flatRoleMaps,
        flatObjectMetadataMaps,
        flatFieldMetadataMapsOrm,
        flatApplicationMaps,
        applicationVariableMaps,
      },
      workspaceCustomApplicationId,
    ] = await Promise.all([
      this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatRoleMaps',
        'flatObjectMetadataMaps',
        'flatFieldMetadataMapsOrm',
        'flatApplicationMaps',
        'applicationVariableMaps',
      ]),
      this.findWorkspaceCustomApplicationId(workspaceId),
    ]);

    const inputs: StateInputs = {
      decodedVariable: this.decodeVariable({
        workspaceId,
        flatApplicationMaps,
        applicationVariableMaps,
      }),
      flatObjectMetadataMaps,
      flatFieldMetadataMaps: flatFieldMetadataMapsOrm,
      flatRoleMaps,
      workspaceCustomApplicationId,
      ownApplicationIds:
        SPIRIT_ROW_ACCESS_OWN_APPLICATION_UNIVERSAL_IDENTIFIERS.map(
          (universalIdentifier) =>
            flatApplicationMaps.idByUniversalIdentifier[universalIdentifier],
        ).filter(isDefined),
    };

    const memoized = this.snapshotByWorkspaceId.get(workspaceId);

    if (
      isDefined(memoized) &&
      memoized.inputs.decodedVariable === inputs.decodedVariable &&
      memoized.inputs.flatObjectMetadataMaps ===
        inputs.flatObjectMetadataMaps &&
      memoized.inputs.flatFieldMetadataMaps === inputs.flatFieldMetadataMaps &&
      memoized.inputs.flatRoleMaps === inputs.flatRoleMaps &&
      memoized.inputs.workspaceCustomApplicationId ===
        inputs.workspaceCustomApplicationId &&
      memoized.inputs.ownApplicationIds.join() ===
        inputs.ownApplicationIds.join()
    ) {
      return memoized.snapshot;
    }

    const { snapshot, droppedSeeAllRoleIds } = this.buildSnapshot(inputs);

    this.snapshotByWorkspaceId.set(workspaceId, { inputs, snapshot });

    if (droppedSeeAllRoleIds.length > 0) {
      this.logger.warn(
        `Row access config for workspace ${workspaceId} names see-all role(s) that do not exist; ignoring them: ${droppedSeeAllRoleIds.join(', ')}. A role later created with one of these ids would see all rows; save the settings page again to drop them.`,
      );
    }

    if (snapshot.state.configStatus !== 'ok') {
      this.logger.warn(
        `Row access config for workspace ${workspaceId} is ${snapshot.state.configStatus}; failing closed: ${snapshot.state.configProblems.join('; ')}`,
      );
    }

    return snapshot;
  }

  private async findWorkspaceCustomApplicationId(
    workspaceId: string,
  ): Promise<string | undefined> {
    const memoized =
      this.workspaceCustomApplicationIdByWorkspaceId.get(workspaceId);

    if (isDefined(memoized)) {
      return memoized;
    }

    const workspace = await this.workspaceRepository.findOne({
      select: ['id', 'workspaceCustomApplicationId'],
      where: { id: workspaceId },
      withDeleted: true,
    });
    const workspaceCustomApplicationId =
      workspace?.workspaceCustomApplicationId;

    if (!isNonEmptyString(workspaceCustomApplicationId)) {
      return undefined;
    }

    this.workspaceCustomApplicationIdByWorkspaceId.set(
      workspaceId,
      workspaceCustomApplicationId,
    );

    return workspaceCustomApplicationId;
  }

  private decodeVariable({
    workspaceId,
    flatApplicationMaps,
    applicationVariableMaps,
  }: {
    workspaceId: string;
    flatApplicationMaps: FlatApplicationCacheMaps;
    applicationVariableMaps: ApplicationVariableCacheMaps;
  }): DecodedVariable {
    const applicationId =
      flatApplicationMaps.idByUniversalIdentifier[
        SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER
      ];
    const application = isDefined(applicationId)
      ? flatApplicationMaps.byId[applicationId]
      : undefined;

    if (!isDefined(applicationId) || !isDefined(application)) {
      return this.memoizeDecoded(workspaceId, '', {
        kind: 'missing',
        status: 'application-missing',
      });
    }

    const variable = (
      applicationVariableMaps.universalIdentifiersByApplicationId[
        applicationId
      ] ?? []
    )
      .map(
        (universalIdentifier) =>
          applicationVariableMaps.byUniversalIdentifier[universalIdentifier],
      )
      .find(
        (candidate) => candidate?.key === SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
      );

    if (!isDefined(variable)) {
      return this.memoizeDecoded(workspaceId, `${applicationId}:none`, {
        kind: 'missing',
        status: 'variable-missing',
      });
    }

    const encryptedValue = variable.value as string;
    const memoized = this.decodedByWorkspaceId.get(workspaceId);

    if (memoized?.encryptedValue === encryptedValue) {
      return memoized.decodedVariable;
    }

    return this.memoizeDecoded(
      workspaceId,
      encryptedValue,
      this.decryptAndParse(variable.value, workspaceId),
    );
  }

  private decryptAndParse(
    encryptedValue: Parameters<
      SecretEncryptionService['decryptVersionedOrThrow']
    >[0],
    workspaceId: string,
  ): DecodedVariable {
    let plaintext: string;

    try {
      plaintext = this.secretEncryptionService.decryptVersionedOrThrow(
        encryptedValue,
        { workspaceId },
      );
    } catch {
      return { kind: 'unreadable', problem: 'value cannot be decrypted' };
    }

    if (!isNonEmptyString(plaintext)) {
      return { kind: 'unreadable', problem: 'value is empty' };
    }

    try {
      return { kind: 'parsed', value: JSON.parse(plaintext) };
    } catch {
      return { kind: 'unreadable', problem: 'value is not JSON' };
    }
  }

  private memoizeDecoded(
    workspaceId: string,
    encryptedValue: string,
    decodedVariable: DecodedVariable,
  ): DecodedVariable {
    const memoized = this.decodedByWorkspaceId.get(workspaceId);

    if (memoized?.encryptedValue === encryptedValue) {
      return memoized.decodedVariable;
    }

    this.decodedByWorkspaceId.set(workspaceId, {
      encryptedValue,
      decodedVariable,
    });

    return decodedVariable;
  }

  private buildSnapshot(inputs: StateInputs): {
    snapshot: SpiritRowAccessWorkspaceSnapshot;
    droppedSeeAllRoleIds: string[];
  } {
    const { idByNameSingular: objectIdByNameSingular } =
      buildObjectIdByNameMaps(inputs.flatObjectMetadataMaps);

    const adminRoleId =
      inputs.flatRoleMaps.byUniversalIdentifier[
        STANDARD_ROLE.admin.universalIdentifier
      ]?.id ?? null;

    const failClosed = (
      configStatus: SpiritRowAccessConfigStatus,
      configProblems: string[],
    ): SpiritRowAccessState => ({
      config: null,
      configStatus,
      configProblems,
      adminRoleId,
    });

    const { decodedVariable } = inputs;

    let state: SpiritRowAccessState;
    let droppedSeeAllRoleIds: string[] = [];

    if (decodedVariable.kind === 'missing') {
      state = failClosed(decodedVariable.status, [decodedVariable.status]);
    } else if (decodedVariable.kind === 'unreadable') {
      state = failClosed('unreadable', [decodedVariable.problem]);
    } else {
      const validation = validateSpiritRowAccessConfig({
        rawConfig: decodedVariable.value,
        flatObjectMetadataMaps: inputs.flatObjectMetadataMaps,
        flatFieldMetadataMaps: inputs.flatFieldMetadataMaps,
        flatRoleMaps: inputs.flatRoleMaps,
        workspaceMemberObjectMetadataId: objectIdByNameSingular.workspaceMember,
        workspaceCustomApplicationId: inputs.workspaceCustomApplicationId,
        ownApplicationIds: inputs.ownApplicationIds,
      });

      if (validation.isValid) {
        droppedSeeAllRoleIds = validation.droppedSeeAllRoleIds;
      }

      state = validation.isValid
        ? {
            config: validation.config,
            configStatus: 'ok',
            configProblems: [],
            adminRoleId,
          }
        : failClosed('invalid', validation.problems);
    }

    return {
      snapshot: {
        state,
        flatObjectMetadataMaps: inputs.flatObjectMetadataMaps,
        flatFieldMetadataMaps: inputs.flatFieldMetadataMaps,
        objectIdByNameSingular,
      },
      droppedSeeAllRoleIds,
    };
  }
}
