import { randomUUID } from 'crypto';

import gql from 'graphql-tag';
import {
  ADMIN_TOKEN,
  ALICE_MEMBER_ID,
  ALICE_TOKEN,
  BOB_MEMBER_ID,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  cleanupSpiritRowAccessApp,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { updateFeatureFlag } from 'test/integration/metadata/suites/utils/update-feature-flag.util';
import { FeatureFlagKey } from 'twenty-shared/types';

const PAGE = 1;
const PAGE_SIZE = 20;

type Edge<TNode> = { node: TNode };

const listNodes = async (
  token: string,
  plural: string,
  filterType: string,
  filter: object,
  fields: string,
): Promise<Record<string, unknown>[]> => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritTimelineFixtures($filter: ${filterType}) {
          ${plural}(filter: $filter, first: 500) {
            edges {
              node {
                ${fields}
              }
            }
          }
        }
      `,
      variables: { filter },
    },
    token,
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data[plural].edges.map(
    (edge: Edge<Record<string, unknown>>) => edge.node,
  );
};

type TimelineResult = {
  total: number;
  items: number;
  relatedPersonIds: string[];
  errors: unknown;
};

const THREADS = 'totalNumberOfThreads relatedPersonIds timelineThreads { id }';
const EVENTS =
  'totalNumberOfCalendarEvents relatedPersonIds timelineCalendarEvents { id }';

const toResult = (
  body: { data?: Record<string, Record<string, unknown>>; errors?: unknown },
  queryName: string,
): TimelineResult => {
  const data = body.data?.[queryName] ?? {};

  return {
    total: (data.totalNumberOfThreads ??
      data.totalNumberOfCalendarEvents ??
      0) as number,
    items: (
      (data.timelineThreads ?? data.timelineCalendarEvents ?? []) as unknown[]
    ).length,
    relatedPersonIds: (data.relatedPersonIds ?? []) as string[],
    errors: body.errors,
  };
};

const fromObjectRecord = async (
  token: string,
  kind: 'threads' | 'events',
  objectNameSingular: string,
  recordId: string,
): Promise<TimelineResult> => {
  const queryName =
    kind === 'threads'
      ? 'getTimelineThreadsFromObjectRecord'
      : 'getTimelineCalendarEventsFromObjectRecord';
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritTimeline(
          $objectNameSingular: String!
          $recordId: UUID!
          $page: Int!
          $pageSize: Int!
        ) {
          ${queryName}(
            objectNameSingular: $objectNameSingular
            recordId: $recordId
            page: $page
            pageSize: $pageSize
          ) {
            ${kind === 'threads' ? THREADS : EVENTS}
          }
        }
      `,
      variables: {
        objectNameSingular,
        recordId,
        page: PAGE,
        pageSize: PAGE_SIZE,
      },
    },
    token,
  );

  return toResult(response.body, queryName);
};

