import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type FlatRoleMaps } from 'src/engine/metadata-modules/flat-role/types/flat-role-maps.type';
import { validateSpiritRowAccessConfig } from 'src/engine/twenty-orm/spirit-row-access/utils/validate-spirit-row-access-config.util';

const COMPANY_ID = 'object-company';
const OPPORTUNITY_ID = 'object-opportunity';
const TASK_ID = 'object-task';
const PERSON_ID = 'object-person';
const TIMELINE_ACTIVITY_ID = 'object-timeline-activity';
const CUSTOM_OBJECT_ID = 'object-custom-rocket';
const OTHER_APP_OBJECT_ID = 'object-other-app-invoice';
const OWN_APP_OBJECT_ID = 'object-own-app-lead';
const WORKSPACE_MEMBER_ID = 'object-workspace-member';
const ACCOUNT_OWNER_ID = 'field-account-owner';
const OPPORTUNITY_OWNER_ID = 'field-opportunity-owner';
const TASK_ASSIGNEE_ID = 'field-task-assignee';
const PERSON_OWNER_ID = 'field-person-owner';
const TIMELINE_ACTIVITY_MEMBER_ID = 'field-timeline-activity-member';
const CUSTOM_OWNER_ID = 'field-custom-owner';
const OTHER_APP_OWNER_ID = 'field-other-app-owner';
const OWN_APP_OWNER_ID = 'field-own-app-owner';
const WORKSPACE_MEMBER_SELF_ID = 'field-workspace-member-self';
const NAME_FIELD_ID = 'field-name';
const MANAGER_ROLE_ID = 'role-manager';
const STANDARD_APPLICATION_ID = 'application-standard';
const WORKSPACE_CUSTOM_APPLICATION_ID = 'application-workspace-custom';
const OTHER_APPLICATION_ID = 'application-other-installed-app';
const OWN_APPLICATION_ID = 'application-own-spirit-app';

const buildMaps = <TEntity extends { id: string }>(entities: TEntity[]) =>
  ({
    byUniversalIdentifier: Object.fromEntries(
      entities.map((entity) => [`uid-${entity.id}`, entity]),
    ),
    universalIdentifierById: Object.fromEntries(
      entities.map((entity) => [entity.id, `uid-${entity.id}`]),
    ),
    universalIdentifiersByApplicationId: {},
  }) as unknown as FlatEntityMaps<never>;

const flatObjectMetadataMaps = buildMaps([
  {
    id: COMPANY_ID,
    nameSingular: 'company',
    applicationId: STANDARD_APPLICATION_ID,
    universalIdentifier: STANDARD_OBJECTS.company.universalIdentifier,
    isSystem: false,
    isActive: true,
  },
  {
    id: OPPORTUNITY_ID,
    nameSingular: 'opportunity',
    applicationId: STANDARD_APPLICATION_ID,
    universalIdentifier: STANDARD_OBJECTS.opportunity.universalIdentifier,
    isSystem: false,
    isActive: true,
  },
  {
    id: TASK_ID,
    nameSingular: 'task',
    applicationId: STANDARD_APPLICATION_ID,
    universalIdentifier: STANDARD_OBJECTS.task.universalIdentifier,
    isSystem: false,
    isActive: true,
  },
  {
    id: PERSON_ID,
    nameSingular: 'person',
    applicationId: STANDARD_APPLICATION_ID,
    universalIdentifier: STANDARD_OBJECTS.person.universalIdentifier,
    isSystem: false,
    isActive: true,
  },
  {
    id: TIMELINE_ACTIVITY_ID,
    nameSingular: 'timelineActivity',
    applicationId: STANDARD_APPLICATION_ID,
    universalIdentifier: STANDARD_OBJECTS.timelineActivity.universalIdentifier,
    isSystem: true,
    isActive: true,
  },
  {
    id: CUSTOM_OBJECT_ID,
    nameSingular: 'rocket',
    universalIdentifier: 'a-custom-object-universal-identifier',
    applicationId: WORKSPACE_CUSTOM_APPLICATION_ID,
    isSystem: false,
    isActive: true,
  },
  {
    id: OTHER_APP_OBJECT_ID,
    nameSingular: 'invoice',
    universalIdentifier: 'an-other-app-object-universal-identifier',
    applicationId: OTHER_APPLICATION_ID,
    isSystem: false,
    isActive: true,
  },
  {
    id: OWN_APP_OBJECT_ID,
    nameSingular: 'lead',
    universalIdentifier: 'an-own-app-object-universal-identifier',
    applicationId: OWN_APPLICATION_ID,
    isSystem: false,
    isActive: true,
  },
  {
    id: WORKSPACE_MEMBER_ID,
    nameSingular: 'workspaceMember',
    applicationId: STANDARD_APPLICATION_ID,
    universalIdentifier: STANDARD_OBJECTS.workspaceMember.universalIdentifier,
    isSystem: true,
    isActive: true,
  },
]) as unknown as FlatEntityMaps<FlatObjectMetadata>;

