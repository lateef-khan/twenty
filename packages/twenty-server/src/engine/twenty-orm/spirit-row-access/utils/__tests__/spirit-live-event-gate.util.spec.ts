import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type ObjectRecordSubscriptionEvent } from 'src/engine/subscriptions/types/object-record-subscription-event.type';
import {
  buildSpiritRemoveEvent,
  decideSpiritOwnerEventVerdict,
} from 'src/engine/twenty-orm/spirit-row-access/utils/spirit-live-event-gate.util';

const ALICE = 'alice-member';
const BOB = 'bob-member';
const OWNER_COLUMN = 'accountOwnerId';

const decide = (
  action: DatabaseEventAction,
  before: string | null | undefined,
  after: string | null | undefined,
  workspaceMemberId: string | null = ALICE,
) =>
  decideSpiritOwnerEventVerdict({
    event: {
      action,
      properties: {
        ...(before !== undefined && { before: { [OWNER_COLUMN]: before } }),
        ...(after !== undefined && { after: { [OWNER_COLUMN]: after } }),
      } as ObjectRecordSubscriptionEvent['properties'],
    },
    joinColumnName: OWNER_COLUMN,
    workspaceMemberId,
  });

// PT-15 / PT-15b in §8 of the design: alice gets events for her own rows
// only, and a row that moves away from her leaves her list.
describe('decideSpiritOwnerEventVerdict', () => {
  it.each([
    [
      'keeps an update of her own row',
      DatabaseEventAction.UPDATED,
      ALICE,
      ALICE,
      'keep',
    ],
    [
      'drops an update of a row of bob (PT-15)',
      DatabaseEventAction.UPDATED,
      BOB,
      BOB,
      'drop',
    ],
    [
      'drops an update of a row with no owner',
      DatabaseEventAction.UPDATED,
      null,
      null,
      'drop',
    ],
    [
      'removes a row that moved from her to bob (PT-15b)',
      DatabaseEventAction.UPDATED,
      ALICE,
      BOB,
      'remove',
    ],
    [
      'removes a row whose owner was cleared',
      DatabaseEventAction.UPDATED,
      ALICE,
      null,
      'remove',
    ],
    [
      'keeps a row that moved from bob to her',
      DatabaseEventAction.UPDATED,
      BOB,
      ALICE,
      'keep',
    ],
    [
      'keeps a created row she owns',
      DatabaseEventAction.CREATED,
      undefined,
      ALICE,
      'keep',
    ],
    [
      'drops a created row of bob',
      DatabaseEventAction.CREATED,
      undefined,
      BOB,
      'drop',
    ],
    [
      'keeps a soft delete of her row',
      DatabaseEventAction.DELETED,
      ALICE,
      ALICE,
      'keep',
    ],
    [
      'drops a soft delete of a row of bob',
      DatabaseEventAction.DELETED,
      BOB,
      BOB,
      'drop',
    ],
    [
      'keeps a destroy of her row',
      DatabaseEventAction.DESTROYED,
      ALICE,
      undefined,
      'keep',
    ],
    [
      'drops a destroy of a row of bob',
      DatabaseEventAction.DESTROYED,
      BOB,
      undefined,
      'drop',
    ],
    [
      'keeps a restore of her row',
      DatabaseEventAction.RESTORED,
      ALICE,
      ALICE,
      'keep',
    ],
    [
      'drops a restore of a row of bob',
      DatabaseEventAction.RESTORED,
      BOB,
      BOB,
      'drop',
    ],
  ])('%s', (_label, action, before, after, verdict) => {
    expect(decide(action, before, after)).toBe(verdict);
  });

  it('drops everything for a subscriber with no member id (D10)', () => {
    expect(decide(DatabaseEventAction.UPDATED, ALICE, ALICE, null)).toBe(
      'drop',
    );
  });

  it('drops everything when the owner field cannot back the rule', () => {
    expect(
      decideSpiritOwnerEventVerdict({
        event: {
          action: DatabaseEventAction.UPDATED,
          properties: { after: { [OWNER_COLUMN]: ALICE } },
        },
        joinColumnName: undefined,
        workspaceMemberId: ALICE,
      }),
    ).toBe('drop');
  });
});

describe('buildSpiritRemoveEvent', () => {
  it('sends a soft delete that carries only the state alice could see', () => {
    const moved = {
      recordId: 'company-a',
      action: DatabaseEventAction.UPDATED,
      objectNameSingular: 'company',
      properties: {
        before: { id: 'company-a', name: 'A', [OWNER_COLUMN]: ALICE },
        after: { id: 'company-a', name: 'A renamed', [OWNER_COLUMN]: BOB },
        updatedFields: ['name', OWNER_COLUMN],
        diff: { name: { before: 'A', after: 'A renamed' } },
      },
    } as unknown as ObjectRecordSubscriptionEvent;

    expect(buildSpiritRemoveEvent(moved, '2026-09-27T00:00:00.000Z')).toEqual({
      recordId: 'company-a',
      userId: undefined,
      userWorkspaceId: undefined,
      workspaceMemberId: undefined,
      action: DatabaseEventAction.DELETED,
      objectNameSingular: 'company',
      properties: {
        before: { id: 'company-a', name: 'A', [OWNER_COLUMN]: ALICE },
        after: {
          id: 'company-a',
          name: 'A',
          [OWNER_COLUMN]: ALICE,
          deletedAt: '2026-09-27T00:00:00.000Z',
        },
        updatedFields: ['deletedAt'],
        diff: {},
      },
    });
  });
});
