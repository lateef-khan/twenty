import { Logger } from '@nestjs/common';

import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { type SecretEncryptionService } from 'src/engine/core-modules/secret-encryption/secret-encryption.service';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import {
  SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER,
  SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
} from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-row-access-application.constant';
import { SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';

const WORKSPACE_ID = 'workspace-1';
const APPLICATION_ID = 'application-row-access';
const VARIABLE_UNIVERSAL_IDENTIFIER = 'variable-row-access-config';
const COMPANY_ID = 'object-company';
const WORKSPACE_MEMBER_ID = 'object-workspace-member';
const ACCOUNT_OWNER_ID = 'field-account-owner';
const ADMIN_ROLE_ID = 'role-admin';
const MANAGER_ROLE_ID = 'role-manager';
const WORKSPACE_CUSTOM_APPLICATION_ID = 'application-workspace-custom';

const COMPANY_RULE_CONFIG = {
  version: 1,
  rules: [
    {
      objectMetadataId: COMPANY_ID,
      ownerFieldMetadataId: ACCOUNT_OWNER_ID,
      isEnabled: true,
    },
  ],
  seeAllRoleIds: [MANAGER_ROLE_ID],
};

const buildMaps = (
  entities: { id: string; universalIdentifier: string }[],
) => ({
  byUniversalIdentifier: Object.fromEntries(
    entities.map((entity) => [entity.universalIdentifier, entity]),
  ),
  universalIdentifierById: Object.fromEntries(
    entities.map((entity) => [entity.id, entity.universalIdentifier]),
  ),
  universalIdentifiersByApplicationId: {},
});

const buildObjectMaps = () =>
  buildMaps([
    {
      id: COMPANY_ID,
      universalIdentifier: STANDARD_OBJECTS.company.universalIdentifier,
      nameSingular: 'company',
      isSystem: false,
      isActive: true,
      fieldIds: [ACCOUNT_OWNER_ID],
    },
    {
      id: WORKSPACE_MEMBER_ID,
      universalIdentifier: STANDARD_OBJECTS.workspaceMember.universalIdentifier,
      nameSingular: 'workspaceMember',
      isSystem: true,
      isActive: true,
      fieldIds: [],
    },
  ] as never);

const buildFieldMaps = () =>
  buildMaps([
    {
      id: ACCOUNT_OWNER_ID,
      universalIdentifier: 'field-account-owner-uid',
      name: 'accountOwner',
      type: FieldMetadataType.RELATION,
      objectMetadataId: COMPANY_ID,
      relationTargetObjectMetadataId: WORKSPACE_MEMBER_ID,
      isActive: true,
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        joinColumnName: 'accountOwnerId',
      },
    },
  ] as never);

const buildRoleMaps = () =>
  buildMaps([
    {
      id: ADMIN_ROLE_ID,
      universalIdentifier: STANDARD_ROLE.admin.universalIdentifier,
    },
    { id: MANAGER_ROLE_ID, universalIdentifier: 'role-manager-uid' },
  ]);

const buildApplicationMaps = () => ({
  byId: { [APPLICATION_ID]: { id: APPLICATION_ID } },
  idByUniversalIdentifier: {
    [SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER]: APPLICATION_ID,
  },
});

const buildVariableMaps = (encryptedValue: string) => ({
  byUniversalIdentifier: {
    [VARIABLE_UNIVERSAL_IDENTIFIER]: {
      key: SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
      value: encryptedValue,
    },
  },
  universalIdentifierById: {},
  universalIdentifiersByApplicationId: {
    [APPLICATION_ID]: [VARIABLE_UNIVERSAL_IDENTIFIER],
  },
});