const buildOwnerField = (
  id: string,
  objectMetadataId: string,
  joinColumnName: string,
) => ({
  id,
  name: joinColumnName.replace(/Id$/, ''),
  type: FieldMetadataType.RELATION,
  objectMetadataId,
  relationTargetObjectMetadataId: WORKSPACE_MEMBER_ID,
  isActive: true,
  settings: { relationType: RelationType.MANY_TO_ONE, joinColumnName },
});

const flatFieldMetadataMaps = buildMaps([
  buildOwnerField(ACCOUNT_OWNER_ID, COMPANY_ID, 'accountOwnerId'),
  buildOwnerField(OPPORTUNITY_OWNER_ID, OPPORTUNITY_ID, 'ownerId'),
  buildOwnerField(TASK_ASSIGNEE_ID, TASK_ID, 'assigneeId'),
  buildOwnerField(PERSON_OWNER_ID, PERSON_ID, 'personOwnerId'),
  buildOwnerField(
    TIMELINE_ACTIVITY_MEMBER_ID,
    TIMELINE_ACTIVITY_ID,
    'workspaceMemberId',
  ),
  buildOwnerField(CUSTOM_OWNER_ID, CUSTOM_OBJECT_ID, 'rocketOwnerId'),
  buildOwnerField(OTHER_APP_OWNER_ID, OTHER_APP_OBJECT_ID, 'invoiceOwnerId'),
  buildOwnerField(OWN_APP_OWNER_ID, OWN_APP_OBJECT_ID, 'ownerId'),
  buildOwnerField(
    WORKSPACE_MEMBER_SELF_ID,
    WORKSPACE_MEMBER_ID,
    'managerMemberId',
  ),
  {
    id: NAME_FIELD_ID,
    name: 'name',
    type: FieldMetadataType.TEXT,
    objectMetadataId: COMPANY_ID,
    isActive: true,
  },
]) as unknown as FlatEntityMaps<OrmFlatFieldMetadata>;

const flatRoleMaps = buildMaps([
  { id: MANAGER_ROLE_ID },
]) as unknown as FlatRoleMaps;

const validate = (
  rawConfig: unknown,
  options: {
    workspaceCustomApplicationId?: string | undefined;
    ownApplicationIds?: string[];
  } = {},
) =>
  validateSpiritRowAccessConfig({
    rawConfig,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
    flatRoleMaps,
    workspaceMemberObjectMetadataId: WORKSPACE_MEMBER_ID,
    workspaceCustomApplicationId:
      'workspaceCustomApplicationId' in options
        ? options.workspaceCustomApplicationId
        : WORKSPACE_CUSTOM_APPLICATION_ID,
    ownApplicationIds: options.ownApplicationIds ?? [OWN_APPLICATION_ID],
  });

const OWN_APP_RULE = {
  objectMetadataId: OWN_APP_OBJECT_ID,
  ownerFieldMetadataId: OWN_APP_OWNER_ID,
  isEnabled: true,
};

const COMPANY_RULE = {
  objectMetadataId: COMPANY_ID,
  ownerFieldMetadataId: ACCOUNT_OWNER_ID,
  isEnabled: true,
};

