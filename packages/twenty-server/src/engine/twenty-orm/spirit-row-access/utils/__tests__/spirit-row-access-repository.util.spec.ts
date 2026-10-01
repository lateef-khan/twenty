import { FieldMetadataType } from 'twenty-shared/types';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import {
  applySpiritOwnerRuleToPolicy,
  isSpiritInsertHiddenFromCaller,
  prepareSpiritOwnerInsert,
  type SpiritRepositoryOptions,
} from 'src/engine/twenty-orm/spirit-row-access/utils/spirit-row-access-repository.util';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { type RowAccessPolicy } from 'src/engine/twenty-orm/types/row-access-policy.type';

const ALICE_MEMBER_ID = 'alice-member-id';
const BOB_MEMBER_ID = 'bob-member-id';
const MEMBER_ROLE_ID = 'role-member';
const ADMIN_ROLE_ID = 'role-admin';

const buildMaps = <TEntity extends FlatObjectMetadata | OrmFlatFieldMetadata>(
  entities: { id: string }[],
) =>
  ({
    byUniversalIdentifier: Object.fromEntries(
      entities.map((entity) => [`uid-${entity.id}`, entity]),
    ),
    universalIdentifierById: Object.fromEntries(
      entities.map((entity) => [entity.id, `uid-${entity.id}`]),
    ),
    universalIdentifiersByApplicationId: {},
  }) as unknown as FlatEntityMaps<TEntity>;

const manyToOne = (
  objectName: string,
  name: string,
  targetObjectName: string,
) => ({
  id: `field-${objectName}-${name}`,
  objectMetadataId: `object-${objectName}`,
  name,
  type: FieldMetadataType.RELATION,
  isActive: true,
  relationTargetObjectMetadataId: `object-${targetObjectName}`,
  settings: {
    relationType: RelationType.MANY_TO_ONE,
    joinColumnName: `${name}Id`,
  },
});

const FIELDS = [
  manyToOne('company', 'accountOwner', 'workspaceMember'),
  manyToOne('person', 'company', 'company'),
];

const OBJECTS = [
  { name: 'workspaceMember', isSystem: true },
  { name: 'company', isSystem: false },
  { name: 'person', isSystem: false },
].map(({ name, isSystem }) => ({
  id: `object-${name}`,
  universalIdentifier: `uid-object-${name}`,
  nameSingular: name,
  isSystem,
  isActive: true,
  fieldIds: FIELDS.filter(
    (field) => field.objectMetadataId === `object-${name}`,
  ).map((field) => field.id),
}));

const findObject = (name: string) =>
  OBJECTS.find(
    (object) => object.nameSingular === name,
  ) as unknown as FlatObjectMetadata;

const COMPANY_RULE_STATE: SpiritRowAccessState = {
  config: {
    version: 1,
    rules: [
      {
        objectMetadataId: 'object-company',
        ownerFieldMetadataId: 'field-company-accountOwner',
        isEnabled: true,
      },
    ],
    seeAllRoleIds: [],
  },
  configStatus: 'ok',
  configProblems: [],
  adminRoleId: ADMIN_ROLE_ID,
};

const FAIL_CLOSED_STATE: SpiritRowAccessState = {
  config: null,
  configStatus: 'application-missing',
  configProblems: ['application-missing'],
  adminRoleId: ADMIN_ROLE_ID,
};

const userAuthContext = (workspaceMemberId: string) =>
  ({
    type: 'user',
    workspace: { id: 'workspace-id' },
    workspaceMemberId,
  }) as unknown as WorkspaceAuthContext;

const apiKeyAuthContext = {
  type: 'apiKey',
  workspace: { id: 'workspace-id' },
} as unknown as WorkspaceAuthContext;

const buildOptions = ({
  objectName = 'company',
  roleId = MEMBER_ROLE_ID,
  authContext = userAuthContext(ALICE_MEMBER_ID),
  state = COMPANY_RULE_STATE,
}: {
  objectName?: string;
  roleId?: string;
  authContext?: WorkspaceAuthContext;
  state?: SpiritRowAccessState;
} = {}): SpiritRepositoryOptions => ({
  internalContext: {
    spiritRowAccess: state,
    flatObjectMetadataMaps: buildMaps<FlatObjectMetadata>(OBJECTS),
    flatFieldMetadataMaps: buildMaps<OrmFlatFieldMetadata>(FIELDS),
    objectIdByNameSingular: Object.fromEntries(
      OBJECTS.map((object) => [object.nameSingular, object.id]),
    ),
  } as unknown as WorkspaceInternalContext,
  authContext,
  rolePermissionConfig: { intersectionOf: [roleId] },
  shouldBypassPermissionChecks: false,
  flatObjectMetadata: findObject(objectName),
  tableShapeByObjectMetadataId: (objectMetadataId) =>
    ({
      schemaName: 'workspace_1',
      tableName: objectMetadataId,
    }) as unknown as WorkspaceTableShape,
});

const ALICE_OWNS_COMPANY = {
  sql: '"company"."accountOwnerId" = :spiritOwner_company',
  parameters: { spiritOwner_company: ALICE_MEMBER_ID },
};

const applyTo = (policy: RowAccessPolicy, options = buildOptions()) =>
  applySpiritOwnerRuleToPolicy({
    policy,
    repositoryOptions: options,
    flatObjectMetadata: findObject('company'),
    alias: 'company',
  });

