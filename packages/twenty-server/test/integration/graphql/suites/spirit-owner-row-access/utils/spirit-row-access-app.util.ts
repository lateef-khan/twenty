import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import gql from 'graphql-tag';
import { findCompanyAndOwnerFieldIds } from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { cleanupApplicationAndAppRegistration } from 'test/integration/metadata/suites/application/utils/cleanup-application-and-app-registration.util';
import { installApplication } from 'test/integration/metadata/suites/application/utils/install-application.util';
import { uploadAppTarball } from 'test/integration/metadata/suites/application/utils/upload-app-tarball.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { findOneApplicationIdByUniversalIdentifier } from 'test/integration/secret-encryption/utils/find-one-application.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { isDefined } from 'twenty-shared/utils';

import {
  SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER,
  SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
} from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-row-access-application.constant';
import { type SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

// The real app, built by `yarn twenty dev:build --tarball` in the SpiritAI
// repo's twenty/apps/row-access (this checkout is its twenty/source). The
// tests install it the way `app:publish --private` + `app:install` do: upload
// the tarball, then install by universal id.
const ROW_ACCESS_APP_OUTPUT_DIR =
  process.env.SPIRIT_ROW_ACCESS_APP_DIR ??
  resolve(__dirname, '../'.repeat(9), 'apps/row-access/.twenty/output');

const ROW_ACCESS_APP_TARBALL_NAME = /^row-access-(\d+\.\d+\.\d+)\.tgz$/;

export const resolveRowAccessAppTarball = (): {
  path: string;
  version: string;
} => {
  const tarballNames = existsSync(ROW_ACCESS_APP_OUTPUT_DIR)
    ? readdirSync(ROW_ACCESS_APP_OUTPUT_DIR).filter((name) =>
        ROW_ACCESS_APP_TARBALL_NAME.test(name),
      )
    : [];

  if (tarballNames.length !== 1) {
    throw new Error(
      `Expected one row-access-<version>.tgz in ${ROW_ACCESS_APP_OUTPUT_DIR}, found ${tarballNames.length}. Build it: cd twenty/apps/row-access && yarn twenty dev:build --tarball (or set SPIRIT_ROW_ACCESS_APP_DIR)`,
    );
  }

  const [tarballName] = tarballNames;

  return {
    path: join(ROW_ACCESS_APP_OUTPUT_DIR, tarballName),
    version: ROW_ACCESS_APP_TARBALL_NAME.exec(tarballName)![1],
  };
};

// The settings front component of the app (its manifest universal id).
export const ROW_ACCESS_SETTINGS_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '8ff5ef78-e264-4d3e-ae3d-90a8a99c9f8a';

export const assertSpiritRowAccessEnforced = () => {
  if (process.env.SPIRIT_ROW_ACCESS_ENFORCED !== 'true') {
    throw new Error(
      'Run the spirit row access specs with SPIRIT_ROW_ACCESS_ENFORCED=true in the shell (not in .env.test)',
    );
  }
};

export const readRowAccessAppTarball = (): Buffer =>
  readFileSync(resolveRowAccessAppTarball().path);

export const uninstallRowAccessApp = async () => {
  await cleanupApplicationAndAppRegistration({
    applicationUniversalIdentifier:
      SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER,
  });

  // The cleanup util deletes rows with SQL after the uninstall mutation, so
  // flush the two cache keys the loader reads.
  await getAppProviderByClassName<{
    invalidateAndRecompute: (
      workspaceId: string,
      keys: string[],
    ) => Promise<void>;
  }>('WorkspaceCacheService').invalidateAndRecompute(SEED_APPLE_WORKSPACE_ID, [
    'flatApplicationMaps',
    'applicationVariableMaps',
  ]);
};

export const installRowAccessApp = async (): Promise<string> => {
  jest.useRealTimers();

  await uninstallRowAccessApp();

  await uploadAppTarball({
    tarballBuffer: readRowAccessAppTarball(),
    expectToFail: false,
  });

  await installApplication({
    input: {
      universalIdentifier: SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER,
    },
    expectToFail: false,
  });

  return findOneApplicationIdByUniversalIdentifier({
    universalIdentifier: SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER,
  });
};

export const updateRowAccessConfigVariable = ({
  applicationId,
  value,
  token,
}: {
  applicationId: string;
  value: string;
  token?: string;
}) =>
  makeMetadataAPIRequest(
    {
      query: gql`
        mutation SpiritUpdateRowAccessConfig(
          $key: String!
          $value: String!
          $applicationId: UUID!
        ) {
          updateOneApplicationVariable(
            key: $key
            value: $value
            applicationId: $applicationId
          )
        }
      `,
      variables: {
        key: SPIRIT_ROW_ACCESS_CONFIG_VARIABLE_KEY,
        value,
        applicationId,
      },
    },
    token,
  );

// Which rules the suites run with. Default: the Company rule only, which the
// specs were written against. SPIRIT_ROW_ACCESS_TEST_RULES=spirit (in the
// shell) adds the real Spirit rules on Opportunity (owner) and Task
// (assignee) after it, to see which expectations the wider config changes.
export const isSpiritRulesTestMode = () =>
  process.env.SPIRIT_ROW_ACCESS_TEST_RULES === 'spirit';

export const findOwnerRuleFieldIds = async () => {
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

  const findIds = (objectName: string, fieldName: string) => {
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

  return {
    company: findIds('company', 'accountOwner'),
    opportunity: findIds('opportunity', 'owner'),
    task: findIds('task', 'assignee'),
  };
};

// The real Spirit config (design §9): Company by accountOwner, Opportunity by
// owner, Task by assignee.
export const buildSpiritRulesConfig = async ({
  seeAllRoleIds = [],
}: { seeAllRoleIds?: string[] } = {}) => {
  const ids = await findOwnerRuleFieldIds();

  return {
    version: 1,
    rules: [ids.company, ids.opportunity, ids.task].map((rule) => ({
      ...rule,
      isEnabled: true,
    })),
    seeAllRoleIds,
  };
};

export const buildCompanyRuleConfig = async ({
  seeAllRoleIds = [],
  isEnabled = true,
}: {
  seeAllRoleIds?: string[];
  isEnabled?: boolean;
} = {}) => {
  const { companyObjectMetadataId, accountOwnerFieldMetadataId } =
    await findCompanyAndOwnerFieldIds();

  const extraRules = isSpiritRulesTestMode()
    ? (await buildSpiritRulesConfig()).rules.slice(1)
    : [];

  return {
    version: 1,
    rules: [
      {
        objectMetadataId: companyObjectMetadataId,
        ownerFieldMetadataId: accountOwnerFieldMetadataId,
        isEnabled,
      },
      ...extraRules,
    ],
    seeAllRoleIds,
  };
};

export const setRowAccessConfig = async ({
  applicationId,
  config,
}: {
  applicationId: string;
  config: unknown;
}) => {
  const response = await updateRowAccessConfigVariable({
    applicationId,
    value: typeof config === 'string' ? config : JSON.stringify(config),
  });

  expect(response.body.errors).toBeUndefined();
};

export type SpiritRowAccessTestConfig = {
  version: number;
  rules: {
    objectMetadataId: string;
    ownerFieldMetadataId: string;
    isEnabled: boolean;
  }[];
  seeAllRoleIds: string[];
};

export type SpiritRowAccessAppSetup = {
  applicationId: string;
  seeAllRoleIds: string[];
  // The config the spec runs with, when it is not the Company rule
  baseConfig?: SpiritRowAccessTestConfig;
};

const buildBaseConfig = async (
  setup: SpiritRowAccessAppSetup,
): Promise<SpiritRowAccessTestConfig> =>
  setup.baseConfig ??
  (await buildCompanyRuleConfig({ seeAllRoleIds: setup.seeAllRoleIds }));

// Installs the app and saves the design's test config: the Company rule on
// accountOwner, plus the given see-all roles.
export const setupSpiritRowAccessApp = async ({
  seeAllRoleIds = [],
}: { seeAllRoleIds?: string[] } = {}): Promise<SpiritRowAccessAppSetup> => {
  assertSpiritRowAccessEnforced();

  const applicationId = await installRowAccessApp();

  await setRowAccessConfig({
    applicationId,
    config: await buildCompanyRuleConfig({ seeAllRoleIds }),
  });

  return { applicationId, seeAllRoleIds };
};

export const findMemberRoleId = async () =>
  (await findOneRoleByLabel({ label: 'Member' })).id;

// Config-driven controls (design D36). The same query runs with a config
// that allows the row, to prove the path returns rows when allowed and that
// the rule (not something else) hid them. The spec's own config is saved
// again afterwards.
export const withRowAccessConfig = async <TResult>(
  setup: SpiritRowAccessAppSetup | undefined,
  config: unknown,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (!isDefined(setup)) {
    throw new Error('Row access app is not set up');
  }

  await setRowAccessConfig({ applicationId: setup.applicationId, config });

  try {
    return await run();
  } finally {
    await setRowAccessConfig({
      applicationId: setup.applicationId,
      config: await buildBaseConfig(setup),
    });
  }
};

// alice (Member) is made see-all through the config.
export const withAliceSeeAll = async <TResult>(
  setup: SpiritRowAccessAppSetup | undefined,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (!isDefined(setup)) {
    throw new Error('Row access app is not set up');
  }

  const baseConfig = await buildBaseConfig(setup);

  return withRowAccessConfig(
    setup,
    {
      ...baseConfig,
      seeAllRoleIds: [...baseConfig.seeAllRoleIds, await findMemberRoleId()],
    },
    run,
  );
};

// Every rule turned off: nothing is gated (D6).
export const withRulesOff = async <TResult>(
  setup: SpiritRowAccessAppSetup | undefined,
  run: () => Promise<TResult>,
): Promise<TResult> =>
  withRowAccessConfig(
    setup,
    { version: 1, rules: [], seeAllRoleIds: setup?.seeAllRoleIds ?? [] },
    run,
  );

export const cleanupSpiritRowAccessApp = async (
  setup: Partial<SpiritRowAccessAppSetup> | undefined,
) => {
  if (isDefined(setup?.applicationId)) {
    await uninstallRowAccessApp();
  }
};

export const loadSpiritRowAccessStateInServer =
  async (): Promise<SpiritRowAccessState> => {
    const state = await getAppProviderByClassName<SpiritRowAccessStateService>(
      'SpiritRowAccessStateService',
    ).loadState(SEED_APPLE_WORKSPACE_ID);

    if (!isDefined(state)) {
      throw new Error('Row access enforcement is off in the server process');
    }

    return state;
  };
