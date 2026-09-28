import { type ObjectRecordEvent } from 'twenty-shared/database-events';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type FlatWorkspaceMemberMaps } from 'src/engine/core-modules/user/types/flat-workspace-member-maps.type';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type ObjectRecordSubscriptionEvent } from 'src/engine/subscriptions/types/object-record-subscription-event.type';
import { SPIRIT_LIVE_EVENTS_OFF } from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-live-events-off.constant';
import { SpiritLiveEventService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-live-event.service';
import { type SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import { type SpiritRowAccessWorkspaceSnapshot } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-workspace-snapshot.type';
import {
  SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME,
  setSpiritRowAccessEnforcedByLivePeer,
} from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import {
  getWorkspaceContext,
  type ORMWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';

const WORKSPACE_ID = 'workspace-id';
const ALICE = 'alice-member-id';
const BOB = 'bob-member-id';
const MEMBER_ROLE_ID = 'role-member';
const ADMIN_ROLE_ID = 'role-admin';

const buildMaps = <TEntity extends FlatObjectMetadata | OrmFlatFieldMetadata>(
  entities: { id: string; universalIdentifier: string }[],
) =>
  ({
    byUniversalIdentifier: Object.fromEntries(
      entities.map((entity) => [entity.universalIdentifier, entity]),
    ),
    universalIdentifierById: Object.fromEntries(
      entities.map((entity) => [entity.id, entity.universalIdentifier]),
    ),
    universalIdentifiersByApplicationId: {},
  }) as unknown as FlatEntityMaps<TEntity>;

const manyToOne = (objectName: string, name: string, target: string) => ({
  id: `field-${objectName}-${name}`,
  universalIdentifier: `uid-field-${objectName}-${name}`,
  objectMetadataId: `object-${objectName}`,
  name,
  type: FieldMetadataType.RELATION,
  isActive: true,
  relationTargetObjectMetadataId: `object-${target}`,
  settings: {
    relationType: RelationType.MANY_TO_ONE,
    joinColumnName: `${name}Id`,
  },
});

const FIELDS = [
  manyToOne('company', 'accountOwner', 'workspaceMember'),
  manyToOne('attachment', 'targetCompany', 'company'),
];

const OBJECTS = [
  { name: 'workspaceMember', isSystem: true },
  { name: 'company', isSystem: false },
  { name: 'person', isSystem: false },
  { name: 'attachment', isSystem: true },
].map(({ name, isSystem }) => ({
  id: `object-${name}`,
  universalIdentifier:
    name === 'workspaceMember'
      ? STANDARD_OBJECTS.workspaceMember.universalIdentifier
      : `uid-object-${name}`,
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

const SNAPSHOT: SpiritRowAccessWorkspaceSnapshot = {
  state: {
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
  },
  flatObjectMetadataMaps: buildMaps<FlatObjectMetadata>(
    OBJECTS as unknown as { id: string; universalIdentifier: string }[],
  ),
  flatFieldMetadataMaps: buildMaps<OrmFlatFieldMetadata>(FIELDS),
  objectIdByNameSingular: Object.fromEntries(
    OBJECTS.map((object) => [object.nameSingular, object.id]),
  ),
};

const FLAT_WORKSPACE_MEMBER_MAPS = {
  byId: { [ALICE]: { id: ALICE } },
  idByUserId: { 'alice-user': ALICE },
} as unknown as FlatWorkspaceMemberMaps;

const ALICE_SUBSCRIBER = {
  userId: 'alice-user',
  userWorkspaceId: 'alice-user-workspace',
  workspaceMemberId: ALICE,
};

const companyEvent = (
  recordId: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): ObjectRecordEvent =>
  ({
    recordId,
    properties: {
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
    },
  }) as unknown as ObjectRecordEvent;

const toSubscriptionEvent = (
  event: ObjectRecordEvent,
  objectNameSingular = 'company',
): ObjectRecordSubscriptionEvent => ({
  ...event,
  action: DatabaseEventAction.UPDATED,
  objectNameSingular,
});

const buildService = ({
  snapshot = SNAPSHOT,
  rereadIds = [],
}: {
  snapshot?: SpiritRowAccessWorkspaceSnapshot | null;
  rereadIds?: string[];
} = {}) => {
  const loadSnapshot = jest.fn().mockResolvedValue(snapshot ?? undefined);
  const find = jest.fn(async () => rereadIds.map((id) => ({ id })));
  const executeInWorkspaceContext = jest.fn(
    async (fn: () => unknown, authContext: WorkspaceAuthContext) =>
      withWorkspaceContext({ authContext } as ORMWorkspaceContext, fn),
  );

  const service = new SpiritLiveEventService(
    { loadSnapshot } as unknown as SpiritRowAccessStateService,
    {
      executeInWorkspaceContext,
      getRepository: jest.fn(() => ({ find })),
    } as unknown as WorkspaceOrmManager,
  );

  return { service, loadSnapshot, executeInWorkspaceContext, find };
};

const openStream = async (
  service: SpiritLiveEventService,
  {
    objectName = 'company',
    events = [],
    roleIds = [MEMBER_ROLE_ID],
    subscriber = ALICE_SUBSCRIBER,
  }: {
    objectName?: string;
    events?: ObjectRecordEvent[];
    roleIds?: string[];
    subscriber?: Partial<typeof ALICE_SUBSCRIBER>;
  } = {},
) =>
  (await service.prepareBatch(WORKSPACE_ID)).openStream({
    workspaceEventBatch: {
      name: `${objectName}.updated`,
      workspaceId: WORKSPACE_ID,
      objectMetadata: findObject(objectName),
      events,
    },
    roleIds,
    subscriberAuthContext: subscriber,
    flatWorkspaceMemberMaps: FLAT_WORKSPACE_MEMBER_MAPS,
  });

describe('SpiritLiveEventService (design §5.8)', () => {
  afterEach(() => {
    delete process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME];
    setSpiritRowAccessEnforcedByLivePeer(false);
  });

  describe('off', () => {
    it('returns the off gate and reads nothing', async () => {
      const { service, loadSnapshot } = buildService();

      expect(await service.prepareBatch(WORKSPACE_ID)).toBe(
        SPIRIT_LIVE_EVENTS_OFF,
      );
      expect(loadSnapshot).not.toHaveBeenCalled();
    });

    it('delivers the filtered event itself and runs enrichment once', async () => {
      const { service } = buildService();
      const stream = await openStream(service);
      const rawEvent = companyEvent('b', undefined, { accountOwnerId: BOB });
      const filteredEvent = toSubscriptionEvent(rawEvent);
      const enrich = jest.fn().mockResolvedValue(undefined);

      expect(stream.deliver(rawEvent, filteredEvent)).toBe(filteredEvent);

      await stream.runEnrichment(enrich);

      expect(enrich).toHaveBeenCalledTimes(1);
    });

    it('lets an enrichment failure reach the caller', async () => {
      const { service } = buildService();
      const stream = await openStream(service);

      await expect(
        stream.runEnrichment(() => Promise.reject(new Error('enrich failed'))),
      ).rejects.toThrow('enrich failed');
    });
  });

  it('switch unset but a live peer has it on: enforces the rule (D40)', async () => {
    setSpiritRowAccessEnforcedByLivePeer(true);

    const { service, loadSnapshot } = buildService();
    const batch = await service.prepareBatch(WORKSPACE_ID);

    expect(loadSnapshot).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(batch).not.toBe(SPIRIT_LIVE_EVENTS_OFF);

    const stream = await openStream(service);
    const rawEvent = companyEvent('b', undefined, { accountOwnerId: BOB });

    expect(
      stream.deliver(rawEvent, toSubscriptionEvent(rawEvent)),
    ).toBeUndefined();
  });

  describe('on', () => {
    beforeEach(() => {
      process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME] = 'true';
    });

    it('a see-all subscriber gets the upstream enrichment, with no context switch', async () => {
      const { service, executeInWorkspaceContext } = buildService();
      const stream = await openStream(service, { roleIds: [ADMIN_ROLE_ID] });
      const enrich = jest.fn().mockResolvedValue(undefined);

      await stream.runEnrichment(enrich);

      expect(enrich).toHaveBeenCalledTimes(1);
      expect(executeInWorkspaceContext).not.toHaveBeenCalled();
    });

    it('a Member with no member id gets no enrichment (D10)', async () => {
      const { service } = buildService();
      const stream = await openStream(service, {
        subscriber: { userId: 'user', userWorkspaceId: 'user-workspace' },
      });
      const enrich = jest.fn().mockResolvedValue(undefined);

      await stream.runEnrichment(enrich);

      expect(enrich).not.toHaveBeenCalled();
    });

    it('a Member: re-reads child ids and enriches as herself, loading her context once', async () => {
      const { service, executeInWorkspaceContext, find } = buildService({
        rereadIds: ['attachment-of-a'],
      });
      const events = [
        companyEvent('attachment-of-a', undefined, {}),
        companyEvent('attachment-of-b', undefined, {}),
      ];
      const stream = await openStream(service, {
        objectName: 'attachment',
        events,
      });

      expect(
        events.map(
          (event) =>
            stream.deliver(event, toSubscriptionEvent(event, 'attachment'))
              ?.recordId,
        ),
      ).toEqual(['attachment-of-a', undefined]);
      expect(find).toHaveBeenCalledTimes(1);

      let enrichedAs: string | undefined;

      await stream.runEnrichment(async () => {
        const authContext = getWorkspaceContext().authContext as {
          workspaceMemberId?: string;
        };

        enrichedAs = authContext.workspaceMemberId;
      });

      expect(enrichedAs).toBe(ALICE);
      expect(executeInWorkspaceContext).toHaveBeenCalledTimes(1);
    });

    it('drops every event when the rule is on but no snapshot loads', async () => {
      const { service } = buildService({ snapshot: null });
      const stream = await openStream(service, { objectName: 'person' });
      const rawEvent = companyEvent('p', undefined, {});

      expect(
        stream.deliver(rawEvent, toSubscriptionEvent(rawEvent, 'person')),
      ).toBeUndefined();
    });

    it('keeps her own company and drops the company of bob (PT-15)', async () => {
      const { service } = buildService();
      const stream = await openStream(service);
      const own = companyEvent('a', undefined, { accountOwnerId: ALICE });
      const ofBob = companyEvent('b', undefined, { accountOwnerId: BOB });

      expect(stream.deliver(own, toSubscriptionEvent(own))?.recordId).toBe('a');
      expect(stream.deliver(ofBob, toSubscriptionEvent(ofBob))).toBeUndefined();
    });

    it('the move-away delete holds no field that the filtered event left out', async () => {
      const { service } = buildService();
      const stream = await openStream(service);
      const rawEvent = companyEvent(
        'a',
        { id: 'a', accountOwnerId: ALICE, secret: 'restricted value' },
        { id: 'a', accountOwnerId: BOB, secret: 'restricted value' },
      );
      const filteredEvent = toSubscriptionEvent(
        companyEvent(
          'a',
          { id: 'a', accountOwnerId: ALICE },
          { id: 'a', accountOwnerId: BOB },
        ),
      );

      const delivered = stream.deliver(rawEvent, filteredEvent);

      expect(delivered?.action).toBe(DatabaseEventAction.DELETED);
      expect(JSON.stringify(delivered)).not.toContain('restricted value');
      expect(delivered?.properties).toMatchObject({
        before: { id: 'a', accountOwnerId: ALICE },
      });
    });
  });
});