describe('validateSpiritRowAccessConfig', () => {
  it('accepts the design example (company.accountOwner, one see-all role)', () => {
    expect(
      validate({
        version: 1,
        rules: [COMPANY_RULE],
        seeAllRoleIds: [MANAGER_ROLE_ID],
      }),
    ).toEqual({
      isValid: true,
      config: {
        version: 1,
        rules: [COMPANY_RULE],
        seeAllRoleIds: [MANAGER_ROLE_ID],
      },
      droppedSeeAllRoleIds: [],
    });
  });

  it('accepts the empty config the app installs with', () => {
    expect(validate({ version: 1, rules: [], seeAllRoleIds: [] })).toEqual({
      isValid: true,
      config: { version: 1, rules: [], seeAllRoleIds: [] },
      droppedSeeAllRoleIds: [],
    });
  });

  it.each([
    ['a string', 'not an object'],
    ['an array', []],
    ['null', null],
    ['a wrong version', { version: 2, rules: [], seeAllRoleIds: [] }],
    [
      'an unknown top-level key',
      { version: 1, rules: [], seeAllRoleIds: [], extra: 1 },
    ],
    [
      'rules that are not an array',
      { version: 1, rules: {}, seeAllRoleIds: [] },
    ],
    ['a missing seeAllRoleIds', { version: 1, rules: [] }],
    [
      'an unknown rule key',
      {
        version: 1,
        rules: [{ ...COMPANY_RULE, extra: true }],
        seeAllRoleIds: [],
      },
    ],
    [
      'isEnabled as a string',
      {
        version: 1,
        rules: [{ ...COMPANY_RULE, isEnabled: 'true' }],
        seeAllRoleIds: [],
      },
    ],
    [
      'the same object twice',
      { version: 1, rules: [COMPANY_RULE, COMPANY_RULE], seeAllRoleIds: [] },
    ],
    [
      'an object id that does not exist',
      {
        version: 1,
        rules: [{ ...COMPANY_RULE, objectMetadataId: 'object-missing' }],
        seeAllRoleIds: [],
      },
    ],
    [
      'an owner field that is not a relation',
      {
        version: 1,
        rules: [{ ...COMPANY_RULE, ownerFieldMetadataId: NAME_FIELD_ID }],
        seeAllRoleIds: [],
      },
    ],
    [
      'an owner field that does not exist',
      {
        version: 1,
        rules: [{ ...COMPANY_RULE, ownerFieldMetadataId: 'field-missing' }],
        seeAllRoleIds: [],
      },
    ],
    [
      'the same see-all role twice',
      {
        version: 1,
        rules: [COMPANY_RULE],
        seeAllRoleIds: [MANAGER_ROLE_ID, MANAGER_ROLE_ID],
      },
    ],
    [
      'an enabled rule on person (standard, not audited: D32)',
      {
        version: 1,
        rules: [
          {
            objectMetadataId: PERSON_ID,
            ownerFieldMetadataId: PERSON_OWNER_ID,
            isEnabled: true,
          },
        ],
        seeAllRoleIds: [],
      },
    ],
    [
      'an enabled rule on a system object (timelineActivity)',
      {
        version: 1,
        rules: [
          {
            objectMetadataId: TIMELINE_ACTIVITY_ID,
            ownerFieldMetadataId: TIMELINE_ACTIVITY_MEMBER_ID,
            isEnabled: true,
          },
        ],
        seeAllRoleIds: [],
      },
    ],
    [
      'an enabled rule on workspaceMember',
      {
        version: 1,
        rules: [
          {
            objectMetadataId: WORKSPACE_MEMBER_ID,
            ownerFieldMetadataId: WORKSPACE_MEMBER_SELF_ID,
            isEnabled: true,
          },
        ],
        seeAllRoleIds: [],
      },
    ],
    [
      'an enabled rule on an object of another installed app (D41)',
      {
        version: 1,
        rules: [
          {
            objectMetadataId: OTHER_APP_OBJECT_ID,
            ownerFieldMetadataId: OTHER_APP_OWNER_ID,
            isEnabled: true,
          },
        ],
        seeAllRoleIds: [],
      },
    ],
    [
      'a see-all role that is not a string',
      { version: 1, rules: [COMPANY_RULE], seeAllRoleIds: [42] },
    ],
  ])('rejects %s', (_label, rawConfig) => {
    expect(validate(rawConfig).isValid).toBe(false);
  });

  it('checks only the shape of a disabled rule, so a stale field there does not fail closed', () => {
    expect(
      validate({
        version: 1,
        rules: [
          {
            ...COMPANY_RULE,
            ownerFieldMetadataId: 'field-missing',
            isEnabled: false,
          },
        ],
        seeAllRoleIds: [],
      }).isValid,
    ).toBe(true);
  });

  it('rejects an owner field that sits on another object', () => {
    const result = validate({
      version: 1,
      rules: [
        {
          objectMetadataId: CUSTOM_OBJECT_ID,
          ownerFieldMetadataId: ACCOUNT_OWNER_ID,
          isEnabled: true,
        },
      ],
      seeAllRoleIds: [],
    });

    expect(result.isValid).toBe(false);
  });

  it('names the object of another app in the problem (D41)', () => {
    expect(
      validate({
        version: 1,
        rules: [
          {
            objectMetadataId: OTHER_APP_OBJECT_ID,
            ownerFieldMetadataId: OTHER_APP_OWNER_ID,
            isEnabled: true,
          },
        ],
        seeAllRoleIds: [],
      }),
    ).toEqual({
      isValid: false,
      problems: [
        "rules[0] object invoice cannot hold a rule: only company, opportunity, task, the workspace's own custom objects and objects of our own apps can",
      ],
    });
  });

  it('refuses a custom object when the workspace custom application is unknown (D41)', () => {
    expect(
      validate(
        {
          version: 1,
          rules: [
            {
              objectMetadataId: CUSTOM_OBJECT_ID,
              ownerFieldMetadataId: CUSTOM_OWNER_ID,
              isEnabled: true,
            },
          ],
          seeAllRoleIds: [],
        },
        { workspaceCustomApplicationId: undefined },
      ).isValid,
    ).toBe(false);
  });

  it('accepts a rule on an object of one of our own apps', () => {
    expect(
      validate({ version: 1, rules: [OWN_APP_RULE], seeAllRoleIds: [] }),
    ).toEqual({
      isValid: true,
      config: { version: 1, rules: [OWN_APP_RULE], seeAllRoleIds: [] },
      droppedSeeAllRoleIds: [],
    });
  });

  it('refuses the same object when its app is not one of our own apps (D41)', () => {
    expect(
      validate(
        { version: 1, rules: [OWN_APP_RULE], seeAllRoleIds: [] },
        { ownApplicationIds: [OTHER_APPLICATION_ID] },
      ),
    ).toEqual({
      isValid: false,
      problems: [
        "rules[0] object lead cannot hold a rule: only company, opportunity, task, the workspace's own custom objects and objects of our own apps can",
      ],
    });
  });

  it('accepts rules on the audited objects: company, opportunity, task and a workspace custom object (D32, D41)', () => {
    const rules = [
      COMPANY_RULE,
      {
        objectMetadataId: OPPORTUNITY_ID,
        ownerFieldMetadataId: OPPORTUNITY_OWNER_ID,
        isEnabled: true,
      },
      {
        objectMetadataId: TASK_ID,
        ownerFieldMetadataId: TASK_ASSIGNEE_ID,
        isEnabled: true,
      },
      {
        objectMetadataId: CUSTOM_OBJECT_ID,
        ownerFieldMetadataId: CUSTOM_OWNER_ID,
        isEnabled: true,
      },
    ];

    expect(validate({ version: 1, rules, seeAllRoleIds: [] })).toEqual({
      isValid: true,
      config: { version: 1, rules, seeAllRoleIds: [] },
      droppedSeeAllRoleIds: [],
    });
  });

  it('drops a see-all role that does not exist and keeps the rest (D25)', () => {
    expect(
      validate({
        version: 1,
        rules: [COMPANY_RULE],
        seeAllRoleIds: ['role-deleted', MANAGER_ROLE_ID],
      }),
    ).toEqual({
      isValid: true,
      config: {
        version: 1,
        rules: [COMPANY_RULE],
        seeAllRoleIds: [MANAGER_ROLE_ID],
      },
      droppedSeeAllRoleIds: ['role-deleted'],
    });
  });

  it('still rejects the whole config when a rule is bad, even with a deleted see-all role in it', () => {
    expect(
      validate({
        version: 1,
        rules: [{ ...COMPANY_RULE, ownerFieldMetadataId: 'field-missing' }],
        seeAllRoleIds: ['role-deleted'],
      }).isValid,
    ).toBe(false);
  });
});
