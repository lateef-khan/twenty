import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';

import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type ObjectRecordSubscriptionEvent } from 'src/engine/subscriptions/types/object-record-subscription-event.type';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { isSpiritGatedObject } from 'src/engine/twenty-orm/spirit-row-access/utils/build-spirit-visibility-condition.util';
import { resolveSpiritOwnerJoinColumnName } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-join-column-name.util';
import { resolveSpiritOwnerRuleTarget } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-rule-target.util';
import { resolveSpiritRowAccessCallerFromRoleIds } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-row-access-caller.util';

// open: every event passes. owner: decide from the owner column carried in
// the event. reread: the object follows parents (child, junction or
// see-all-only), so the publisher re-reads the record ids as the subscriber.
export type SpiritLiveEventGate =
  | { kind: 'open' }
  | {
      kind: 'owner';
      joinColumnName: string | undefined;
      workspaceMemberId: string | null;
    }
  | { kind: 'reread' };

export type SpiritLiveEventVerdict = 'keep' | 'drop' | 'remove';

export const resolveSpiritLiveEventGate = ({
  state,
  flatObjectMetadata,
  flatObjectMetadataMaps,
  flatFieldMetadataMaps,
  objectIdByNameSingular,
  roleIds,
  workspaceMemberId,
}: {
  state: SpiritRowAccessState | undefined;
  flatObjectMetadata: FlatObjectMetadata;
  flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
  objectIdByNameSingular: Record<string, string>;
  roleIds: string[];
  workspaceMemberId: string | undefined;
}): SpiritLiveEventGate => {
  const caller = resolveSpiritRowAccessCallerFromRoleIds({
    roleIdsInForce: roleIds,
    workspaceMemberId: workspaceMemberId ?? null,
    state,
  });

  if (caller.kind === 'see-all') {
    return { kind: 'open' };
  }

  const ownerTarget = resolveSpiritOwnerRuleTarget({
    state,
    flatObjectMetadata,
    flatFieldMetadataMaps,
    objectIdByNameSingular,
  });

  if (isDefined(ownerTarget.rule)) {
    return {
      kind: 'owner',
      joinColumnName: resolveSpiritOwnerJoinColumnName({
        rule: ownerTarget.rule,
        ownerFieldMetadata: ownerTarget.ownerFieldMetadata,
        workspaceMemberObjectMetadataId:
          ownerTarget.workspaceMemberObjectMetadataId,
      }),
      workspaceMemberId: caller.workspaceMemberId,
    };
  }

  const isGated = isSpiritGatedObject({
    context: {
      state,
      caller,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      objectIdByNameSingular,
      resolveTableExpression: () => '',
    },
    flatObjectMetadata,
  });

  return isGated ? { kind: 'reread' } : { kind: 'open' };
};

const isOwnedBy = (
  record: object | null | undefined,
  joinColumnName: string,
  workspaceMemberId: string,
) =>
  isDefined(record) &&
  (record as Record<string, unknown>)[joinColumnName] === workspaceMemberId;

// Decided on the event before restricted fields are stripped, so a Member
// whose field permissions hide the owner column is still judged correctly.
export const decideSpiritOwnerEventVerdict = ({
  event,
  joinColumnName,
  workspaceMemberId,
}: {
  event: Pick<ObjectRecordSubscriptionEvent, 'action' | 'properties'>;
  joinColumnName: string | undefined;
  workspaceMemberId: string | null;
}): SpiritLiveEventVerdict => {
  if (
    !isNonEmptyString(joinColumnName) ||
    !isNonEmptyString(workspaceMemberId)
  ) {
    return 'drop';
  }

  const { before, after } = event.properties as {
    before?: object | null;
    after?: object | null;
  };

  const isBeforeMine = isOwnedBy(before, joinColumnName, workspaceMemberId);
  const isAfterMine = isOwnedBy(after, joinColumnName, workspaceMemberId);

  switch (event.action) {
    case DatabaseEventAction.UPDATED:
      if (isAfterMine) {
        return 'keep';
      }

      return isBeforeMine ? 'remove' : 'drop';
    case DatabaseEventAction.DESTROYED:
      return isBeforeMine ? 'keep' : 'drop';
    case DatabaseEventAction.DELETED:
      return isAfterMine || (!isDefined(after) && isBeforeMine)
        ? 'keep'
        : 'drop';
    case DatabaseEventAction.CREATED:
    case DatabaseEventAction.UPSERTED:
    case DatabaseEventAction.RESTORED:
    default:
      return isAfterMine ? 'keep' : 'drop';
  }
};

// The stream has no "remove" action. A soft delete is the only event the
// front drops from a list, so a record that moved away from the subscriber
// is sent as one. It carries only the state the subscriber could already see.
export const buildSpiritRemoveEvent = (
  event: ObjectRecordSubscriptionEvent,
  deletedAt: string,
): ObjectRecordSubscriptionEvent => {
  const before = (event.properties as { before?: object }).before ?? {
    id: event.recordId,
  };

  return {
    recordId: event.recordId,
    userId: event.userId,
    userWorkspaceId: event.userWorkspaceId,
    workspaceMemberId: event.workspaceMemberId,
    action: DatabaseEventAction.DELETED,
    objectNameSingular: event.objectNameSingular,
    properties: {
      before,
      after: { ...before, deletedAt },
      updatedFields: ['deletedAt'],
      diff: {},
    },
  } as ObjectRecordSubscriptionEvent;
};
