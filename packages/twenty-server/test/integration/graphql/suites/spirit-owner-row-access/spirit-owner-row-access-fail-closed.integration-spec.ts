import gql from 'graphql-tag';
import {
  ADMIN_TOKEN,
  ALICE_MEMBER_ID,
  ALICE_TOKEN,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  assertSpiritRowAccessEnforced,
  uninstallRowAccessApp,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { isDefined } from 'twenty-shared/utils';

import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { type SpiritRowAccessWorkspaceSnapshot } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-workspace-snapshot.type';
import { isSpiritGatedObject } from 'src/engine/twenty-orm/spirit-row-access/utils/build-spirit-visibility-condition.util';
import { resolveSpiritOwnerRuleTarget } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-rule-target.util';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

jest.setTimeout(180000);

const listObjectsOf = (snapshot: SpiritRowAccessWorkspaceSnapshot) =>
  Object.values(snapshot.flatObjectMetadataMaps.byUniversalIdentifier)
    .filter(isDefined)
    .filter((object) => object.isActive !== false);

const namesOf = (objects: FlatObjectMetadata[]) =>
  objects.map((object) => object.nameSingular).sort();

const resolveFailClosedScope = (
  snapshot: SpiritRowAccessWorkspaceSnapshot,
  state: SpiritRowAccessState,
) => {
  const objects = listObjectsOf(snapshot);
  const context = {
    state,
    caller: { kind: 'owner' as const, workspaceMemberId: ALICE_MEMBER_ID },
    flatObjectMetadataMaps: snapshot.flatObjectMetadataMaps,
    flatFieldMetadataMaps: snapshot.flatFieldMetadataMaps,
    objectIdByNameSingular: snapshot.objectIdByNameSingular,
    resolveTableExpression: () => '',
  };

  const ownerRuled = objects.filter((object) =>
    isDefined(
      resolveSpiritOwnerRuleTarget({
        state,
        flatObjectMetadata: object,
        flatFieldMetadataMaps: snapshot.flatFieldMetadataMaps,
        objectIdByNameSingular: snapshot.objectIdByNameSingular,
      }).rule,
    ),
  );
  const gated = objects.filter((object) =>
    isSpiritGatedObject({ context, flatObjectMetadata: object }),
  );

  return { objects, ownerRuled, gated };
};

const countAs = async (token: string, namePlural: string) => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql(
        `query SpiritCount { ${namePlural}(first: 1) { totalCount } }`,
      ),
    },
    token,
  );

  if (isDefined(response.body.errors)) {
    return `error:${response.body.errors[0]?.extensions?.code ?? 'unknown'}`;
  }

  return response.body.data?.[namePlural]?.totalCount as number;
};

// Measured against the seeded Apple workspace (2026-09-27).
// Owner-ruled: every object with a MANY_TO_ONE relation to workspaceMember
// (always-false for a Member). Gated: those plus their children.
const EXPECTED_OWNER_RULED_WHEN_MISSING = [
  'blocklist',
  'calendarEventParticipant',
  'company',
  'messageParticipant',
  'opportunity',
  'task',
  'timelineActivity',
];
const EXPECTED_GATED_WHEN_MISSING = [
  'attachment',
  'blocklist',
  'calendarEventParticipant',
  'calendarEventTarget',
  'company',
  'messageParticipant',
  'messageThreadTarget',
  'note',
  'noteTarget',
  'opportunity',
  'task',
  'taskTarget',
  'timelineActivity',
  'workflowRun',
];

describe('spirit owner row access: fail-closed scope (§5.2)', () => {
  let records: SpiritOwnerRecords;
  let snapshot: SpiritRowAccessWorkspaceSnapshot;

  beforeAll(async () => {
    assertSpiritRowAccessEnforced();
    await uninstallRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());

    const loaded = await getAppProviderByClassName<SpiritRowAccessStateService>(
      'SpiritRowAccessStateService',
    ).loadSnapshot(SEED_APPLE_WORKSPACE_ID);

    if (!isDefined(loaded)) {
      throw new Error('enforcement is off in the server process');
    }

    snapshot = loaded;
  });

  afterAll(async () => {
    await destroyCompaniesByPrefix(records.prefix);
  });

  it('with the app missing, a Member loses every owner-shaped object and its children (D23)', async () => {
    expect(snapshot.state.configStatus).toBe('application-missing');

    const missing = resolveFailClosedScope(snapshot, snapshot.state);

    expect(namesOf(missing.ownerRuled)).toEqual(
      EXPECTED_OWNER_RULED_WHEN_MISSING,
    );
    expect(namesOf(missing.gated)).toEqual(EXPECTED_GATED_WHEN_MISSING);
  });

  it('live: alice counts zero rows on every owner-ruled object while the admin still counts rows', async () => {
    const { ownerRuled, gated } = resolveFailClosedScope(
      snapshot,
      snapshot.state,
    );
    const rows: Record<string, { alice: unknown; admin: unknown }> = {};

    for (const object of gated) {
      rows[object.nameSingular] = {
        alice: await countAs(ALICE_TOKEN, object.namePlural),
        admin: await countAs(ADMIN_TOKEN, object.namePlural),
      };
    }

    for (const object of ownerRuled) {
      const counts = rows[object.nameSingular];

      if (typeof counts.alice === 'number') {
        expect({ [object.nameSingular]: counts.alice }).toEqual({
          [object.nameSingular]: 0,
        });
      }
    }

    // Control: the admin still reads the companies made for this spec.
    expect(rows.company.admin).toEqual(expect.any(Number));
    expect(rows.company.admin as number).toBeGreaterThanOrEqual(3);
  });
});
