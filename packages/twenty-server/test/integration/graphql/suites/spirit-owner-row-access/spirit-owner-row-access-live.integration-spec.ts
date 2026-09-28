import { randomUUID } from 'crypto';

import {
  ADMIN_TOKEN,
  ALICE_MEMBER_ID,
  BOB_MEMBER_ID,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  companyNameFilter,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  cleanupSpiritRowAccessApp,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import {
  ADMIN_STREAM_AUTH_CONTEXT,
  ALICE_STREAM_AUTH_CONTEXT,
  eventRecord,
  openLiveStream,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-live-stream.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Time left for a dropped event to show up after a later control event did.
const NEGATIVE_SETTLE_MS = 800;

const updateAsAdmin = async (
  objectMetadataSingularName: string,
  recordId: string,
  data: object,
) => {
  const response = await makeGraphqlAPIRequest(
    updateOneOperationFactory({
      objectMetadataSingularName,
      gqlFields: 'id',
      recordId,
      data,
    }),
    ADMIN_TOKEN,
  );

  expect(response.body.errors).toBeUndefined();
};

describe('spirit owner row access: live updates (PI-6)', () => {
  let records: SpiritOwnerRecords;
  const companyJaneId = randomUUID();
  const personOfJaneCompanyId = randomUUID();
  const noteOfBId = randomUUID();
  const noteOfAId = randomUUID();

  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());

    const companyResponse = await makeGraphqlAPIRequest(
      createOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id',
        data: {
          id: companyJaneId,
          name: `${records.prefix} D jane`,
          accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
        },
      }),
      ADMIN_TOKEN,
    );

    expect(companyResponse.body.errors).toBeUndefined();

    const personResponse = await makeGraphqlAPIRequest(
      createOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id',
        data: {
          id: personOfJaneCompanyId,
          jobTitle: `${records.prefix} person of D`,
          companyId: companyJaneId,
        },
      }),
      ADMIN_TOKEN,
    );

    expect(personResponse.body.errors).toBeUndefined();

    const noteResponse = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'note',
        objectMetadataPluralName: 'notes',
        gqlFields: 'id',
        data: [
          { id: noteOfBId, title: `${records.prefix} live note of B` },
          { id: noteOfAId, title: `${records.prefix} live note of A` },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(noteResponse.body.errors).toBeUndefined();

    await waitForAllJobsToFinish();
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await makeGraphqlAPIRequest(
      destroyManyOperationFactory({
        objectMetadataSingularName: 'note',
        objectMetadataPluralName: 'notes',
        gqlFields: 'id',
        filter: { id: { in: [noteOfBId, noteOfAId] } },
      }),
      ADMIN_TOKEN,
    );
    await destroyCompaniesByPrefix(records.prefix);
    await waitForAllJobsToFinish();
  });

  it('PT-15: alice gets no event when B changes, and gets the event for A', async () => {
    const stream = await openLiveStream({
      authContext: ALICE_STREAM_AUTH_CONTEXT,
      queries: {
        companies: {
          objectNameSingular: 'company',
          variables: { filter: companyNameFilter(records.prefix) },
        },
      },
    });

    try {
      await updateAsAdmin('company', records.companyBId, {
        name: `${records.companyBName} v2`,
      });
      await updateAsAdmin('company', records.companyCId, {
        name: `${records.companyCName} v2`,
      });
      await updateAsAdmin('company', records.companyAId, {
        name: `${records.companyAName} v2`,
      });

      const eventForA = await stream.waitFor(
        (received) => received.event.recordId === records.companyAId,
      );

      expect(eventForA?.event.action).toBe('updated');

      await sleep(NEGATIVE_SETTLE_MS);

      expect(
        stream.received
          .map((received) => received.event.recordId)
          .filter((recordId) => recordId !== records.companyAId),
      ).toEqual([]);
    } finally {
      await stream.close();
      await updateAsAdmin('company', records.companyAId, {
        name: records.companyAName,
      });
    }
  });

  it('PT-15 control: the admin stream does get the event for B', async () => {
    const stream = await openLiveStream({
      authContext: ADMIN_STREAM_AUTH_CONTEXT,
      queries: {
        companies: {
          objectNameSingular: 'company',
          variables: { filter: companyNameFilter(records.prefix) },
        },
      },
    });

    try {
      await updateAsAdmin('company', records.companyBId, {
        name: `${records.companyBName} v3`,
      });

      const eventForB = await stream.waitFor(
        (received) => received.event.recordId === records.companyBId,
      );

      expect(eventForB?.event.action).toBe('updated');
    } finally {
      await stream.close();
    }
  });

  it('PT-15b: moving A to bob sends alice a remove that carries only the old state', async () => {
    const stream = await openLiveStream({
      authContext: ALICE_STREAM_AUTH_CONTEXT,
      queries: {
        companies: {
          objectNameSingular: 'company',
          variables: { filter: companyNameFilter(records.prefix) },
        },
      },
    });

    try {
      await updateAsAdmin('company', records.companyAId, {
        accountOwnerId: BOB_MEMBER_ID,
        name: `${records.prefix} A moved SECRETNAME`,
      });

      const removal = await stream.waitFor(
        (received) => received.event.recordId === records.companyAId,
      );

      expect(removal?.event.action).toBe('deleted');
      expect(removal?.queryIds).toEqual(['companies']);

      const before = eventRecord(removal!, 'before');
      const after = eventRecord(removal!, 'after');

      expect(before?.name).toBe(records.companyAName);
      expect(before?.accountOwnerId).toBe(ALICE_MEMBER_ID);
      expect(after?.name).toBe(records.companyAName);
      expect(after?.deletedAt).toEqual(expect.any(String));
      expect(JSON.stringify(removal)).not.toContain('SECRETNAME');
      expect(JSON.stringify(removal)).not.toContain(BOB_MEMBER_ID);

      await updateAsAdmin('company', records.companyAId, {
        accountOwnerId: ALICE_MEMBER_ID,
        name: records.companyAName,
      });

      const regained = await stream.waitFor(
        (received) =>
          received.event.recordId === records.companyAId &&
          received.event.action === 'updated',
      );

      expect(eventRecord(regained!, 'after')?.accountOwnerId).toBe(
        ALICE_MEMBER_ID,
      );
    } finally {
      await stream.close();
      await updateAsAdmin('company', records.companyAId, {
        accountOwnerId: ALICE_MEMBER_ID,
        name: records.companyAName,
      });
    }
  });

  it('nested enrichment runs as the subscriber, not as the writer', async () => {
    const stream = await openLiveStream({
      authContext: ALICE_STREAM_AUTH_CONTEXT,
      queries: {
        people: {
          objectNameSingular: 'person',
          variables: { filter: { jobTitle: { like: `${records.prefix}%` } } },
        },
      },
    });

    try {
      // The writer is Jane, who owns D. Enriched as the writer, alice would
      // get D's name and lose her own company A.
      await updateAsAdmin('person', personOfJaneCompanyId, {
        jobTitle: `${records.prefix} person of D v2`,
      });
      await updateAsAdmin('person', records.personOfAId, {
        jobTitle: `${records.prefix} person of A v2`,
      });

      const eventForPersonOfD = await stream.waitFor(
        (received) => received.event.recordId === personOfJaneCompanyId,
      );
      const eventForPersonOfA = await stream.waitFor(
        (received) => received.event.recordId === records.personOfAId,
      );

      expect(eventForPersonOfD).toBeDefined();
      expect(eventForPersonOfA).toBeDefined();

      expect(eventRecord(eventForPersonOfD!, 'after')?.company ?? null).toBe(
        null,
      );
      expect(JSON.stringify(eventForPersonOfD)).not.toContain('D jane');
      expect(
        (
          eventRecord(eventForPersonOfA!, 'after')?.company as
            | { id?: string }
            | null
            | undefined
        )?.id,
      ).toBe(records.companyAId);
    } finally {
      await stream.close();
    }
  });

  it('PT-15 child: a timeline activity of B does not reach alice; one of A does', async () => {
    const stream = await openLiveStream({
      authContext: ALICE_STREAM_AUTH_CONTEXT,
      queries: {
        activities: {
          objectNameSingular: 'timelineActivity',
          variables: {
            filter: {
              targetCompanyId: {
                in: [records.companyAId, records.companyBId],
              },
            },
          },
        },
      },
    });

    try {
      await updateAsAdmin('company', records.companyBId, {
        name: `${records.companyBName} v4`,
      });
      await waitForAllJobsToFinish();
      await updateAsAdmin('company', records.companyAId, {
        name: `${records.companyAName} v4`,
      });
      await waitForAllJobsToFinish();

      const activityOfA = await stream.waitFor(
        (received) =>
          eventRecord(received, 'after')?.targetCompanyId ===
          records.companyAId,
      );

      expect(activityOfA).toBeDefined();

      await sleep(NEGATIVE_SETTLE_MS);

      expect(
        stream.received.filter(
          (received) =>
            eventRecord(received, 'after')?.targetCompanyId ===
            records.companyBId,
        ),
      ).toEqual([]);
    } finally {
      await stream.close();
      await updateAsAdmin('company', records.companyAId, {
        name: records.companyAName,
      });
    }
  });

  it('PT-15 child: a note target on B does not reach alice; one on A does', async () => {
    const stream = await openLiveStream({
      authContext: ALICE_STREAM_AUTH_CONTEXT,
      queries: {
        noteTargets: {
          objectNameSingular: 'noteTarget',
          variables: { filter: { noteId: { in: [noteOfBId, noteOfAId] } } },
        },
      },
    });

    try {
      const response = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'noteTarget',
          objectMetadataPluralName: 'noteTargets',
          gqlFields: 'id',
          data: [{ noteId: noteOfBId, targetCompanyId: records.companyBId }],
        }),
        ADMIN_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();

      const controlResponse = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'noteTarget',
          objectMetadataPluralName: 'noteTargets',
          gqlFields: 'id',
          data: [{ noteId: noteOfAId, targetCompanyId: records.companyAId }],
        }),
        ADMIN_TOKEN,
      );

      expect(controlResponse.body.errors).toBeUndefined();

      const targetOfA = await stream.waitFor(
        (received) =>
          eventRecord(received, 'after')?.targetCompanyId ===
          records.companyAId,
      );

      expect(targetOfA).toBeDefined();

      await sleep(NEGATIVE_SETTLE_MS);

      expect(
        stream.received.filter(
          (received) => eventRecord(received, 'after')?.noteId === noteOfBId,
        ),
      ).toEqual([]);
    } finally {
      await stream.close();
    }
  });

  // D36: the same streams deliver the dropped events once the config makes
  // alice see-all, so the drops above come from the rule.
  describe('control: alice made see-all through the config', () => {
    it('PT-15: alice gets the event for B', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const stream = await openLiveStream({
          authContext: ALICE_STREAM_AUTH_CONTEXT,
          queries: {
            companies: {
              objectNameSingular: 'company',
              variables: { filter: companyNameFilter(records.prefix) },
            },
          },
        });

        try {
          await updateAsAdmin('company', records.companyBId, {
            name: `${records.companyBName} v5`,
          });

          const eventForB = await stream.waitFor(
            (received) => received.event.recordId === records.companyBId,
          );

          expect(eventForB?.event.action).toBe('updated');
        } finally {
          await stream.close();
        }
      });
    });

    it('enrichment as the subscriber: alice gets the company name of D once she may read D', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const stream = await openLiveStream({
          authContext: ALICE_STREAM_AUTH_CONTEXT,
          queries: {
            people: {
              objectNameSingular: 'person',
              variables: {
                filter: { jobTitle: { like: `${records.prefix}%` } },
              },
            },
          },
        });

        try {
          await updateAsAdmin('person', personOfJaneCompanyId, {
            jobTitle: `${records.prefix} person of D v3`,
          });

          const eventForPersonOfD = await stream.waitFor(
            (received) => received.event.recordId === personOfJaneCompanyId,
          );

          expect(
            (
              eventRecord(eventForPersonOfD!, 'after')?.company as
                | { name?: string }
                | null
                | undefined
            )?.name,
          ).toBe(`${records.prefix} D jane`);
        } finally {
          await stream.close();
        }
      });
    });

    it('PT-15 child: a timeline activity of B and a new note target on B reach alice', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const stream = await openLiveStream({
          authContext: ALICE_STREAM_AUTH_CONTEXT,
          queries: {
            activities: {
              objectNameSingular: 'timelineActivity',
              variables: {
                filter: { targetCompanyId: { eq: records.companyBId } },
              },
            },
            noteTargets: {
              objectNameSingular: 'noteTarget',
              variables: {
                filter: { targetCompanyId: { eq: records.companyBId } },
              },
            },
          },
        });

        try {
          await updateAsAdmin('company', records.companyBId, {
            name: `${records.companyBName} v6`,
          });
          await waitForAllJobsToFinish();

          const response = await makeGraphqlAPIRequest(
            createManyOperationFactory({
              objectMetadataSingularName: 'noteTarget',
              objectMetadataPluralName: 'noteTargets',
              gqlFields: 'id',
              // The earlier child test already linked the note of B to B
              data: [
                { noteId: noteOfAId, targetCompanyId: records.companyBId },
              ],
            }),
            ADMIN_TOKEN,
          );

          expect(response.body.errors).toBeUndefined();

          const activityOfB = await stream.waitFor(
            (received) =>
              eventRecord(received, 'after')?.targetCompanyId ===
              records.companyBId,
          );
          const targetOfB = await stream.waitFor(
            (received) =>
              received.queryIds.includes('noteTargets') &&
              eventRecord(received, 'after')?.noteId === noteOfAId,
          );

          expect(activityOfB).toBeDefined();
          expect(targetOfB).toBeDefined();
        } finally {
          await stream.close();
        }
      });
    });
  });
});