describe('spirit row access in the repository', () => {
  beforeEach(() => {
    process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME] = 'true';
  });

  afterEach(() => {
    delete process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME];
  });

  describe('applySpiritOwnerRuleToPolicy (design §5.5)', () => {
    it('returns the same policy when there is no condition (switch off, or see-all)', () => {
      const policy: RowAccessPolicy = { kind: 'open' };

      expect(applyTo(policy, buildOptions({ roleId: ADMIN_ROLE_ID }))).toBe(
        policy,
      );

      delete process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME];

      expect(applyTo(policy)).toBe(policy);
    });

    it('turns open into gated on the owner column', () => {
      expect(applyTo({ kind: 'open' })).toEqual({
        kind: 'gated',
        condition: ALICE_OWNS_COMPANY,
      });
    });

    it('ANDs the owner rule onto an upstream gated policy', () => {
      expect(
        applyTo({
          kind: 'gated',
          condition: { sql: '"company"."x" = :x', parameters: { x: 1 } },
        }),
      ).toEqual({
        kind: 'gated',
        condition: {
          sql: `("company"."x" = :x) AND (${ALICE_OWNS_COMPANY.sql})`,
          parameters: { x: 1, ...ALICE_OWNS_COMPANY.parameters },
        },
      });
    });

    it('leaves denied unchanged', () => {
      expect(applyTo({ kind: 'denied' })).toEqual({ kind: 'denied' });
    });

    it('rules a joined alias by its own object, not the repository object', () => {
      expect(
        applySpiritOwnerRuleToPolicy({
          policy: { kind: 'open' },
          repositoryOptions: buildOptions({ objectName: 'person' }),
          flatObjectMetadata: findObject('company'),
          alias: 'person_company',
        }),
      ).toEqual({
        kind: 'gated',
        condition: {
          sql: '"person_company"."accountOwnerId" = :spiritOwner_person_company',
          parameters: { spiritOwner_person_company: ALICE_MEMBER_ID },
        },
      });
    });
  });

  describe('prepareSpiritOwnerInsert (design §5.6)', () => {
    const records = [
      { name: 'A', accountOwnerId: BOB_MEMBER_ID },
      { name: 'B' },
    ];

    it('leaves records and lock-checked columns unchanged for a see-all caller', () => {
      const prepared = prepareSpiritOwnerInsert(
        buildOptions({ roleId: ADMIN_ROLE_ID }),
        records,
      );

      expect(prepared.records).toBe(records);
      expect(prepared.lockCheckedColumns(['name', 'accountOwnerId'])).toEqual([
        'name',
        'accountOwnerId',
      ]);
    });

    it('gives a Member every row she creates, even when the input names bob', () => {
      expect(prepareSpiritOwnerInsert(buildOptions(), records).records).toEqual(
        [
          { name: 'A', accountOwnerId: ALICE_MEMBER_ID },
          { name: 'B', accountOwnerId: ALICE_MEMBER_ID },
        ],
      );
    });

    it('gives a caller with no member a null owner (D14)', () => {
      expect(
        prepareSpiritOwnerInsert(
          buildOptions({ authContext: apiKeyAuthContext }),
          records,
        ).records,
      ).toEqual([
        { name: 'A', accountOwnerId: null },
        { name: 'B', accountOwnerId: null },
      ]);
    });

    it('leaves out only the owner join column from the lock check', () => {
      expect(
        prepareSpiritOwnerInsert(buildOptions(), records).lockCheckedColumns([
          'name',
          'accountOwnerId',
          'employees',
        ]),
      ).toEqual(['name', 'employees']);
    });

    it('changes nothing when the owner column does not resolve (fail-closed config): the lock still applies', () => {
      const prepared = prepareSpiritOwnerInsert(
        buildOptions({ state: FAIL_CLOSED_STATE }),
        records,
      );

      expect(prepared.records).toBe(records);
      expect(prepared.lockCheckedColumns(['accountOwnerId'])).toEqual([
        'accountOwnerId',
      ]);
    });
  });

  // The create runner reads such rows back past the rule, for their creator only
  describe('isSpiritInsertHiddenFromCaller', () => {
    it('is true for a caller with no member and no see-all role on a rule object', () => {
      expect(
        isSpiritInsertHiddenFromCaller(
          buildOptions({ authContext: apiKeyAuthContext }),
        ),
      ).toBe(true);
    });

    it('is false for a Member, who owns and reads what she creates', () => {
      expect(isSpiritInsertHiddenFromCaller(buildOptions())).toBe(false);
    });

    it('is false for a see-all caller with no member', () => {
      expect(
        isSpiritInsertHiddenFromCaller(
          buildOptions({
            authContext: apiKeyAuthContext,
            roleId: ADMIN_ROLE_ID,
          }),
        ),
      ).toBe(false);
    });

    it('is false on an object with no rule', () => {
      expect(
        isSpiritInsertHiddenFromCaller(
          buildOptions({
            authContext: apiKeyAuthContext,
            objectName: 'person',
          }),
        ),
      ).toBe(false);
    });

    it('is false while enforcement is off', () => {
      delete process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME];

      expect(
        isSpiritInsertHiddenFromCaller(
          buildOptions({ authContext: apiKeyAuthContext }),
        ),
      ).toBe(false);
    });
  });
});
