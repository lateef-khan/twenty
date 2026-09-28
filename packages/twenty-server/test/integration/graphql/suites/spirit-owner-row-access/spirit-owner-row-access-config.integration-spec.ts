import { randomUUID } from 'crypto';

import gql from 'graphql-tag';
import {
  ADMIN_TOKEN,
  ALICE_MEMBER_ID,
  ALICE_TOKEN,
  MANAGER_TOKEN,
  type ManagerRoleSetup,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  cleanupManagerRole,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
  listCompanyIds,
  setupManagerRole,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  ROW_ACCESS_SETTINGS_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  assertSpiritRowAccessEnforced,
  buildCompanyRuleConfig,
  installRowAccessApp,
  loadSpiritRowAccessStateInServer,
  setRowAccessConfig,
  uninstallRowAccessApp,
  updateRowAccessConfigVariable,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import {
  buildRowAccessTarballWithVersion,
  nextRowAccessAppVersion,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-tarball.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { uploadAppTarball } from 'test/integration/metadata/suites/application/utils/upload-app-tarball.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY } from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-row-access-application.constant';
import { type SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

jest.setTimeout(120000);

const findRuleIds = async (objectName: string, fieldName: string) => {
  const { objects } = await findManyObjectMetadata({
    expectToFail: false,
    input: { filter: {}, paging: { first: 1000 } },
    gqlFields: `
        id
        nameSingular
        fieldsList {
          id
          name
        }
      `,
  });

  const object = objects?.find(
    (candidate) => candidate.nameSingular === objectName,
  );
  const field = object?.fieldsList?.find(
    (candidate) => candidate.name === fieldName,
  );

  if (!isDefined(object) || !isDefined(field)) {
    throw new Error(`${objectName}.${fieldName} metadata not found`);
  }

  return { objectMetadataId: object.id, ownerFieldMetadataId: field.id };
};

const FRONT_COMPONENT_WITH_TOKEN = gql`
  query SpiritFrontComponentToken($id: UUID!) {
    frontComponent(id: $id) {
      applicationId
      applicationVariables
      applicationTokenPair {
        applicationAccessToken {
          token
        }
      }
    }
  }
`;

const SET_APP_KEY_VALUE = gql`
  mutation SpiritSetAppKeyValue($input: SetAppKeyValueInput!) {
    setAppKeyValue(input: $input) {
      key
      scope
    }
  }
`;

const sortIds = (ids: string[]) => [...ids].sort();

const findSettingsFrontComponentId = async (): Promise<string> => {
  const [row] = await globalThis.testDataSource.query(
    `SELECT id FROM core."frontComponent" WHERE "universalIdentifier" = $1`,
    [ROW_ACCESS_SETTINGS_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER],
  );

  if (!isDefined(row)) {
    throw new Error('Row access settings front component is not installed');
  }

  return row.id;
};

// What the settings page does first: any signed-in user gets an app token
// for the component's app, scoped to user role ∩ app role.
const openSettingsFrontComponent = async (userToken: string) => {
  const response = await makeMetadataAPIRequest(
    {
      query: FRONT_COMPONENT_WITH_TOKEN,
      variables: { id: await findSettingsFrontComponentId() },
    },
    userToken,
  );

  expect(response.body.errors).toBeUndefined();

  return {
    applicationVariables: response.body.data.frontComponent
      .applicationVariables as Record<string, string>,
    appToken: response.body.data.frontComponent.applicationTokenPair
      .applicationAccessToken.token as string,
  };
};

const waitFor = async <TValue>({
  read,
  isDone,
  timeoutMs,
}: {
  read: () => Promise<TValue>;
  isDone: (value: TValue) => boolean;
  timeoutMs: number;
}): Promise<{ value: TValue; elapsedMs: number }> => {
  const startedAt = Date.now();

  for (;;) {
    const value = await read();
    const elapsedMs = Date.now() - startedAt;

    if (isDone(value) || elapsedMs > timeoutMs) {
      return { value, elapsedMs };
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
};

// A second cache + loader built from the running app's own classes and
// dependencies, with their own local cache and 10 s memoizer: what a second
// server or the worker process holds. Only Redis is shared with the app.
const buildSecondProcessLoader = async () => {
  const workspaceCacheService =
    getAppProviderByClassName<WorkspaceCacheService>('WorkspaceCacheService');
  const stateService = getAppProviderByClassName<SpiritRowAccessStateService>(
    'SpiritRowAccessStateService',
  );
  const cacheDependencies = workspaceCacheService as unknown as Record<
    string,
    unknown
  >;
  const WorkspaceCacheServiceClass = workspaceCacheService.constructor as new (
    ...args: unknown[]
  ) => WorkspaceCacheService;
  // Metrics are not under test; every method is a no-op.
  const noopMetrics = new Proxy({}, { get: () => () => undefined });

  const secondCache = new WorkspaceCacheServiceClass(
    cacheDependencies.cacheStorage,
    cacheDependencies.coreDataSource,
    cacheDependencies.discoveryService,
    cacheDependencies.reflector,
    noopMetrics,
    cacheDependencies.twentyConfigService,
  );

  await secondCache.onModuleInit();

  const StateServiceClass = stateService.constructor as new (
    ...args: unknown[]
  ) => SpiritRowAccessStateService;

  return {
    loader: new StateServiceClass(
      secondCache,
      (stateService as unknown as Record<string, unknown>)
        .secretEncryptionService,
      (stateService as unknown as Record<string, unknown>).workspaceRepository,
    ),
    stop: () => secondCache.onModuleDestroy(),
  };
};

describe('spirit owner row access: config from the row-access app', () => {
  let records: SpiritOwnerRecords;
  let managerRole: ManagerRoleSetup | undefined;
  let applicationId: string;

  beforeAll(async () => {
    assertSpiritRowAccessEnforced();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());
    managerRole = await setupManagerRole();
    applicationId = await installRowAccessApp();
    await setRowAccessConfig({
      applicationId,
      config: await buildCompanyRuleConfig(),
    });
  });

  afterAll(async () => {
    await uninstallRowAccessApp();
    await cleanupManagerRole(managerRole);
    await destroyCompaniesByPrefix(records.prefix);
  });

  const expectAliceSeesAOnly = async () => {
    const { ids, errors } = await listCompanyIds({
      token: ALICE_TOKEN,
      prefix: records.prefix,
    });

    expect(errors).toBeUndefined();
    expect(ids).toEqual([records.companyAId]);
  };

  const allIds = () =>
    sortIds([records.companyAId, records.companyBId, records.companyCId]);

  describe('the read path', () => {
    it('the installed app starts with an empty, valid config (no rule) until the admin saves one', async () => {
      await uninstallRowAccessApp();
      applicationId = await installRowAccessApp();

      const state = await loadSpiritRowAccessStateInServer();

      expect(state.configStatus).toBe('ok');
      expect(state.config).toEqual({
        version: 1,
        rules: [],
        seeAllRoleIds: [],
      });

      const { ids } = await listCompanyIds({
        token: ALICE_TOKEN,
        prefix: records.prefix,
      });

      expect(sortIds(ids)).toEqual(allIds());

      await setRowAccessConfig({
        applicationId,
        config: await buildCompanyRuleConfig(),
      });
    });

    it('reads the saved JSON variable of the app found by universal identifier', async () => {
      const state = await loadSpiritRowAccessStateInServer();
      const expectedConfig = await buildCompanyRuleConfig();

      expect(state.configStatus).toBe('ok');
      expect(state.config).toEqual(expectedConfig);
      expect(state.adminRoleId).toBe(
        (await findOneRoleByLabel({ label: 'Admin' })).id,
      );
    });

    it('returns the same state object while nothing changed (decrypt and parse once)', async () => {
      const first = await loadSpiritRowAccessStateInServer();
      const second = await loadSpiritRowAccessStateInServer();

      expect(second).toBe(first);
    });

    it('PT-1 with the real config: alice lists A only', async () => {
      await expectAliceSeesAOnly();
    });
  });

  describe('PT-18: a config change reaches the server', () => {
    it('turning the Company rule off shows alice A, B and C on her next request, and on again hides them', async () => {
      const workspaceCacheService =
        getAppProviderByClassName<WorkspaceCacheService>(
          'WorkspaceCacheService',
        );
      const [hashBefore] = Object.values(
        await workspaceCacheService.getCacheHashes(SEED_APPLE_WORKSPACE_ID, [
          'applicationVariableMaps',
        ]),
      );

      await setRowAccessConfig({
        applicationId,
        config: await buildCompanyRuleConfig({ isEnabled: false }),
      });

      const off = await waitFor({
        read: () =>
          listCompanyIds({ token: ALICE_TOKEN, prefix: records.prefix }),
        isDone: ({ ids }) => ids.length === 3,
        timeoutMs: 15000,
      });

      const [hashAfter] = Object.values(
        await workspaceCacheService.getCacheHashes(SEED_APPLE_WORKSPACE_ID, [
          'applicationVariableMaps',
        ]),
      );

      expect(sortIds(off.value.ids)).toEqual(allIds());
      expect(off.elapsedMs).toBeLessThan(1000);
      // The cross-process signal: other processes compare their local hash
      // with this Redis hash.
      expect(hashAfter).toBeDefined();
      expect(hashAfter).not.toBe(hashBefore);

      await setRowAccessConfig({
        applicationId,
        config: await buildCompanyRuleConfig(),
      });

      await expectAliceSeesAOnly();
    });

    it('a second process (own local cache and memoizer, shared Redis) sees the change within about 10 s', async () => {
      const secondProcess = await buildSecondProcessLoader();

      try {
        const before = await secondProcess.loader.loadState(
          SEED_APPLE_WORKSPACE_ID,
        );

        expect(before?.config?.rules[0]?.isEnabled).toBe(true);

        await setRowAccessConfig({
          applicationId,
          config: await buildCompanyRuleConfig({ isEnabled: false }),
        });

        const seen = await waitFor({
          read: () => secondProcess.loader.loadState(SEED_APPLE_WORKSPACE_ID),
          isDone: (state) => state?.config?.rules[0]?.isEnabled === false,
          timeoutMs: 15000,
        });

        expect(seen.value?.config?.rules[0]?.isEnabled).toBe(false);
        // Memoizer TTL 10 s + 2 s (a real second process measured up to 9 986 ms)
        expect(seen.elapsedMs).toBeLessThan(12000);
      } finally {
        secondProcess.stop();
        await setRowAccessConfig({
          applicationId,
          config: await buildCompanyRuleConfig(),
        });
      }

      await expectAliceSeesAOnly();
    });
  });

  describe('PT-19: see-all roles', () => {
    it('adding the Manager role to see-all shows manager A, B and C; removing it hides them again', async () => {
      const before = await listCompanyIds({
        token: MANAGER_TOKEN,
        prefix: records.prefix,
      });

      expect(before.ids).toEqual([]);

      await setRowAccessConfig({
        applicationId,
        config: await buildCompanyRuleConfig({
          seeAllRoleIds: [managerRole!.managerRoleId],
        }),
      });

      const during = await listCompanyIds({
        token: MANAGER_TOKEN,
        prefix: records.prefix,
      });

      expect(sortIds(during.ids)).toEqual(allIds());
      await expectAliceSeesAOnly();

      await setRowAccessConfig({
        applicationId,
        config: await buildCompanyRuleConfig(),
      });

      const after = await listCompanyIds({
        token: MANAGER_TOKEN,
        prefix: records.prefix,
      });

      expect(after.ids).toEqual([]);
    });
  });

  describe('§5.1: a redeploy keeps the saved config', () => {
    it('upload the next patch version of the app and upgrade: the config value and the rule stay', async () => {
      const configBefore = (await loadSpiritRowAccessStateInServer()).config;
      const nextVersion = nextRowAccessAppVersion();

      const { data } = await uploadAppTarball({
        tarballBuffer: await buildRowAccessTarballWithVersion(nextVersion),
        expectToFail: false,
      });

      const upgradeResponse = await makeMetadataAPIRequest({
        query: gql`
          mutation SpiritUpgrade(
            $appRegistrationId: String!
            $targetVersion: String!
          ) {
            upgradeApplication(
              appRegistrationId: $appRegistrationId
              targetVersion: $targetVersion
            )
          }
        `,
        variables: {
          appRegistrationId: data?.uploadAppTarball.id,
          targetVersion: nextVersion,
        },
      });

      expect(upgradeResponse.body.errors).toBeUndefined();

      const [application] = await globalThis.testDataSource.query(
        `SELECT version FROM core."application" WHERE id = $1`,
        [applicationId],
      );

      expect(application.version).toBe(nextVersion);

      const stateAfter = await loadSpiritRowAccessStateInServer();

      expect(stateAfter.configStatus).toBe('ok');
      expect(stateAfter.config).toEqual(configBefore);
      await expectAliceSeesAOnly();
    });
  });

  describe('PT-20: members cannot edit the config', () => {
    it('alice updateOneApplicationVariable with her own token is rejected and changes nothing', async () => {
      const stateBefore = await loadSpiritRowAccessStateInServer();

      const response = await updateRowAccessConfigVariable({
        applicationId,
        value: JSON.stringify({ version: 1, rules: [], seeAllRoleIds: [] }),
        token: ALICE_TOKEN,
      });

      expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(await loadSpiritRowAccessStateInServer()).toBe(stateBefore);
      await expectAliceSeesAOnly();
    });

    it('alice through the app token (app role holds APPLICATIONS) is still rejected: user ∩ app', async () => {
      const { appToken } = await openSettingsFrontComponent(ALICE_TOKEN);

      const response = await updateRowAccessConfigVariable({
        applicationId,
        value: JSON.stringify({ version: 1, rules: [], seeAllRoleIds: [] }),
        token: appToken,
      });

      expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      await expectAliceSeesAOnly();
    });

    it('control: the admin through the same app token can save (what the settings page does)', async () => {
      const { appToken } = await openSettingsFrontComponent(ADMIN_TOKEN);

      const response = await updateRowAccessConfigVariable({
        applicationId,
        value: JSON.stringify(await buildCompanyRuleConfig()),
        token: appToken,
      });

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.updateOneApplicationVariable).toBe(true);
    });
  });

  describe('PT-21: the app key-value store has no effect on the rule', () => {
    it('alice writes the config key through a frontComponent token; the rule is unchanged', async () => {
      const { appToken } = await openSettingsFrontComponent(ALICE_TOKEN);
      const stateBefore = await loadSpiritRowAccessStateInServer();

      const response = await makeMetadataAPIRequest(
        {
          query: SET_APP_KEY_VALUE,
          variables: {
            input: {
              key: SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
              value: { version: 1, rules: [], seeAllRoleIds: [] },
            },
          },
        },
        appToken,
      );

      // The write itself succeeds: any member can write the store (§5.1).
      expect(response.body.errors).toBeUndefined();
      expect(await loadSpiritRowAccessStateInServer()).toBe(stateBefore);
      await expectAliceSeesAOnly();

      await globalThis.testDataSource.query(
        `DELETE FROM core."keyValuePair" WHERE "key" = $1`,
        [SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY],
      );
    });
  });

  describe('the settings page API calls (the UI itself is not run)', () => {
    it('as admin through the app token: objects, getRoles and findOneApplication all answer', async () => {
      const { appToken } = await openSettingsFrontComponent(ADMIN_TOKEN);

      const response = await makeMetadataAPIRequest(
        {
          query: gql`
            query SpiritRowAccessSettingsLoad($id: UUID!) {
              currentWorkspace {
                workspaceCustomApplicationId
              }
              findOneApplication(id: $id) {
                applicationVariables {
                  key
                  value
                }
              }
              getRoles {
                id
                label
              }
              objects(paging: { first: 1000 }, filter: {}) {
                edges {
                  node {
                    id
                    universalIdentifier
                    applicationId
                    nameSingular
                    isSystem
                    isActive
                    fieldsList {
                      id
                      name
                      type
                      isActive
                      relation {
                        type
                        targetObjectMetadata {
                          nameSingular
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: { id: applicationId },
        },
        appToken,
      );

      expect(response.body.errors).toBeUndefined();

      const company = response.body.data.objects.edges
        .map((edge: { node: { nameSingular: string } }) => edge.node)
        .find(
          (node: { nameSingular: string }) => node.nameSingular === 'company',
        );
      const accountOwner = company.fieldsList.find(
        (field: { name: string }) => field.name === 'accountOwner',
      );

      expect(accountOwner.relation).toEqual({
        type: 'MANY_TO_ONE',
        targetObjectMetadata: { nameSingular: 'workspaceMember' },
      });

      // The page knows the audited standard objects by universal identifier
      // and the workspace's own custom objects by the workspace custom
      // application (D32, D41).
      const nodes = response.body.data.objects.edges.map(
        (edge: {
          node: {
            nameSingular: string;
            universalIdentifier: string;
            applicationId: string;
          };
        }) => edge.node,
      );
      const applicationIdOf = (nameSingular: string) =>
        nodes.find(
          (node: { nameSingular: string }) =>
            node.nameSingular === nameSingular,
        )?.applicationId;

      expect(company.universalIdentifier).toBe(
        STANDARD_OBJECTS.company.universalIdentifier,
      );
      expect(applicationIdOf('person')).toBe(company.applicationId);
      expect(applicationIdOf('timelineActivity')).toBe(company.applicationId);
      expect(applicationIdOf('rocket')).toEqual(expect.any(String));
      expect(applicationIdOf('rocket')).not.toBe(company.applicationId);
      expect(
        response.body.data.currentWorkspace.workspaceCustomApplicationId,
      ).toBe(applicationIdOf('rocket'));
      expect(
        response.body.data.getRoles.map(
          (role: { label: string }) => role.label,
        ),
      ).toEqual(expect.arrayContaining(['Admin', 'Member', 'Manager']));
      expect(
        response.body.data.findOneApplication.applicationVariables,
      ).toEqual([
        {
          key: SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
          value: JSON.stringify(await buildCompanyRuleConfig()),
        },
      ]);
    });

    it('as alice through the app token: the page cannot load (getRoles and findOneApplication are refused)', async () => {
      const { appToken } = await openSettingsFrontComponent(ALICE_TOKEN);

      const response = await makeMetadataAPIRequest(
        {
          query: gql`
            query SpiritRowAccessSettingsLoadAsMember($id: UUID!) {
              findOneApplication(id: $id) {
                id
              }
            }
          `,
          variables: { id: applicationId },
        },
        appToken,
      );

      const rolesResponse = await makeMetadataAPIRequest(
        {
          query: gql`
            query SpiritRolesAsMember {
              getRoles {
                id
              }
            }
          `,
        },
        appToken,
      );

      expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(rolesResponse.body.errors?.[0]?.extensions?.code).toBe(
        'FORBIDDEN',
      );
    });
  });

  describe('PT-24: an app role does not widen a member', () => {
    let adminRoleId: string;
    let originalAppRoleId: string;

    beforeAll(async () => {
      adminRoleId = (await findOneRoleByLabel({ label: 'Admin' })).id;

      const [row] = await globalThis.testDataSource.query(
        `SELECT "defaultRoleId" FROM core."application" WHERE id = $1`,
        [applicationId],
      );

      originalAppRoleId = row.defaultRoleId;

      await globalThis.testDataSource.query(
        `UPDATE core."application" SET "defaultRoleId" = $1 WHERE id = $2`,
        [adminRoleId, applicationId],
      );
      await getAppProviderByClassName<WorkspaceCacheService>(
        'WorkspaceCacheService',
      ).invalidateAndRecompute(SEED_APPLE_WORKSPACE_ID, [
        'flatApplicationMaps',
      ]);
    });

    afterAll(async () => {
      await globalThis.testDataSource.query(
        `UPDATE core."application" SET "defaultRoleId" = $1 WHERE id = $2`,
        [originalAppRoleId, applicationId],
      );
      await getAppProviderByClassName<WorkspaceCacheService>(
        'WorkspaceCacheService',
      ).invalidateAndRecompute(SEED_APPLE_WORKSPACE_ID, [
        'flatApplicationMaps',
      ]);
    });

    it('alice through an app whose role is Admin lists A only; the admin through it lists A, B and C', async () => {
      const aliceApp = await openSettingsFrontComponent(ALICE_TOKEN);
      const adminApp = await openSettingsFrontComponent(ADMIN_TOKEN);

      const asAlice = await listCompanyIds({
        token: aliceApp.appToken,
        prefix: records.prefix,
      });
      const asAdmin = await listCompanyIds({
        token: adminApp.appToken,
        prefix: records.prefix,
      });

      expect(asAlice.errors).toBeUndefined();
      expect(asAlice.ids).toEqual([records.companyAId]);
      expect(sortIds(asAdmin.ids)).toEqual(allIds());
    });

    it('alice through the Admin-role app creates a company that she owns', async () => {
      const aliceApp = await openSettingsFrontComponent(ALICE_TOKEN);
      const companyId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        {
          query: gql`
            mutation SpiritCreateCompanyThroughApp($data: CompanyCreateInput!) {
              createCompany(data: $data) {
                id
                accountOwnerId
              }
            }
          `,
          variables: {
            data: {
              id: companyId,
              name: `${records.prefix} app-made`,
              accountOwnerId: null,
            },
          },
        },
        aliceApp.appToken,
      );

      await makeGraphqlAPIRequest(
        destroyOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: companyId,
        }),
        ADMIN_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.createCompany.accountOwnerId).toBe(
        ALICE_MEMBER_ID,
      );
    });
  });

  describe('PT-22 / PT-23: fail closed', () => {
    it('PT-23: bad JSON fails closed (unreadable): alice sees no companies, the admin still sees all', async () => {
      await setRowAccessConfig({ applicationId, config: '{not json' });

      const state = await loadSpiritRowAccessStateInServer();

      expect(state.configStatus).toBe('unreadable');

      const asAlice = await listCompanyIds({
        token: ALICE_TOKEN,
        prefix: records.prefix,
      });
      const asAdmin = await listCompanyIds({
        token: ADMIN_TOKEN,
        prefix: records.prefix,
      });

      expect(asAlice.ids).toEqual([]);
      expect(sortIds(asAdmin.ids)).toEqual(expect.arrayContaining(allIds()));
    });

    it.each([
      [
        'a wrong version',
        { version: 2, rules: [], seeAllRoleIds: [] },
        'version must be 1',
      ],
      [
        'an owner field that does not exist',
        async () => ({
          ...(await buildCompanyRuleConfig()),
          rules: [
            {
              ...(await buildCompanyRuleConfig()).rules[0],
              ownerFieldMetadataId: randomUUID(),
            },
          ],
        }),
        'is not an active MANY_TO_ONE relation from company to workspaceMember',
      ],
      [
        'an enabled rule on timelineActivity, a system object with a real owner-shaped field (D32)',
        async () => ({
          version: 1,
          rules: [
            {
              ...(await findRuleIds('timelineActivity', 'workspaceMember')),
              isEnabled: true,
            },
          ],
          seeAllRoleIds: [],
        }),
        'timelineActivity cannot hold a rule',
      ],
      [
        'an enabled rule on person, a standard object not audited (D32)',
        async () => ({
          version: 1,
          rules: [
            {
              ...(await findRuleIds('person', 'company')),
              isEnabled: true,
            },
          ],
          seeAllRoleIds: [],
        }),
        // person.company is not owner-shaped either; the object check comes
        // first, so this names D32 and not the owner field (review m10)
        'person cannot hold a rule',
      ],
    ])(
      'PT-23: a config with %s fails closed (invalid)',
      async (_label, configOrBuilder, expectedProblem) => {
        const config =
          typeof configOrBuilder === 'function'
            ? await configOrBuilder()
            : configOrBuilder;

        await setRowAccessConfig({ applicationId, config });

        const state = await loadSpiritRowAccessStateInServer();

        expect(state.configStatus).toBe('invalid');
        expect(state.configProblems).toEqual([
          expect.stringContaining(expectedProblem),
        ]);

        const asAlice = await listCompanyIds({
          token: ALICE_TOKEN,
          prefix: records.prefix,
        });

        expect(asAlice.ids).toEqual([]);
      },
    );

    it('D32: the problem names the refused object', async () => {
      await setRowAccessConfig({
        applicationId,
        config: {
          version: 1,
          rules: [
            {
              ...(await findRuleIds('timelineActivity', 'workspaceMember')),
              isEnabled: true,
            },
          ],
          seeAllRoleIds: [],
        },
      });

      expect((await loadSpiritRowAccessStateInServer()).configProblems).toEqual(
        [expect.stringContaining('timelineActivity cannot hold a rule')],
      );
    });

    // D41: the server finds the workspace custom application for real. A
    // seeded custom object passes the object check and fails only on its
    // non-owner field; a refused object would fail on the object check.
    it('D41: a seeded workspace custom object (rocket) may hold a rule', async () => {
      await setRowAccessConfig({
        applicationId,
        config: {
          version: 1,
          rules: [
            { ...(await findRuleIds('rocket', 'name')), isEnabled: true },
          ],
          seeAllRoleIds: [],
        },
      });

      const state = await loadSpiritRowAccessStateInServer();

      expect(state.configStatus).toBe('invalid');
      expect(state.configProblems).toEqual([
        expect.stringContaining(
          'is not an active MANY_TO_ONE relation from rocket to workspaceMember',
        ),
      ]);
    });

    it('D25: a see-all role that does not exist is ignored: the config stays ok and alice still sees A only', async () => {
      await setRowAccessConfig({
        applicationId,
        config: await buildCompanyRuleConfig({
          seeAllRoleIds: [randomUUID(), managerRole!.managerRoleId],
        }),
      });

      const state = await loadSpiritRowAccessStateInServer();

      expect(state.configStatus).toBe('ok');
      expect(state.config?.seeAllRoleIds).toEqual([managerRole!.managerRoleId]);

      await expectAliceSeesAOnly();

      const asManager = await listCompanyIds({
        token: MANAGER_TOKEN,
        prefix: records.prefix,
      });

      expect(sortIds(asManager.ids)).toEqual(allIds());
    });

    it('a valid config again restores alice to A only', async () => {
      await setRowAccessConfig({
        applicationId,
        config: await buildCompanyRuleConfig(),
      });

      await expectAliceSeesAOnly();
    });

    it('PT-22: app uninstalled with enforcement on: alice sees no companies, the admin still sees all', async () => {
      await uninstallRowAccessApp();

      const state = await loadSpiritRowAccessStateInServer();

      expect(state.configStatus).toBe('application-missing');

      const asAlice = await listCompanyIds({
        token: ALICE_TOKEN,
        prefix: records.prefix,
      });
      const asAdmin = await listCompanyIds({
        token: ADMIN_TOKEN,
        prefix: records.prefix,
      });

      expect(asAlice.errors).toBeUndefined();
      expect(asAlice.ids).toEqual([]);
      expect(sortIds(asAdmin.ids)).toEqual(expect.arrayContaining(allIds()));
    });
  });
});
