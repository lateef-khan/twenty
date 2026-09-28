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
  buildSpiritRulesConfig,
  cleanupSpiritRowAccessApp,
  loadSpiritRowAccessStateInServer,
  setRowAccessConfig,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { isDefined } from 'twenty-shared/utils';

import { type SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import { isSpiritGatedObject } from 'src/engine/twenty-orm/spirit-row-access/utils/build-spirit-visibility-condition.util';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

jest.setTimeout(300000);

// Design §9: the real Spirit config (Company by accountOwner, Opportunity by
// owner, Task by assignee).
describe('spirit owner row access: the real Spirit config', () => {
  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  // alice owns none of the seeded opportunities, so the absence checks need
  // rows of her own to be able to fail (review M2)
  const opportunityOfAlice = randomUUID();
  const opportunityOfBob = randomUUID();
  const taskOfAlice = randomUUID();
  const taskOfBob = randomUUID();

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    rowAccessApp.baseConfig = await buildSpiritRulesConfig();
    await setRowAccessConfig({
      applicationId: rowAccessApp.applicationId,
      config: rowAccessApp.baseConfig,
    });

    const opportunities = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'opportunity',
        objectMetadataPluralName: 'opportunities',
        gqlFields: 'id',
        data: [
          {
            id: opportunityOfAlice,
            name: 'SpiritOwner opportunity of alice',
            ownerId: ALICE_MEMBER_ID,
          },
          {
            id: opportunityOfBob,
            name: 'SpiritOwner opportunity of bob',
            ownerId: BOB_MEMBER_ID,
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(opportunities.body.errors).toBeUndefined();

    const tasks = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'task',
        objectMetadataPluralName: 'tasks',
        gqlFields: 'id',
        data: [
          {
            id: taskOfAlice,
            title: 'SpiritOwner task of alice',
            assigneeId: ALICE_MEMBER_ID,
          },
          {
            id: taskOfBob,
            title: 'SpiritOwner task of bob',
            assigneeId: BOB_MEMBER_ID,
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(tasks.body.errors).toBeUndefined();
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);

    for (const [singular, plural, ids] of [
      ['opportunity', 'opportunities', [opportunityOfAlice, opportunityOfBob]],
      ['task', 'tasks', [taskOfAlice, taskOfBob]],
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
  });

  const readIds = async (
    token: string,
    plural: 'opportunities' | 'tasks',
    ids: string[],
  ) => {
    const response = await makeGraphqlAPIRequest(
      {
        query: gql(
          `query SpiritOwnRows($ids: [UUID!]) { ${plural}(filter: { id: { in: $ids } }) { edges { node { id } } } }`,
        ),
        variables: { ids },
      },
      token,
    );

    expect(response.body.errors).toBeUndefined();

    return (response.body.data[plural].edges as { node: { id: string } }[])
      .map((edge) => edge.node.id)
      .sort();
  };

  it.each([
    ['opportunities', () => [opportunityOfAlice, opportunityOfBob]],
    ['tasks', () => [taskOfAlice, taskOfBob]],
  ] as const)(
    'alice reads her own row of %s and not the row of bob; the admin reads both',
    async (plural, idsOf) => {
      const [ofAlice, ofBob] = idsOf();

      expect(await readIds(ALICE_TOKEN, plural, [ofAlice, ofBob])).toEqual([
        ofAlice,
      ]);
      expect(await readIds(ADMIN_TOKEN, plural, [ofAlice, ofBob])).toEqual(
        [ofAlice, ofBob].sort(),
      );
    },
  );

  it('the config is valid and holds the three rules', async () => {
    const state = await loadSpiritRowAccessStateInServer();

    expect(state.configStatus).toBe('ok');
    expect(state.config?.rules).toHaveLength(3);
  });

  it('gated set: the Company set of §5.9 plus opportunity; person and mail/meeting threads stay open', async () => {
    const snapshot =
      await getAppProviderByClassName<SpiritRowAccessStateService>(
        'SpiritRowAccessStateService',
      ).loadSnapshot(SEED_APPLE_WORKSPACE_ID);

    if (!isDefined(snapshot)) {
      throw new Error('enforcement is off in the server process');
    }

    const context = {
      state: snapshot.state,
      caller: { kind: 'owner' as const, workspaceMemberId: ALICE_MEMBER_ID },
      flatObjectMetadataMaps: snapshot.flatObjectMetadataMaps,
      flatFieldMetadataMaps: snapshot.flatFieldMetadataMaps,
      objectIdByNameSingular: snapshot.objectIdByNameSingular,
      resolveTableExpression: () => '',
    };
    const gated = Object.values(
      snapshot.flatObjectMetadataMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .filter((object) => object.isActive !== false)
      .filter((object) =>
        isSpiritGatedObject({ context, flatObjectMetadata: object }),
      )
      .map((object) => object.nameSingular)
      .sort();

    expect(gated).toEqual(
      [
        'attachment',
        'calendarEventTarget',
        'company',
        'messageThreadTarget',
        'note',
        'noteTarget',
        'opportunity',
        'task',
        'taskTarget',
        'timelineActivity',
        'workflowRun',
      ].sort(),
    );
  });

  it('alice reads only her own opportunities and tasks; made see-all she reads what the admin reads', async () => {
    const readOwners = async (token: string) => {
      const response = await makeGraphqlAPIRequest(
        {
          query: gql`
            query SpiritOwners {
              opportunities(first: 200) {
                totalCount
                edges {
                  node {
                    ownerId
                  }
                }
              }
              tasks(first: 200) {
                totalCount
                edges {
                  node {
                    assigneeId
                  }
                }
              }
            }
          `,
        },
        token,
      );

      expect(response.body.errors).toBeUndefined();

      return response.body.data as {
        opportunities: {
          totalCount: number;
          edges: { node: { ownerId: string | null } }[];
        };
        tasks: {
          totalCount: number;
          edges: { node: { assigneeId: string | null } }[];
        };
      };
    };

    const asAlice = await readOwners(ALICE_TOKEN);
    const asAdmin = await readOwners(ADMIN_TOKEN);
    const asAliceSeeAll = await withAliceSeeAll(rowAccessApp, () =>
      readOwners(ALICE_TOKEN),
    );

    expect(asAlice.opportunities.totalCount).toBeGreaterThan(0);
    expect(
      asAlice.opportunities.edges.every(
        (edge) => edge.node.ownerId === ALICE_MEMBER_ID,
      ),
    ).toBe(true);
    expect(asAlice.tasks.totalCount).toBeGreaterThan(0);
    expect(
      asAlice.tasks.edges.every(
        (edge) => edge.node.assigneeId === ALICE_MEMBER_ID,
      ),
    ).toBe(true);
    expect(asAdmin.opportunities.totalCount).toBeGreaterThan(
      asAlice.opportunities.totalCount,
    );
    expect(asAdmin.tasks.totalCount).toBeGreaterThan(asAlice.tasks.totalCount);
    expect(asAliceSeeAll.opportunities.totalCount).toBe(
      asAdmin.opportunities.totalCount,
    );
    expect(asAliceSeeAll.tasks.totalCount).toBe(asAdmin.tasks.totalCount);
  });
});