// Design §5.7: decrypt + parse once per stored ciphertext; validate once per
// (value, object maps, field maps, role maps) and return the SAME state
// object until one of them changes.
describe('SpiritRowAccessStateService memo', () => {
  const originalEnforced = process.env.SPIRIT_ROW_ACCESS_ENFORCED;

  let cacheMaps: Record<string, unknown>;
  let plaintextByCiphertext: Record<string, string>;
  let getOrRecompute: jest.Mock;
  let decryptVersionedOrThrow: jest.Mock;
  let findWorkspace: jest.Mock;
  let service: SpiritRowAccessStateService;

  beforeEach(() => {
    process.env.SPIRIT_ROW_ACCESS_ENFORCED = 'true';

    plaintextByCiphertext = {
      'cipher-1': JSON.stringify(COMPANY_RULE_CONFIG),
      // A re-save of the same JSON is encrypted with a new IV
      'cipher-2': JSON.stringify(COMPANY_RULE_CONFIG),
    };
    cacheMaps = {
      flatRoleMaps: buildRoleMaps(),
      flatObjectMetadataMaps: buildObjectMaps(),
      flatFieldMetadataMapsOrm: buildFieldMaps(),
      flatApplicationMaps: buildApplicationMaps(),
      applicationVariableMaps: buildVariableMaps('cipher-1'),
    };
    getOrRecompute = jest.fn(async () => ({ ...cacheMaps }));
    decryptVersionedOrThrow = jest.fn(
      (ciphertext: string) => plaintextByCiphertext[ciphertext],
    );
    findWorkspace = jest.fn(async () => ({
      id: WORKSPACE_ID,
      workspaceCustomApplicationId: WORKSPACE_CUSTOM_APPLICATION_ID,
    }));
    service = new SpiritRowAccessStateService(
      { getOrRecompute } as unknown as WorkspaceCacheService,
      { decryptVersionedOrThrow } as unknown as SecretEncryptionService,
      { findOne: findWorkspace },
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalEnforced === undefined) {
      delete process.env.SPIRIT_ROW_ACCESS_ENFORCED;
    } else {
      process.env.SPIRIT_ROW_ACCESS_ENFORCED = originalEnforced;
    }
  });

  it('reads nothing while enforcement is off', async () => {
    process.env.SPIRIT_ROW_ACCESS_ENFORCED = 'false';

    expect(await service.loadState(WORKSPACE_ID)).toBeUndefined();
    expect(getOrRecompute).not.toHaveBeenCalled();
  });

  it('builds an ok state from the saved config, with the Admin role id', async () => {
    expect(await service.loadState(WORKSPACE_ID)).toEqual({
      config: COMPANY_RULE_CONFIG,
      configStatus: 'ok',
      configProblems: [],
      adminRoleId: ADMIN_ROLE_ID,
    });
  });

  it('returns the same state object while no input changed, and decrypts once', async () => {
    const first = await service.loadState(WORKSPACE_ID);

    // The cache hands out new wrapper objects each call; only the entries count
    cacheMaps = {
      ...cacheMaps,
      applicationVariableMaps: buildVariableMaps('cipher-1'),
    };

    const second = await service.loadState(WORKSPACE_ID);

    expect(second).toBe(first);
    expect(decryptVersionedOrThrow).toHaveBeenCalledTimes(1);
  });

  it('returns a new state object after the variable is saved again', async () => {
    const first = await service.loadState(WORKSPACE_ID);

    cacheMaps = {
      ...cacheMaps,
      applicationVariableMaps: buildVariableMaps('cipher-2'),
    };

    const second = await service.loadState(WORKSPACE_ID);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(decryptVersionedOrThrow).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['object', 'flatObjectMetadataMaps', buildObjectMaps],
    ['field', 'flatFieldMetadataMapsOrm', buildFieldMaps],
    ['role', 'flatRoleMaps', buildRoleMaps],
  ])(
    'returns a new state object after the %s maps change, without decrypting again',
    async (_label, cacheKey, rebuild) => {
      const first = await service.loadState(WORKSPACE_ID);

      cacheMaps = { ...cacheMaps, [cacheKey]: rebuild() };

      const second = await service.loadState(WORKSPACE_ID);

      expect(second).not.toBe(first);
      expect(second).toEqual(first);
      expect(decryptVersionedOrThrow).toHaveBeenCalledTimes(1);

      expect(await service.loadState(WORKSPACE_ID)).toBe(second);
    },
  );

  it('fails closed with application-missing when the app is not installed, and keeps that state object', async () => {
    cacheMaps = {
      ...cacheMaps,
      flatApplicationMaps: { byId: {}, idByUniversalIdentifier: {} },
    };

    const first = await service.loadState(WORKSPACE_ID);

    expect(first).toEqual({
      config: null,
      configStatus: 'application-missing',
      configProblems: ['application-missing'],
      adminRoleId: ADMIN_ROLE_ID,
    });
    expect(await service.loadState(WORKSPACE_ID)).toBe(first);
    expect(decryptVersionedOrThrow).not.toHaveBeenCalled();
  });

  it('fails closed with unreadable on a value that is not JSON', async () => {
    plaintextByCiphertext['cipher-3'] = '{not json';
    cacheMaps = {
      ...cacheMaps,
      applicationVariableMaps: buildVariableMaps('cipher-3'),
    };

    expect(await service.loadState(WORKSPACE_ID)).toMatchObject({
      config: null,
      configStatus: 'unreadable',
    });
  });

  it('reads the workspace custom application once per workspace', async () => {
    await service.loadState(WORKSPACE_ID);
    await service.loadState(WORKSPACE_ID);

    expect(findWorkspace).toHaveBeenCalledTimes(1);
  });

  // Review m7: a see-all id with no role is ignored (D25) but not silently
  it('logs each dropped see-all role id once per config change', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    plaintextByCiphertext['cipher-4'] = JSON.stringify({
      ...COMPANY_RULE_CONFIG,
      seeAllRoleIds: ['role-deleted', MANAGER_ROLE_ID],
    });
    cacheMaps = {
      ...cacheMaps,
      applicationVariableMaps: buildVariableMaps('cipher-4'),
    };

    const state = await service.loadState(WORKSPACE_ID);

    await service.loadState(WORKSPACE_ID);

    expect(state?.configStatus).toBe('ok');
    expect(state?.config?.seeAllRoleIds).toEqual([MANAGER_ROLE_ID]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('role-deleted');
    expect(warn.mock.calls[0][0]).not.toContain(MANAGER_ROLE_ID);
  });

  it('keeps one memo per workspace', async () => {
    const first = await service.loadState(WORKSPACE_ID);
    const other = await service.loadState('workspace-2');

    expect(other).not.toBe(first);
    expect(await service.loadState(WORKSPACE_ID)).toBe(first);
  });
});
