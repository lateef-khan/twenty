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
  setupSpiritRowAccessApp,
  withAliceSeeAll,
  withRulesOff,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

type Edge<TNode> = { node: TNode };

const listIds = async ({
  token,
  plural,
  filterType,
  filter,
  fields = 'id',
  first = 200,
}: {
  token: string;
  plural: string;
  filterType: string;
  filter: object;
  fields?: string;
  first?: number;
}): Promise<{ nodes: Record<string, unknown>[]; errors: unknown }> => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritChildren($filter: ${filterType}) {
          ${plural}(filter: $filter, first: ${first}) {
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

  return {
    nodes: (response.body.data?.[plural]?.edges ?? []).map(
      (edge: Edge<Record<string, unknown>>) => edge.node,
    ),
    errors: response.body.errors,
  };
};

const companyIdsVisibleTo = async (
  token: string,
  companyIds: string[],
): Promise<string[]> => {
  const { nodes, errors } = await listIds({
    token,
    plural: 'companies',
    filterType: 'CompanyFilterInput',
    filter: { id: { in: companyIds } },
    first: 1000,
  });

  expect(errors).toBeUndefined();

  return nodes.map((node) => node.id as string);
};

describe('spirit owner row access: child and system objects (PI-8)', () => {
  let records: SpiritOwnerRecords;
  const noteOfA = randomUUID();
  const noteOfB = randomUUID();
  const noteOfAAndB = randomUUID();
  const noteWithNoTarget = randomUUID();
  const noteOfPersonOfB = randomUUID();
  const taskOfA = randomUUID();
  const taskOfB = randomUUID();
  const noteTargetOfB = randomUUID();
  const noteIds = [
    noteOfA,
    noteOfB,
    noteOfAAndB,
    noteWithNoTarget,
    noteOfPersonOfB,
  ];

  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());

    const notesResponse = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'note',
        objectMetadataPluralName: 'notes',
        gqlFields: 'id',
        data: noteIds.map((id) => ({
          id,
          title: `${records.prefix} note ${id.slice(0, 4)}`,
        })),
      }),
      ADMIN_TOKEN,
    );

    expect(notesResponse.body.errors).toBeUndefined();

    const noteTargetsResponse = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'noteTarget',
        objectMetadataPluralName: 'noteTargets',
        gqlFields: 'id',
        data: [
          { noteId: noteOfA, targetCompanyId: records.companyAId },
          {
            id: noteTargetOfB,
            noteId: noteOfB,
            targetCompanyId: records.companyBId,
          },
          { noteId: noteOfAAndB, targetCompanyId: records.companyAId },
          { noteId: noteOfAAndB, targetCompanyId: records.companyBId },
          { noteId: noteOfPersonOfB, targetPersonId: records.personOfBId },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(noteTargetsResponse.body.errors).toBeUndefined();

    const tasksResponse = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'task',
        objectMetadataPluralName: 'tasks',
        gqlFields: 'id',
        // Assignees match the company owners, so the task expectations hold
        // under the Company rule (tasks follow their target) and under the
        // Spirit rules (tasks judged by assignee)
        data: [
          {
            id: taskOfA,
            title: `${records.prefix} task of A`,
            assigneeId: ALICE_MEMBER_ID,
          },
          {
            id: taskOfB,
            title: `${records.prefix} task of B`,
            assigneeId: BOB_MEMBER_ID,
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(tasksResponse.body.errors).toBeUndefined();

    const taskTargetsResponse = await makeGraphqlAPIRequest(
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

    expect(taskTargetsResponse.body.errors).toBeUndefined();

    // Timeline activities for the creations above are written by the worker
    await waitForAllJobsToFinish();
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await makeGraphqlAPIRequest(
      destroyManyOperationFactory({
        objectMetadataSingularName: 'note',
        objectMetadataPluralName: 'notes',
        gqlFields: 'id',
        filter: { id: { in: noteIds } },
      }),
      ADMIN_TOKEN,
    );
    await makeGraphqlAPIRequest(
      destroyManyOperationFactory({
        objectMetadataSingularName: 'task',
        objectMetadataPluralName: 'tasks',
        gqlFields: 'id',
        filter: { id: { in: [taskOfA, taskOfB] } },
      }),
      ADMIN_TOKEN,
    );
    await destroyCompaniesByPrefix(records.prefix);
    await waitForAllJobsToFinish();
  });

  it('PT-14: alice reads the note targets of A only', async () => {
    const alice = await listIds({
      token: ALICE_TOKEN,
      plural: 'noteTargets',
      filterType: 'NoteTargetFilterInput',
      filter: {
        targetCompanyId: { in: [records.companyAId, records.companyBId] },
      },
      fields: 'id noteId targetCompanyId',
    });
    const admin = await listIds({
      token: ADMIN_TOKEN,
      plural: 'noteTargets',
      filterType: 'NoteTargetFilterInput',
      filter: {
        targetCompanyId: { in: [records.companyAId, records.companyBId] },
      },
      fields: 'id noteId targetCompanyId',
    });

    expect(alice.errors).toBeUndefined();
    expect(admin.errors).toBeUndefined();
    expect(admin.nodes).toHaveLength(4);
    // The A target of the note on A and B is hidden too: its note has a
    // hidden parent (every-parent rule)
    expect(alice.nodes.map((node) => node.noteId)).toEqual([noteOfA]);
  });

  it('PT-14: notes follow their targets (every target must be visible)', async () => {
    const alice = await listIds({
      token: ALICE_TOKEN,
      plural: 'notes',
      filterType: 'NoteFilterInput',
      filter: { id: { in: noteIds } },
    });
    const admin = await listIds({
      token: ADMIN_TOKEN,
      plural: 'notes',
      filterType: 'NoteFilterInput',
      filter: { id: { in: noteIds } },
    });

    expect(alice.errors).toBeUndefined();
    expect(admin.nodes).toHaveLength(noteIds.length);
    expect(alice.nodes.map((node) => node.id).sort()).toEqual(
      [noteOfA, noteWithNoTarget, noteOfPersonOfB].sort(),
    );
  });

  it('PT-14: tasks and task targets of B are hidden from alice', async () => {
    const tasks = await listIds({
      token: ALICE_TOKEN,
      plural: 'tasks',
      filterType: 'TaskFilterInput',
      filter: { id: { in: [taskOfA, taskOfB] } },
    });
    const taskTargets = await listIds({
      token: ALICE_TOKEN,
      plural: 'taskTargets',
      filterType: 'TaskTargetFilterInput',
      filter: { taskId: { in: [taskOfA, taskOfB] } },
      fields: 'id taskId',
    });

    expect(tasks.errors).toBeUndefined();
    expect(tasks.nodes.map((node) => node.id)).toEqual([taskOfA]);
    expect(taskTargets.nodes.map((node) => node.taskId)).toEqual([taskOfA]);
  });

  it('PT-14: timeline activities of B are hidden from alice, A stays', async () => {
    const filter = {
      targetCompanyId: { in: [records.companyAId, records.companyBId] },
    };
    const alice = await listIds({
      token: ALICE_TOKEN,
      plural: 'timelineActivities',
      filterType: 'TimelineActivityFilterInput',
      filter,
      fields: 'id name targetCompanyId',
    });
    const admin = await listIds({
      token: ADMIN_TOKEN,
      plural: 'timelineActivities',
      filterType: 'TimelineActivityFilterInput',
      filter,
      fields: 'id name targetCompanyId',
    });

    expect(alice.errors).toBeUndefined();
    expect(
      admin.nodes.filter((node) => node.targetCompanyId === records.companyBId)
        .length,
    ).toBeGreaterThan(0);
    expect(
      alice.nodes.filter((node) => node.targetCompanyId === records.companyAId)
        .length,
    ).toBeGreaterThan(0);
    expect(
      alice.nodes.filter((node) => node.targetCompanyId === records.companyBId),
    ).toEqual([]);
  });

  it('PT-14: a "linked" activity on visible A does not carry the hidden note on A and B', async () => {
    const admin = await listIds({
      token: ADMIN_TOKEN,
      plural: 'timelineActivities',
      filterType: 'TimelineActivityFilterInput',
      filter: { targetCompanyId: { eq: records.companyAId } },
      fields: 'id linkedRecordId linkedRecordCachedName',
    });
    const alice = await listIds({
      token: ALICE_TOKEN,
      plural: 'timelineActivities',
      filterType: 'TimelineActivityFilterInput',
      filter: { targetCompanyId: { eq: records.companyAId } },
      fields: 'id linkedRecordId linkedRecordCachedName',
    });

    expect(alice.errors).toBeUndefined();
    expect(admin.nodes.map((node) => node.linkedRecordId)).toContain(
      noteOfAAndB,
    );
    expect(alice.nodes.map((node) => node.linkedRecordId)).toContain(noteOfA);
    expect(alice.nodes.map((node) => node.linkedRecordId)).not.toContain(
      noteOfAAndB,
    );
  });

  it('PT-14: the design example — every company activity alice reads points at a company she can read', async () => {
    const alice = await listIds({
      token: ALICE_TOKEN,
      plural: 'timelineActivities',
      filterType: 'TimelineActivityFilterInput',
      filter: { targetCompanyId: { is: 'NOT_NULL' } },
      fields: 'id targetCompanyId',
      first: 500,
    });
    const admin = await listIds({
      token: ADMIN_TOKEN,
      plural: 'timelineActivities',
      filterType: 'TimelineActivityFilterInput',
      filter: { targetCompanyId: { is: 'NOT_NULL' } },
      fields: 'id targetCompanyId',
      first: 500,
    });

    const aliceTargets = [
      ...new Set(alice.nodes.map((node) => node.targetCompanyId as string)),
    ];
    const adminTargets = [
      ...new Set(admin.nodes.map((node) => node.targetCompanyId as string)),
    ];

    expect(alice.errors).toBeUndefined();
    expect(
      (await companyIdsVisibleTo(ALICE_TOKEN, adminTargets)).length,
    ).toBeLessThan(adminTargets.length);
    expect(
      (await companyIdsVisibleTo(ALICE_TOKEN, aliceTargets)).sort(),
    ).toEqual(aliceTargets.sort());
  });

  it('PT-14: every seeded company attachment alice reads points at a company she can read', async () => {
    const alice = await listIds({
      token: ALICE_TOKEN,
      plural: 'attachments',
      filterType: 'AttachmentFilterInput',
      filter: { targetCompanyId: { is: 'NOT_NULL' } },
      fields: 'id targetCompanyId',
      first: 500,
    });
    const admin = await listIds({
      token: ADMIN_TOKEN,
      plural: 'attachments',
      filterType: 'AttachmentFilterInput',
      filter: { targetCompanyId: { is: 'NOT_NULL' } },
      fields: 'id targetCompanyId',
      first: 500,
    });

    const aliceTargets = [
      ...new Set(alice.nodes.map((node) => node.targetCompanyId as string)),
    ];

    expect(alice.errors).toBeUndefined();
    expect(alice.nodes.length).toBeGreaterThan(0);
    expect(alice.nodes.length).toBeLessThan(admin.nodes.length);
    expect(
      (await companyIdsVisibleTo(ALICE_TOKEN, aliceTargets)).sort(),
    ).toEqual(aliceTargets.sort());
  });

  it('PT-14: nested note targets on A hide the note that is also on B', async () => {
    const response = await makeGraphqlAPIRequest(
      {
        query: gql`
          query SpiritNestedNoteTargets($id: UUID!) {
            company(filter: { id: { eq: $id } }) {
              id
              noteTargets {
                edges {
                  node {
                    noteId
                    note {
                      id
                      title
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { id: records.companyAId },
      },
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(
      response.body.data.company.noteTargets.edges.map(
        (edge: Edge<{ noteId: string }>) => edge.node.noteId,
      ),
    ).toEqual([noteOfA]);
  });

  it('PT-14: alice cannot update a note of B or destroy the note target of B', async () => {
    const updateResponse = await makeGraphqlAPIRequest(
      updateOneOperationFactory({
        objectMetadataSingularName: 'note',
        gqlFields: 'id',
        recordId: noteOfB,
        data: { title: `${records.prefix} hijacked` },
      }),
      ALICE_TOKEN,
    );

    expect(updateResponse.body.data?.updateNote ?? null).toBeNull();
    expect(updateResponse.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');

    await makeGraphqlAPIRequest(
      destroyManyOperationFactory({
        objectMetadataSingularName: 'noteTarget',
        objectMetadataPluralName: 'noteTargets',
        gqlFields: 'id',
        filter: { id: { eq: noteTargetOfB } },
      }),
      ALICE_TOKEN,
    );

    const stillThere = await listIds({
      token: ADMIN_TOKEN,
      plural: 'noteTargets',
      filterType: 'NoteTargetFilterInput',
      filter: { id: { eq: noteTargetOfB } },
    });

    expect(stillThere.nodes).toHaveLength(1);
  });

  it('D18: a note alice attaches to hidden B by id is hidden from her', async () => {
    const aliceNoteId = randomUUID();

    const noteResponse = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'note',
        objectMetadataPluralName: 'notes',
        gqlFields: 'id',
        data: [{ id: aliceNoteId, title: `${records.prefix} alice note` }],
      }),
      ALICE_TOKEN,
    );

    expect(noteResponse.body.errors).toBeUndefined();

    try {
      const targetResponse = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'noteTarget',
          objectMetadataPluralName: 'noteTargets',
          gqlFields: 'id',
          data: [{ noteId: aliceNoteId, targetCompanyId: records.companyBId }],
        }),
        ALICE_TOKEN,
      );

      expect(targetResponse.body.errors).toBeUndefined();

      const asAdmin = await listIds({
        token: ADMIN_TOKEN,
        plural: 'noteTargets',
        filterType: 'NoteTargetFilterInput',
        filter: { noteId: { eq: aliceNoteId } },
        fields: 'id targetCompanyId',
      });

      expect(asAdmin.nodes.map((node) => node.targetCompanyId)).toEqual([
        records.companyBId,
      ]);

      // Her own note is now hidden from her (it has a hidden parent)
      const asAlice = await listIds({
        token: ALICE_TOKEN,
        plural: 'notes',
        filterType: 'NoteFilterInput',
        filter: { id: { eq: aliceNoteId } },
      });

      expect(asAlice.nodes).toEqual([]);
    } finally {
      await makeGraphqlAPIRequest(
        destroyManyOperationFactory({
          objectMetadataSingularName: 'note',
          objectMetadataPluralName: 'notes',
          gqlFields: 'id',
          filter: { id: { eq: aliceNoteId } },
        }),
        ADMIN_TOKEN,
      );
    }
  });

  // Upstream does not stop a Member without WORKFLOWS from reading runs: once
  // the config makes alice see-all she reads them. The empty list comes from
  // our workflowRun gate (D17).
  it('PT-26: alice reads no workflow runs; admin reads them; alice made see-all reads them', async () => {
    const alice = await listIds({
      token: ALICE_TOKEN,
      plural: 'workflowRuns',
      filterType: 'WorkflowRunFilterInput',
      filter: {},
      fields: 'id name',
      first: 20,
    });
    const admin = await listIds({
      token: ADMIN_TOKEN,
      plural: 'workflowRuns',
      filterType: 'WorkflowRunFilterInput',
      filter: {},
      fields: 'id name',
      first: 20,
    });

    expect(alice.errors).toBeUndefined();
    expect(admin.nodes.length).toBeGreaterThan(0);
    expect(alice.nodes).toEqual([]);

    const aliceSeeAll = await withAliceSeeAll(rowAccessApp, () =>
      listIds({
        token: ALICE_TOKEN,
        plural: 'workflowRuns',
        filterType: 'WorkflowRunFilterInput',
        filter: {},
        fields: 'id',
        first: 20,
      }),
    );

    expect(aliceSeeAll.errors).toBeUndefined();
    expect(aliceSeeAll.nodes.length).toBeGreaterThan(0);
  });

  // D36: with alice made see-all, or with every rule off, the same reads
  // return the rows hidden above.
  describe('control: the rows come back when the config allows them', () => {
    const readAll = async () => ({
      noteTargets: await listIds({
        token: ALICE_TOKEN,
        plural: 'noteTargets',
        filterType: 'NoteTargetFilterInput',
        filter: {
          targetCompanyId: { in: [records.companyAId, records.companyBId] },
        },
        fields: 'id noteId',
      }),
      notes: await listIds({
        token: ALICE_TOKEN,
        plural: 'notes',
        filterType: 'NoteFilterInput',
        filter: { id: { in: noteIds } },
      }),
      tasks: await listIds({
        token: ALICE_TOKEN,
        plural: 'tasks',
        filterType: 'TaskFilterInput',
        filter: { id: { in: [taskOfA, taskOfB] } },
      }),
      taskTargets: await listIds({
        token: ALICE_TOKEN,
        plural: 'taskTargets',
        filterType: 'TaskTargetFilterInput',
        filter: { taskId: { in: [taskOfA, taskOfB] } },
        fields: 'id taskId',
      }),
      activitiesOfB: await listIds({
        token: ALICE_TOKEN,
        plural: 'timelineActivities',
        filterType: 'TimelineActivityFilterInput',
        filter: { targetCompanyId: { eq: records.companyBId } },
      }),
      linkedOnA: await listIds({
        token: ALICE_TOKEN,
        plural: 'timelineActivities',
        filterType: 'TimelineActivityFilterInput',
        filter: { targetCompanyId: { eq: records.companyAId } },
        fields: 'id linkedRecordId',
      }),
    });

    const expectEverythingVisible = (
      visible: Awaited<ReturnType<typeof readAll>>,
    ) => {
      expect(visible.noteTargets.errors).toBeUndefined();
      expect(visible.noteTargets.nodes).toHaveLength(4);
      expect(visible.notes.nodes).toHaveLength(noteIds.length);
      expect(visible.tasks.nodes.map((node) => node.id).sort()).toEqual(
        [taskOfA, taskOfB].sort(),
      );
      expect(visible.taskTargets.nodes).toHaveLength(2);
      expect(visible.activitiesOfB.nodes.length).toBeGreaterThan(0);
      expect(
        visible.linkedOnA.nodes.map((node) => node.linkedRecordId),
      ).toContain(noteOfAAndB);
    };

    it('alice made see-all reads every note, task, target and activity of B', async () => {
      expectEverythingVisible(await withAliceSeeAll(rowAccessApp, readAll));
    });

    it('with every rule off alice reads them too (the child rule follows the config)', async () => {
      expectEverythingVisible(await withRulesOff(rowAccessApp, readAll));
    });

    it('alice made see-all nests both notes of A and can update the note of B', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const nested = await makeGraphqlAPIRequest(
          {
            query: gql`
              query SpiritNestedNoteTargets($id: UUID!) {
                company(filter: { id: { eq: $id } }) {
                  noteTargets {
                    edges {
                      node {
                        noteId
                      }
                    }
                  }
                }
              }
            `,
            variables: { id: records.companyAId },
          },
          ALICE_TOKEN,
        );

        expect(
          nested.body.data.company.noteTargets.edges
            .map((edge: Edge<{ noteId: string }>) => edge.node.noteId)
            .sort(),
        ).toEqual([noteOfA, noteOfAAndB].sort());

        const update = await makeGraphqlAPIRequest(
          updateOneOperationFactory({
            objectMetadataSingularName: 'note',
            gqlFields: 'id',
            recordId: noteOfB,
            data: { title: `${records.prefix} note of B control` },
          }),
          ALICE_TOKEN,
        );

        expect(update.body.errors).toBeUndefined();
        expect(update.body.data.updateNote.id).toBe(noteOfB);
      });
    });
  });
});
