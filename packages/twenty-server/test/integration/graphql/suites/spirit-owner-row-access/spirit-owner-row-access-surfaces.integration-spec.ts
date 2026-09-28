import { randomUUID } from 'crypto';

import gql from 'graphql-tag';
import {
  ADMIN_TOKEN,
  ALICE_MEMBER_ID,
  ALICE_TOKEN,
  BOB_MEMBER_ID,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  cleanupSpiritRowAccessApp,
  isSpiritRulesTestMode,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { findOneOperationFactory } from 'test/integration/graphql/utils/find-one-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

type Node = Record<string, unknown>;

type Connection = {
  nodes: Node[];
  cursors: string[];
  totalCount?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
  errors: unknown;
};

const listConnection = async ({
  token,
  plural,
  typeName,
  filter,
  orderBy,
  after,
  first = 200,
  fields = 'id',
}: {
  token: string;
  plural: string;
  typeName: string;
  filter?: object;
  orderBy?: object[];
  after?: string | null;
  first?: number;
  fields?: string;
}): Promise<Connection> => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritSurface(
          $filter: ${typeName}FilterInput
          $orderBy: [${typeName}OrderByInput]
          $after: String
        ) {
          ${plural}(filter: $filter, orderBy: $orderBy, first: ${first}, after: $after) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              cursor
              node {
                ${fields}
              }
            }
          }
        }
      `,
      variables: { filter, orderBy, after },
    },
    token,
  );

  const connection = response.body.data?.[plural];

  return {
    nodes: (connection?.edges ?? []).map((edge: { node: Node }) => edge.node),
    cursors: (connection?.edges ?? []).map(
      (edge: { cursor: string }) => edge.cursor,
    ),
    totalCount: connection?.totalCount,
    hasNextPage: connection?.pageInfo?.hasNextPage,
    endCursor: connection?.pageInfo?.endCursor,
    errors: response.body.errors,
  };
};

// What the front's CSV export does (useLazyFetchAllRecords): pages of 200
// through find-many with the view's filter and sort, following endCursor
// until hasNextPage is false.
const exportAll = async (args: {
  token: string;
  plural: string;
  typeName: string;
  filter?: object;
  orderBy?: object[];
  fields?: string;
}) => {
  const rows: Node[] = [];
  let after: string | null = null;
  let totalCount: number | undefined;
  let pages = 0;

  for (;;) {
    const page: Connection = await listConnection({ ...args, after });

    expect(page.errors).toBeUndefined();

    totalCount ??= page.totalCount;
    rows.push(...page.nodes);
    pages++;

    if (page.hasNextPage !== true || pages >= 50) {
      break;
    }

    after = page.endCursor ?? null;
  }

  return { rows, totalCount, pages };
};

const encodeCursor = (data: object) =>
  Buffer.from(JSON.stringify(data)).toString('base64url');

const decodeCursor = (cursor: string) =>
  Buffer.from(cursor, 'base64').toString();

const searchIds = async ({
  token,
  searchInput,
  objects,
}: {
  token: string;
  searchInput: string;
  objects: string[];
}) => {
  const { data, errors } = await search({
    searchInput,
    includedObjectNameSingulars: objects,
    limit: 100,
    accessToken: token,
  });

  expect(errors).toBeUndefined();

  return data.search.edges.map((edge) => ({
    recordId: edge.node.recordId,
    objectNameSingular: edge.node.objectNameSingular,
    label: edge.node.label,
  }));
};

jest.setTimeout(120000);

describe('spirit owner row access: search, sort, filter and export', () => {
  let records: SpiritOwnerRecords;
  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  const bodyToken = `spiritbody${randomUUID().slice(0, 8)}`;
  const companyA2Id = randomUUID();
  const personOfA2Id = randomUUID();
  const companyDeletedOfBobId = randomUUID();
  const companyDeletedOfAliceId = randomUUID();
  const noteOfA = randomUUID();
  const noteOfB = randomUUID();
  const taskOfA = randomUUID();
  const taskOfB = randomUUID();
  const attachmentOfA = randomUUID();
  const attachmentOfB = randomUUID();
  const opportunityOfA = randomUUID();
  const opportunityOfB = randomUUID();

  let companyA2Name: string;
  let noteOfATitle: string;
  let noteOfBTitle: string;
  let taskOfBTitle: string;
  let attachmentOfBName: string;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());

    const { prefix } = records;

    // A second company of alice whose name sorts after B's
    companyA2Name = `${prefix} Z alice`;
    noteOfATitle = `${prefix} note of A`;
    noteOfBTitle = `${prefix} note of B`;
    taskOfBTitle = `${prefix} task of B`;
    attachmentOfBName = `${prefix} attachment of B`;

    const companies = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'company',
        objectMetadataPluralName: 'companies',
        gqlFields: 'id',
        data: [
          {
            id: companyA2Id,
            name: companyA2Name,
            accountOwnerId: ALICE_MEMBER_ID,
          },
          {
            id: companyDeletedOfBobId,
            name: `${prefix} D bob deleted`,
            accountOwnerId: BOB_MEMBER_ID,
          },
          {
            id: companyDeletedOfAliceId,
            name: `${prefix} E alice deleted`,
            accountOwnerId: ALICE_MEMBER_ID,
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(companies.body.errors).toBeUndefined();

    const people = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id',
        data: [
          {
            id: personOfA2Id,
            jobTitle: `${prefix} person of A2`,
            companyId: companyA2Id,
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(people.body.errors).toBeUndefined();

    const softDelete = await makeGraphqlAPIRequest(
      {
        query: gql`
          mutation SpiritSoftDelete($filter: CompanyFilterInput!) {
            deleteCompanies(filter: $filter) {
              id
            }
          }
        `,
        variables: {
          filter: {
            id: { in: [companyDeletedOfBobId, companyDeletedOfAliceId] },
          },
        },
      },
      ADMIN_TOKEN,
    );

    expect(softDelete.body.errors).toBeUndefined();

    const notes = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'note',
        objectMetadataPluralName: 'notes',
        gqlFields: 'id',
        data: [
          {
            id: noteOfA,
            title: noteOfATitle,
            bodyV2: { blocknote: null, markdown: `${bodyToken}a` },
          },
          {
            id: noteOfB,
            title: noteOfBTitle,
            bodyV2: { blocknote: null, markdown: `${bodyToken}b` },
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(notes.body.errors).toBeUndefined();

    const noteTargets = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'noteTarget',
        objectMetadataPluralName: 'noteTargets',
        gqlFields: 'id',
        data: [
          { noteId: noteOfA, targetCompanyId: records.companyAId },
          { noteId: noteOfB, targetCompanyId: records.companyBId },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(noteTargets.body.errors).toBeUndefined();

    // Assignees match the company owners, so the expectations hold under the
    // Company rule (tasks gated through their target) and under the Spirit
    // rules (tasks judged by assignee)
    const tasks = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'task',
        objectMetadataPluralName: 'tasks',
        gqlFields: 'id',
        data: [
          {
            id: taskOfA,
            title: `${prefix} task of A`,
            assigneeId: ALICE_MEMBER_ID,
            bodyV2: { blocknote: null, markdown: `${bodyToken}ta` },
          },
          {
            id: taskOfB,
            title: taskOfBTitle,
            assigneeId: BOB_MEMBER_ID,
            bodyV2: { blocknote: null, markdown: `${bodyToken}tb` },
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(tasks.body.errors).toBeUndefined();

    const taskTargets = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'taskTarget',
        objectMetadataPluralName: 'taskTargets',
        gqlFields: 'id',
        data: [
          { taskId: taskOfA, targetCompanyId: records.companyAId },
          { taskId: taskOfB, targetCompanyId: records.companyBId },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(taskTargets.body.errors).toBeUndefined();

    const attachments = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'attachment',
        objectMetadataPluralName: 'attachments',
        gqlFields: 'id',
        data: [
          {
            id: attachmentOfA,
            name: `${prefix} attachment of A`,
            targetCompanyId: records.companyAId,
          },
          {
            id: attachmentOfB,
            name: attachmentOfBName,
            targetCompanyId: records.companyBId,
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(attachments.body.errors).toBeUndefined();

    // alice owns no seeded opportunity; these give the Spirit-rules export
    // a row of hers to find (review M2)
    const opportunities = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'opportunity',
        objectMetadataPluralName: 'opportunities',
        gqlFields: 'id',
        data: [
          {
            id: opportunityOfA,
            name: `${prefix} opportunity of alice`,
            ownerId: ALICE_MEMBER_ID,
          },
          {
            id: opportunityOfB,
            name: `${prefix} opportunity of bob`,
            ownerId: BOB_MEMBER_ID,
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(opportunities.body.errors).toBeUndefined();

    // "Linked" timeline activities (note/task title as linkedRecordCachedName)
    // are written by the worker
    await waitForAllJobsToFinish();
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);

    for (const [singular, plural, ids] of [
      ['attachment', 'attachments', [attachmentOfA, attachmentOfB]],
      ['note', 'notes', [noteOfA, noteOfB]],
      ['task', 'tasks', [taskOfA, taskOfB]],
      ['opportunity', 'opportunities', [opportunityOfA, opportunityOfB]],
      ['person', 'people', [personOfA2Id]],
    ] as const) {
      await makeGraphqlAPIRequest(
        destroyManyOperationFactory({
          objectMetadataSingularName: singular,
          objectMetadataPluralName: plural,
          gqlFields: 'id',
          filter: { id: { in: [...ids] } },
        }),
        ADMIN_TOKEN,
      );
    }

    await makeGraphqlAPIRequest(
      destroyManyOperationFactory({
        objectMetadataSingularName: 'company',
        objectMetadataPluralName: 'companies',
        gqlFields: 'id',
        filter: {
          id: { in: [companyDeletedOfBobId, companyDeletedOfAliceId] },
          deletedAt: { is: 'NOT_NULL' },
        },
      }),
      ADMIN_TOKEN,
    );
    await destroyCompaniesByPrefix(records.prefix);
  });

  describe('1. search over notes, tasks, attachments and timeline activities', () => {
    const SEARCHED_OBJECTS = ['note', 'task', 'attachment', 'timelineActivity'];

    it('alice finds her own note, task and attachment by title, and nothing of B', async () => {
      const found = await searchIds({
        token: ALICE_TOKEN,
        searchInput: records.prefix,
        objects: SEARCHED_OBJECTS,
      });
      const ids = found.map((result) => result.recordId);
      const labels = found.map((result) => result.label).join('\n');

      expect(ids).toEqual(
        expect.arrayContaining([noteOfA, taskOfA, attachmentOfA]),
      );
      expect(ids).not.toContain(noteOfB);
      expect(ids).not.toContain(taskOfB);
      expect(ids).not.toContain(attachmentOfB);
      expect(labels).not.toContain(noteOfBTitle);
      expect(labels).not.toContain(taskOfBTitle);
      expect(labels).not.toContain(attachmentOfBName);
    });

    it('alice finds no linked timeline activity that names the note of B', async () => {
      const admin = await searchIds({
        token: ADMIN_TOKEN,
        searchInput: noteOfBTitle,
        objects: ['timelineActivity'],
      });
      const alice = await searchIds({
        token: ALICE_TOKEN,
        searchInput: noteOfBTitle,
        objects: ['timelineActivity'],
      });

      // Control for the index: the admin finds the activity that carries the
      // note title
      expect(
        admin.filter((result) => result.label.includes(noteOfBTitle)),
      ).not.toHaveLength(0);
      expect(
        alice.filter((result) => result.label.includes(noteOfBTitle)),
      ).toEqual([]);
    });

    it('alice finds a linked timeline activity that names the note of A', async () => {
      const alice = await searchIds({
        token: ALICE_TOKEN,
        searchInput: noteOfATitle,
        objects: ['timelineActivity'],
      });

      expect(
        alice.filter((result) => result.label.includes(noteOfATitle)),
      ).not.toHaveLength(0);
    });

    it('a body word of B finds nothing for alice; the body word of A finds her note and task', async () => {
      const aliceB = await searchIds({
        token: ALICE_TOKEN,
        searchInput: `${bodyToken}b`,
        objects: ['note', 'task'],
      });
      const aliceTaskB = await searchIds({
        token: ALICE_TOKEN,
        searchInput: `${bodyToken}tb`,
        objects: ['note', 'task'],
      });
      const aliceA = await searchIds({
        token: ALICE_TOKEN,
        searchInput: `${bodyToken}a`,
        objects: ['note', 'task'],
      });
      const aliceTaskA = await searchIds({
        token: ALICE_TOKEN,
        searchInput: `${bodyToken}ta`,
        objects: ['note', 'task'],
      });
      const adminB = await searchIds({
        token: ADMIN_TOKEN,
        searchInput: `${bodyToken}b`,
        objects: ['note', 'task'],
      });

      expect(adminB.map((result) => result.recordId)).toContain(noteOfB);
      expect(aliceB).toEqual([]);
      expect(aliceTaskB).toEqual([]);
      expect(aliceA.map((result) => result.recordId)).toContain(noteOfA);
      expect(aliceTaskA.map((result) => result.recordId)).toContain(taskOfA);
    });

    it('control: alice made see-all finds the note, task and attachment of B', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const found = await searchIds({
          token: ALICE_TOKEN,
          searchInput: records.prefix,
          objects: SEARCHED_OBJECTS,
        });
        const byBody = await searchIds({
          token: ALICE_TOKEN,
          searchInput: `${bodyToken}b`,
          objects: ['note', 'task'],
        });

        expect(found.map((result) => result.recordId)).toEqual(
          expect.arrayContaining([noteOfB, taskOfB, attachmentOfB]),
        );
        expect(byBody.map((result) => result.recordId)).toContain(noteOfB);
      });
    });
  });

  describe('2. sort and filter people across the company relation', () => {
    const peopleByCompanyName = (token: string, direction: string) =>
      listConnection({
        token,
        plural: 'people',
        typeName: 'Person',
        filter: { jobTitle: { like: `${records.prefix}%` } },
        orderBy: [{ company: { name: direction } }],
        fields: 'id',
      });

    it('sorted by company name, the person of B sorts with the empty companies for alice', async () => {
      const ascNullsLast = await peopleByCompanyName(
        ALICE_TOKEN,
        'AscNullsLast',
      );
      const ascNullsFirst = await peopleByCompanyName(
        ALICE_TOKEN,
        'AscNullsFirst',
      );

      expect(ascNullsLast.errors).toBeUndefined();
      expect(ascNullsLast.nodes.map((node) => node.id)).toEqual([
        records.personOfAId,
        personOfA2Id,
        records.personOfBId,
      ]);
      expect(ascNullsFirst.nodes.map((node) => node.id)).toEqual([
        records.personOfBId,
        records.personOfAId,
        personOfA2Id,
      ]);
    });

    it('control: for the admin and for alice made see-all, the person of B sorts between A and Z', async () => {
      const expected = [records.personOfAId, records.personOfBId, personOfA2Id];
      const admin = await peopleByCompanyName(ADMIN_TOKEN, 'AscNullsLast');

      expect(admin.nodes.map((node) => node.id)).toEqual(expected);

      await withAliceSeeAll(rowAccessApp, async () => {
        const alice = await peopleByCompanyName(ALICE_TOKEN, 'AscNullsLast');

        expect(alice.nodes.map((node) => node.id)).toEqual(expected);
      });
    });

    it('the cursor of the person of B does not carry the company name for alice', async () => {
      const alice = await peopleByCompanyName(ALICE_TOKEN, 'AscNullsLast');
      const admin = await peopleByCompanyName(ADMIN_TOKEN, 'AscNullsLast');

      const aliceCursorOfB =
        alice.cursors[
          alice.nodes.findIndex((node) => node.id === records.personOfBId)
        ];
      const adminCursorOfB =
        admin.cursors[
          admin.nodes.findIndex((node) => node.id === records.personOfBId)
        ];

      // Control: the cursor carries the sort value when the row is readable
      expect(decodeCursor(adminCursorOfB)).toContain(records.companyBName);
      expect(decodeCursor(aliceCursorOfB)).not.toContain(records.companyBName);
    });

    it('a crafted cursor at B name pages alice the same as a cursor just past it', async () => {
      const pageAfter = (token: string, name: string) =>
        listConnection({
          token,
          plural: 'people',
          typeName: 'Person',
          filter: { jobTitle: { like: `${records.prefix}%` } },
          orderBy: [{ company: { name: 'AscNullsLast' } }],
          after: encodeCursor({
            company: { name },
            id: '00000000-0000-0000-0000-000000000000',
          }),
        });

      const justPastB = `${records.companyBName}~`;

      const adminAtB = await pageAfter(ADMIN_TOKEN, records.companyBName);
      const adminPastB = await pageAfter(ADMIN_TOKEN, justPastB);
      const aliceAtB = await pageAfter(ALICE_TOKEN, records.companyBName);
      const alicePastB = await pageAfter(ALICE_TOKEN, justPastB);

      expect(adminAtB.errors).toBeUndefined();
      // Control: for a reader of B the two cursors differ by exactly B's row
      expect(adminAtB.nodes.map((node) => node.id)).toContain(
        records.personOfBId,
      );
      expect(adminPastB.nodes.map((node) => node.id)).not.toContain(
        records.personOfBId,
      );
      expect(aliceAtB.errors).toBeUndefined();
      expect(aliceAtB.nodes.map((node) => node.id)).toEqual(
        alicePastB.nodes.map((node) => node.id),
      );
    });

    it('a filter on a hidden company field gives alice the same people as a value that matches nothing', async () => {
      const nowhere = `${records.prefix} nowhere ${randomUUID()}`;
      const cases: [object, object][] = [
        [
          { company: { name: { eq: records.companyBName } } },
          { company: { name: { eq: nowhere } } },
        ],
        [
          { company: { name: { like: '%B bob%' } } },
          { company: { name: { like: `%${nowhere}%` } } },
        ],
        [
          { not: { company: { name: { eq: records.companyBName } } } },
          { not: { company: { name: { eq: nowhere } } } },
        ],
        [
          { company: { accountOwnerId: { eq: BOB_MEMBER_ID } } },
          { company: { accountOwnerId: { eq: randomUUID() } } },
        ],
      ];

      const peopleWith = async (token: string, companyFilter: object) => {
        const result = await listConnection({
          token,
          plural: 'people',
          typeName: 'Person',
          filter: {
            and: [{ jobTitle: { like: `${records.prefix}%` } }, companyFilter],
          },
        });

        expect(result.errors).toBeUndefined();

        return result.nodes.map((node) => node.id as string).sort();
      };

      for (const [hiddenValue, noValue] of cases) {
        // Control: the admin sees a difference for every case
        expect(await peopleWith(ADMIN_TOKEN, hiddenValue)).not.toEqual(
          await peopleWith(ADMIN_TOKEN, noValue),
        );
        expect(await peopleWith(ALICE_TOKEN, hiddenValue)).toEqual(
          await peopleWith(ALICE_TOKEN, noValue),
        );
      }
    });

    it('a filter on her own company name finds the person of A for alice', async () => {
      const result = await listConnection({
        token: ALICE_TOKEN,
        plural: 'people',
        typeName: 'Person',
        filter: { company: { name: { eq: records.companyAName } } },
      });

      expect(result.errors).toBeUndefined();
      expect(result.nodes.map((node) => node.id)).toEqual([
        records.personOfAId,
      ]);
    });
  });

  describe('3. export (PT-12): the front CSV export calls', () => {
    it('PT-12: alice exports all companies: exactly the companies she owns, in pages that add up to totalCount', async () => {
      const aliceExport = await exportAll({
        token: ALICE_TOKEN,
        plural: 'companies',
        typeName: 'Company',
        orderBy: [{ position: 'AscNullsFirst' }],
        fields: 'id name accountOwnerId',
      });
      // Expected value from the data: the companies the admin reads as owned
      // by alice
      const ownedByAlice = await exportAll({
        token: ADMIN_TOKEN,
        plural: 'companies',
        typeName: 'Company',
        filter: { accountOwnerId: { eq: ALICE_MEMBER_ID } },
        orderBy: [{ position: 'AscNullsFirst' }],
        fields: 'id',
      });

      const exportedIds = aliceExport.rows.map((row) => row.id as string);

      expect(aliceExport.rows).toHaveLength(aliceExport.totalCount as number);
      expect(exportedIds.sort()).toEqual(
        ownedByAlice.rows.map((row) => row.id as string).sort(),
      );
      expect(exportedIds).toEqual(
        expect.arrayContaining([records.companyAId, companyA2Id]),
      );
      expect(exportedIds).not.toContain(records.companyBId);
      expect(exportedIds).not.toContain(records.companyCId);
      expect(
        aliceExport.rows.every((row) => row.accountOwnerId === ALICE_MEMBER_ID),
      ).toBe(true);
    });

    it('PT-12: the people export with the company column shows no hidden company', async () => {
      const aliceExport = await exportAll({
        token: ALICE_TOKEN,
        plural: 'people',
        typeName: 'Person',
        filter: { jobTitle: { like: `${records.prefix}%` } },
        fields: 'id companyId company { id name accountOwnerId }',
      });

      const personOfB = aliceExport.rows.find(
        (row) => row.id === records.personOfBId,
      );
      const personOfA = aliceExport.rows.find(
        (row) => row.id === records.personOfAId,
      );

      expect(aliceExport.rows).toHaveLength(3);
      expect(personOfB?.company).toBeNull();
      expect((personOfA?.company as Node | null)?.name).toBe(
        records.companyAName,
      );
      expect(JSON.stringify(aliceExport.rows)).not.toContain(
        records.companyBName,
      );
    });

    it('PT-12: the notes and tasks exports with their targets show nothing of B', async () => {
      const notes = await exportAll({
        token: ALICE_TOKEN,
        plural: 'notes',
        typeName: 'Note',
        filter: { title: { like: `${records.prefix}%` } },
        fields:
          'id title noteTargets { edges { node { id targetCompany { id name } } } }',
      });
      const tasks = await exportAll({
        token: ALICE_TOKEN,
        plural: 'tasks',
        typeName: 'Task',
        filter: { title: { like: `${records.prefix}%` } },
        fields:
          'id title assignee { id } taskTargets { edges { node { id targetCompany { id name } } } }',
      });

      expect(notes.rows.map((row) => row.id)).toEqual([noteOfA]);
      expect(JSON.stringify(notes.rows)).toContain(records.companyAName);
      expect(tasks.rows.map((row) => row.id)).toEqual([taskOfA]);
      expect(JSON.stringify([notes.rows, tasks.rows])).not.toContain(
        records.companyBName,
      );
    });

    it('PT-12: the trash export and the single-record export (with soft-deleted) hide the deleted company of bob', async () => {
      const trash = await exportAll({
        token: ALICE_TOKEN,
        plural: 'companies',
        typeName: 'Company',
        filter: {
          and: [
            { name: { like: `${records.prefix}%` } },
            { deletedAt: { is: 'NOT_NULL' } },
          ],
        },
        fields: 'id',
      });

      const withSoftDeleted = (id: string) =>
        makeGraphqlAPIRequest(
          findOneOperationFactory({
            objectMetadataSingularName: 'company',
            gqlFields: 'id name',
            filter: {
              id: { eq: id },
              or: [
                { deletedAt: { is: 'NULL' } },
                { deletedAt: { is: 'NOT_NULL' } },
              ],
            },
          }),
          ALICE_TOKEN,
        );

      const deletedOfBob = await withSoftDeleted(companyDeletedOfBobId);
      const deletedOfAlice = await withSoftDeleted(companyDeletedOfAliceId);

      expect(trash.rows.map((row) => row.id)).toEqual([
        companyDeletedOfAliceId,
      ]);
      expect(deletedOfBob.body.data?.company ?? null).toBeNull();
      expect(JSON.stringify(deletedOfBob.body)).not.toContain('D bob deleted');
      expect(deletedOfAlice.body.errors).toBeUndefined();
      expect(deletedOfAlice.body.data.company.id).toBe(companyDeletedOfAliceId);
    });

    // Only with the real Spirit config (SPIRIT_ROW_ACCESS_TEST_RULES=spirit),
    // where opportunities and tasks carry their own rule
    (isSpiritRulesTestMode() ? it : it.skip)(
      'PT-12 (Spirit rules): the full opportunity and task exports are exactly the rows alice owns or is assigned',
      async () => {
        for (const [plural, typeName, ownerField, rowOfA, rowOfB] of [
          [
            'opportunities',
            'Opportunity',
            'ownerId',
            opportunityOfA,
            opportunityOfB,
          ],
          ['tasks', 'Task', 'assigneeId', taskOfA, taskOfB],
        ] as const) {
          const aliceExport = await exportAll({
            token: ALICE_TOKEN,
            plural,
            typeName,
            orderBy: [{ position: 'AscNullsFirst' }],
            fields: `id ${ownerField}`,
          });
          const ownedByAlice = await exportAll({
            token: ADMIN_TOKEN,
            plural,
            typeName,
            filter: { [ownerField]: { eq: ALICE_MEMBER_ID } },
            orderBy: [{ position: 'AscNullsFirst' }],
            fields: 'id',
          });
          const all = await exportAll({
            token: ADMIN_TOKEN,
            plural,
            typeName,
            orderBy: [{ position: 'AscNullsFirst' }],
            fields: 'id',
          });

          expect(aliceExport.rows).toHaveLength(
            aliceExport.totalCount as number,
          );
          expect(
            aliceExport.rows.map((row) => row.id as string).sort(),
          ).toEqual(ownedByAlice.rows.map((row) => row.id as string).sort());
          expect(aliceExport.rows.map((row) => row.id)).toContain(rowOfA);
          expect(aliceExport.rows.map((row) => row.id)).not.toContain(rowOfB);
          expect(all.rows.length).toBeGreaterThan(aliceExport.rows.length);

          await withAliceSeeAll(rowAccessApp, async () => {
            const seeAll = await exportAll({
              token: ALICE_TOKEN,
              plural,
              typeName,
              orderBy: [{ position: 'AscNullsFirst' }],
              fields: 'id',
            });

            expect(seeAll.rows).toHaveLength(all.rows.length);
          });
        }
      },
    );

    it('control: alice made see-all exports B, C, the deleted company of bob and the note of B', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const companies = await exportAll({
          token: ALICE_TOKEN,
          plural: 'companies',
          typeName: 'Company',
          filter: { name: { like: `${records.prefix}%` } },
          fields: 'id',
        });
        const trash = await exportAll({
          token: ALICE_TOKEN,
          plural: 'companies',
          typeName: 'Company',
          filter: {
            and: [
              { name: { like: `${records.prefix}%` } },
              { deletedAt: { is: 'NOT_NULL' } },
            ],
          },
          fields: 'id',
        });
        const people = await exportAll({
          token: ALICE_TOKEN,
          plural: 'people',
          typeName: 'Person',
          filter: { jobTitle: { like: `${records.prefix}%` } },
          fields: 'id company { id name }',
        });
        const notes = await exportAll({
          token: ALICE_TOKEN,
          plural: 'notes',
          typeName: 'Note',
          filter: { title: { like: `${records.prefix}%` } },
          fields: 'id',
        });

        expect(companies.rows.map((row) => row.id)).toEqual(
          expect.arrayContaining([records.companyBId, records.companyCId]),
        );
        expect(trash.rows.map((row) => row.id)).toContain(
          companyDeletedOfBobId,
        );
        expect(JSON.stringify(people.rows)).toContain(records.companyBName);
        expect(notes.rows.map((row) => row.id)).toContain(noteOfB);
      });
    });
  });
});
