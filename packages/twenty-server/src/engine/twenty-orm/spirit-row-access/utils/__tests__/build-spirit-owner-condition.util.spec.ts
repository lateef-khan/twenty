import { FieldMetadataType } from 'twenty-shared/types';

import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type SpiritRowAccessRule } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-config.type';
import { buildSpiritOwnerCondition } from 'src/engine/twenty-orm/spirit-row-access/utils/build-spirit-owner-condition.util';

const COMPANY_OBJECT_ID = 'company-object-id';
const WORKSPACE_MEMBER_OBJECT_ID = 'workspace-member-object-id';
const ACCOUNT_OWNER_FIELD_ID = 'account-owner-field-id';
const ALICE_MEMBER_ID = '20202020-77d5-4cb6-b60a-f4a835a85d61';

const ALWAYS_FALSE = { sql: '1=0', parameters: {} };

const RULE: SpiritRowAccessRule = {
  objectMetadataId: COMPANY_OBJECT_ID,
  ownerFieldMetadataId: ACCOUNT_OWNER_FIELD_ID,
  isEnabled: true,
};

const buildOwnerField = (
  overrides: Partial<OrmFlatFieldMetadata> = {},
): OrmFlatFieldMetadata =>
  ({
    id: ACCOUNT_OWNER_FIELD_ID,
    objectMetadataId: COMPANY_OBJECT_ID,
    name: 'accountOwner',
    type: FieldMetadataType.RELATION,
    isActive: true,
    relationTargetObjectMetadataId: WORKSPACE_MEMBER_OBJECT_ID,
    settings: {
      relationType: RelationType.MANY_TO_ONE,
      joinColumnName: 'accountOwnerId',
    },
    ...overrides,
  }) as unknown as OrmFlatFieldMetadata;

const build = (
  overrides: Partial<Parameters<typeof buildSpiritOwnerCondition>[0]> = {},
) =>
  buildSpiritOwnerCondition({
    rule: RULE,
    caller: { kind: 'owner', workspaceMemberId: ALICE_MEMBER_ID },
    alias: 'company',
    ownerFieldMetadata: buildOwnerField(),
    workspaceMemberObjectMetadataId: WORKSPACE_MEMBER_OBJECT_ID,
    ...overrides,
  });

describe('buildSpiritOwnerCondition', () => {
  it('returns nothing when the object has no rule', () => {
    expect(build({ rule: undefined })).toBeUndefined();
  });

  it('returns nothing when the rule is turned off', () => {
    expect(build({ rule: { ...RULE, isEnabled: false } })).toBeUndefined();
  });

  it('returns nothing for a see-all caller', () => {
    expect(build({ caller: { kind: 'see-all' } })).toBeUndefined();
  });

  it('is always false for a caller with no workspace member', () => {
    expect(
      build({ caller: { kind: 'owner', workspaceMemberId: null } }),
    ).toEqual(ALWAYS_FALSE);
  });

  it('matches the owner join column to the member id on the main alias', () => {
    expect(build()).toEqual({
      sql: '"company"."accountOwnerId" = :spiritOwner_company',
      parameters: { spiritOwner_company: ALICE_MEMBER_ID },
    });
  });

  it('quotes an EXISTS relation-filter alias and names the parameter after it', () => {
    expect(build({ alias: 'person_company_filter_2' })).toEqual({
      sql: '"person_company_filter_2"."accountOwnerId" = :spiritOwner_person_company_filter_2',
      parameters: { spiritOwner_person_company_filter_2: ALICE_MEMBER_ID },
    });
  });

  it('escapes a double quote in the alias and strips it from the parameter name', () => {
    expect(build({ alias: 'we"ird' })).toEqual({
      sql: '"we""ird"."accountOwnerId" = :spiritOwner_weird',
      parameters: { spiritOwner_weird: ALICE_MEMBER_ID },
    });
  });

  it.each([
    ['missing', undefined],
    ['inactive', buildOwnerField({ isActive: false })],
    [
      'on another object',
      buildOwnerField({ objectMetadataId: 'person-object-id' }),
    ],
    ['not a relation', buildOwnerField({ type: FieldMetadataType.TEXT })],
    [
      'ONE_TO_MANY',
      buildOwnerField({
        settings: {
          relationType: RelationType.ONE_TO_MANY,
        } as OrmFlatFieldMetadata['settings'],
      }),
    ],
    [
      'pointing at another object',
      buildOwnerField({ relationTargetObjectMetadataId: 'person-object-id' }),
    ],
  ])('is always false when the owner field is %s', (_, ownerFieldMetadata) => {
    expect(build({ ownerFieldMetadata })).toEqual(ALWAYS_FALSE);
  });
});