const fromLegacyId = async (
  token: string,
  queryName: string,
  idArgName: string,
  recordId: string,
): Promise<TimelineResult> => {
  const selection = queryName.includes('Threads') ? THREADS : EVENTS;
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritLegacyTimeline($id: UUID!, $page: Int!, $pageSize: Int!) {
          ${queryName}(${idArgName}: $id, page: $page, pageSize: $pageSize) {
            ${selection}
          }
        }
      `,
      variables: { id: recordId, page: PAGE, pageSize: PAGE_SIZE },
    },
    token,
  );

  return toResult(response.body, queryName);
};

const COMPANY_TIMELINE_CALLS: {
  name: string;
  call: (token: string, companyId: string) => Promise<TimelineResult>;
}[] = [
  {
    name: 'getTimelineThreadsFromObjectRecord',
    call: (token, companyId) =>
      fromObjectRecord(token, 'threads', 'company', companyId),
  },
  {
    name: 'getTimelineCalendarEventsFromObjectRecord',
    call: (token, companyId) =>
      fromObjectRecord(token, 'events', 'company', companyId),
  },
  {
    name: 'getTimelineThreadsFromCompanyId',
    call: (token, companyId) =>
      fromLegacyId(
        token,
        'getTimelineThreadsFromCompanyId',
        'companyId',
        companyId,
      ),
  },
  {
    name: 'getTimelineCalendarEventsFromCompanyId',
    call: (token, companyId) =>
      fromLegacyId(
        token,
        'getTimelineCalendarEventsFromCompanyId',
        'companyId',
        companyId,
      ),
  },
];

// The seeded Apple workspace has company-targeted mail and meetings. Pick a
// company owned by bob (hidden from alice) and one owned by alice (control)
// that both have message-thread and calendar-event targets.
const findSeededCompaniesWithTimeline = async () => {
  const threadTargets = await listNodes(
    ADMIN_TOKEN,
    'messageThreadTargets',
    'MessageThreadTargetFilterInput',
    { targetCompanyId: { is: 'NOT_NULL' } },
    'targetCompanyId',
  );
  const eventTargets = await listNodes(
    ADMIN_TOKEN,
    'calendarEventTargets',
    'CalendarEventTargetFilterInput',
    { targetCompanyId: { is: 'NOT_NULL' } },
    'targetCompanyId',
  );
  const eventCompanyIds = new Set(
    eventTargets.map((node) => node.targetCompanyId as string),
  );
  const candidateIds = [
    ...new Set(
      threadTargets
        .map((node) => node.targetCompanyId as string)
        .filter((companyId) => eventCompanyIds.has(companyId)),
    ),
  ];
  const companies = await listNodes(
    ADMIN_TOKEN,
    'companies',
    'CompanyFilterInput',
    { id: { in: candidateIds } },
    'id accountOwnerId',
  );

  const bobCompanyId = companies.find(
    (company) => company.accountOwnerId === BOB_MEMBER_ID,
  )?.id as string | undefined;
  const aliceCompanyId = companies.find(
    (company) => company.accountOwnerId === ALICE_MEMBER_ID,
  )?.id as string | undefined;

  if (bobCompanyId === undefined || aliceCompanyId === undefined) {
    throw new Error('seeded companies with timeline targets not found');
  }

  return { bobCompanyId, aliceCompanyId };
};

describe('spirit owner row access: timeline guard (PI-7)', () => {
  let bobCompanyId: string;
  let aliceCompanyId: string;
  const opportunityOnBobCompanyId = randomUUID();

  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    ({ bobCompanyId, aliceCompanyId } =
      await findSeededCompaniesWithTimeline());

    const response = await makeGraphqlAPIRequest(
      createOneOperationFactory({
        objectMetadataSingularName: 'opportunity',
        gqlFields: 'id',
        data: {
          id: opportunityOnBobCompanyId,
          name: 'SpiritOwner timeline opportunity',
          companyId: bobCompanyId,
          // Owned by alice, so the opportunity itself stays visible to her
          // under the Spirit rules too (Opportunity by owner)
          ownerId: ALICE_MEMBER_ID,
          pointOfContactId: null,
        },
      }),
      ADMIN_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await makeGraphqlAPIRequest(
      destroyOneOperationFactory({
        objectMetadataSingularName: 'opportunity',
        gqlFields: 'id',
        recordId: opportunityOnBobCompanyId,
      }),
      ADMIN_TOKEN,
    );
  });

  it.each(COMPANY_TIMELINE_CALLS)(
    'PT-16: $name is empty for alice on a company owned by bob',
    async ({ call }) => {
      const asAdmin = await call(ADMIN_TOKEN, bobCompanyId);
      const asAlice = await call(ALICE_TOKEN, bobCompanyId);

      expect(asAdmin.errors).toBeUndefined();
      expect(asAdmin.total).toBeGreaterThan(0);
      expect(asAlice.errors).toBeUndefined();
      expect(asAlice).toEqual({
        total: 0,
        items: 0,
        relatedPersonIds: [],
        errors: undefined,
      });
    },
  );

  it.each(COMPANY_TIMELINE_CALLS)(
    'PT-16 control: $name still works for alice on her own company',
    async ({ call }) => {
      const asAlice = await call(ALICE_TOKEN, aliceCompanyId);

      expect(asAlice.errors).toBeUndefined();
      expect(asAlice.total).toBeGreaterThan(0);
    },
  );

  // D36: once the config makes alice see-all, she reads what the admin reads
  it.each(COMPANY_TIMELINE_CALLS)(
    'PT-16 control: $name for alice made see-all equals the admin view of B',
    async ({ call }) => {
      const asAdmin = await call(ADMIN_TOKEN, bobCompanyId);
      const asAlice = await withAliceSeeAll(rowAccessApp, () =>
        call(ALICE_TOKEN, bobCompanyId),
      );

      expect(asAdmin.total).toBeGreaterThan(0);
      expect({
        ...asAlice,
        relatedPersonIds: [...asAlice.relatedPersonIds].sort(),
      }).toEqual({
        ...asAdmin,
        relatedPersonIds: [...asAdmin.relatedPersonIds].sort(),
      });
    },
  );

  it('PT-16b control: alice made see-all is related to the people of B through the opportunity', async () => {
    const asAdmin = await fromObjectRecord(
      ADMIN_TOKEN,
      'threads',
      'opportunity',
      opportunityOnBobCompanyId,
    );
    const asAlice = await withAliceSeeAll(rowAccessApp, () =>
      fromObjectRecord(
        ALICE_TOKEN,
        'threads',
        'opportunity',
        opportunityOnBobCompanyId,
      ),
    );

    expect(asAdmin.relatedPersonIds.length).toBeGreaterThan(0);
    expect([...asAlice.relatedPersonIds].sort()).toEqual(
      [...asAdmin.relatedPersonIds].sort(),
    );
  });

  it('PT-16: the opportunity-id resolvers walk as alice too (no people of hidden B)', async () => {
    const threads = await fromLegacyId(
      ALICE_TOKEN,
      'getTimelineThreadsFromOpportunityId',
      'opportunityId',
      opportunityOnBobCompanyId,
    );
    const events = await fromLegacyId(
      ALICE_TOKEN,
      'getTimelineCalendarEventsFromOpportunityId',
      'opportunityId',
      opportunityOnBobCompanyId,
    );

    expect(threads.errors).toBeUndefined();
    expect(events.errors).toBeUndefined();
    expect(threads.relatedPersonIds).toEqual([]);
    expect(events.relatedPersonIds).toEqual([]);
  });

  it('PT-16b: a visible opportunity does not relate alice to the people of hidden B', async () => {
    const asAdmin = await fromObjectRecord(
      ADMIN_TOKEN,
      'threads',
      'opportunity',
      opportunityOnBobCompanyId,
    );
    const asAlice = await fromObjectRecord(
      ALICE_TOKEN,
      'threads',
      'opportunity',
      opportunityOnBobCompanyId,
    );

    expect(asAdmin.errors).toBeUndefined();
    expect(asAdmin.relatedPersonIds.length).toBeGreaterThan(0);
    expect(asAlice.errors).toBeUndefined();
    expect(asAlice.relatedPersonIds).toEqual([]);

    // The opportunity itself is visible to alice (positive control)
    expect(
      await listNodes(
        ALICE_TOKEN,
        'opportunities',
        'OpportunityFilterInput',
        { id: { eq: opportunityOnBobCompanyId } },
        'id',
      ),
    ).toEqual([{ id: opportunityOnBobCompanyId }]);
  });

  it('a thread on a visible person and hidden B reads the same in the person timeline and directly; its target row to B stays hidden', async () => {
    const bobThreadTargets = await listNodes(
      ADMIN_TOKEN,
      'messageThreadTargets',
      'MessageThreadTargetFilterInput',
      { targetCompanyId: { eq: bobCompanyId } },
      'messageThreadId',
    );
    const threadIds = bobThreadTargets.map(
      (node) => node.messageThreadId as string,
    );
    const personTargets = await listNodes(
      ADMIN_TOKEN,
      'messageThreadTargets',
      'MessageThreadTargetFilterInput',
      {
        messageThreadId: { in: threadIds },
        targetPersonId: { is: 'NOT_NULL' },
      },
      'messageThreadId targetPersonId',
    );

    expect(personTargets.length).toBeGreaterThan(0);

    // Pick the person with the fewest threads so the thread is on page one
    const allThreadsOfCandidates = await listNodes(
      ADMIN_TOKEN,
      'messageThreadTargets',
      'MessageThreadTargetFilterInput',
      {
        targetPersonId: {
          in: personTargets.map((node) => node.targetPersonId as string),
        },
      },
      'targetPersonId',
    );
    const threadCountByPersonId = new Map<string, number>();

    for (const node of allThreadsOfCandidates) {
      const personId = node.targetPersonId as string;

      threadCountByPersonId.set(
        personId,
        (threadCountByPersonId.get(personId) ?? 0) + 1,
      );
    }

    const { messageThreadId, targetPersonId } = [...personTargets].sort(
      (left, right) =>
        (threadCountByPersonId.get(left.targetPersonId as string) ?? 0) -
        (threadCountByPersonId.get(right.targetPersonId as string) ?? 0),
    )[0] as { messageThreadId: string; targetPersonId: string };

    const response = await makeGraphqlAPIRequest(
      {
        query: gql`
          query SpiritPersonThreads($recordId: UUID!) {
            getTimelineThreadsFromObjectRecord(
              objectNameSingular: "person"
              recordId: $recordId
              page: 1
              pageSize: 50
            ) {
              timelineThreads {
                id
                subject
              }
            }
          }
        `,
        variables: { recordId: targetPersonId },
      },
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();

    const listedInTimeline = (
      response.body.data.getTimelineThreadsFromObjectRecord.timelineThreads as {
        id: string;
      }[]
    ).some((thread) => thread.id === messageThreadId);

    const directRead = await listNodes(
      ALICE_TOKEN,
      'messageThreads',
      'MessageThreadFilterInput',
      { id: { eq: messageThreadId } },
      'id',
    );

    const targetRowsToB = await listNodes(
      ALICE_TOKEN,
      'messageThreadTargets',
      'MessageThreadTargetFilterInput',
      { messageThreadId: { eq: messageThreadId } },
      'id targetCompanyId targetPersonId',
    );

    expect(listedInTimeline).toBe(true);
    expect(directRead.map((node) => node.id)).toEqual([messageThreadId]);
    expect(
      targetRowsToB.filter((node) => node.targetCompanyId === bobCompanyId),
    ).toEqual([]);
    expect(
      targetRowsToB.filter((node) => node.targetPersonId === targetPersonId),
    ).toHaveLength(1);
  });

  describe('with message/calendar target reads off (legacy person walk)', () => {
    beforeAll(async () => {
      await updateFeatureFlag({
        featureFlag: FeatureFlagKey.IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED,
        value: false,
        expectToFail: false,
      });
    });

    afterAll(async () => {
      await updateFeatureFlag({
        featureFlag: FeatureFlagKey.IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED,
        value: true,
        expectToFail: false,
      });
    });

    it('PT-16b: mail of hidden B people does not reach alice through a visible opportunity', async () => {
      const asAdmin = await fromObjectRecord(
        ADMIN_TOKEN,
        'threads',
        'opportunity',
        opportunityOnBobCompanyId,
      );
      const asAlice = await fromObjectRecord(
        ALICE_TOKEN,
        'threads',
        'opportunity',
        opportunityOnBobCompanyId,
      );

      expect(asAdmin.errors).toBeUndefined();
      expect(asAdmin.total).toBeGreaterThan(0);
      expect(asAlice.errors).toBeUndefined();
      expect(asAlice.total).toBe(0);
      expect(asAlice.relatedPersonIds).toEqual([]);
    });

    it('PT-16b: meetings of hidden B people do not reach alice through a visible opportunity', async () => {
      const asAdmin = await fromObjectRecord(
        ADMIN_TOKEN,
        'events',
        'opportunity',
        opportunityOnBobCompanyId,
      );
      const asAlice = await fromObjectRecord(
        ALICE_TOKEN,
        'events',
        'opportunity',
        opportunityOnBobCompanyId,
      );

      expect(asAdmin.errors).toBeUndefined();
      expect(asAdmin.total).toBeGreaterThan(0);
      expect(asAlice.total).toBe(0);
    });

    it('PT-16b control (legacy): alice made see-all gets the mail and meetings of B people through the opportunity', async () => {
      const [threads, events] = await withAliceSeeAll(rowAccessApp, () =>
        Promise.all([
          fromObjectRecord(
            ALICE_TOKEN,
            'threads',
            'opportunity',
            opportunityOnBobCompanyId,
          ),
          fromObjectRecord(
            ALICE_TOKEN,
            'events',
            'opportunity',
            opportunityOnBobCompanyId,
          ),
        ]),
      );

      expect(threads.total).toBeGreaterThan(0);
      expect(events.total).toBeGreaterThan(0);
    });

    it.each(COMPANY_TIMELINE_CALLS)(
      'PT-16 (legacy): $name is empty for alice on a company owned by bob',
      async ({ call }) => {
        const asAdmin = await call(ADMIN_TOKEN, bobCompanyId);
        const asAlice = await call(ALICE_TOKEN, bobCompanyId);

        expect(asAdmin.total).toBeGreaterThan(0);
        expect(asAlice.total).toBe(0);
        expect(asAlice.relatedPersonIds).toEqual([]);
      },
    );
  });
});
