import { Injectable } from '@nestjs/common';

import { type ObjectRecordEvent } from 'twenty-shared/database-events';
import { type ObjectRecord } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { In } from 'typeorm';

import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type SerializableAuthContext } from 'src/engine/core-modules/auth/types/serializable-auth-context.type';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type FlatWorkspaceMemberMaps } from 'src/engine/core-modules/user/types/flat-workspace-member-maps.type';
import { SPIRIT_LIVE_EVENTS_OFF } from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-live-events-off.constant';
import { SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import {
  type SpiritLiveBatchGate,
  type SpiritLiveStreamGate,
} from 'src/engine/twenty-orm/spirit-row-access/types/spirit-live-event-gate.type';
import { type SpiritRowAccessWorkspaceSnapshot } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-workspace-snapshot.type';
import { isSpiritRowAccessEnforced } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { resolveSpiritRowAccessCallerFromRoleIds } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-row-access-caller.util';
import {
  buildSpiritRemoveEvent,
  decideSpiritOwnerEventVerdict,
  resolveSpiritLiveEventGate,
} from 'src/engine/twenty-orm/spirit-row-access/utils/spirit-live-event-gate.util';
import {
  getWorkspaceContext,
  type ORMWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { parseEventNameOrThrow } from 'src/engine/workspace-event-emitter/utils/parse-event-name';

const DROP_EVERY_EVENT: SpiritLiveStreamGate = {
  deliver: () => undefined,
  runEnrichment: async () => undefined,
};

// The owner rule on live updates (design §5.8). The publisher calls it once
// per batch, once per stream, once per event, and around enrichment.
@Injectable()
export class SpiritLiveEventService {
  constructor(
    private readonly spiritRowAccessStateService: SpiritRowAccessStateService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
  ) {}

  async prepareBatch(workspaceId: string): Promise<SpiritLiveBatchGate> {
    if (!isSpiritRowAccessEnforced()) {
      return SPIRIT_LIVE_EVENTS_OFF;
    }

    const snapshot =
      await this.spiritRowAccessStateService.loadSnapshot(workspaceId);

    return {
      openStream: (input) => this.openStream({ ...input, snapshot }),
    };
  }

  private async openStream({
    workspaceEventBatch,
    roleIds,
    subscriberAuthContext,
    flatWorkspaceMemberMaps,
    snapshot,
  }: {
    workspaceEventBatch: WorkspaceEventBatch<ObjectRecordEvent>;
    roleIds: string[];
    subscriberAuthContext: SerializableAuthContext;
    flatWorkspaceMemberMaps: FlatWorkspaceMemberMaps;
    snapshot: SpiritRowAccessWorkspaceSnapshot | undefined;
  }): Promise<SpiritLiveStreamGate> {
    // A flip race: the rule is on but its state could not be loaded.
    if (!isDefined(snapshot)) {
      return DROP_EVERY_EVENT;
    }

    const caller = resolveSpiritRowAccessCallerFromRoleIds({
      roleIdsInForce: roleIds,
      workspaceMemberId: subscriberAuthContext.workspaceMemberId ?? null,
      state: snapshot.state,
    });

    const gate = resolveSpiritLiveEventGate({
      state: snapshot.state,
      flatObjectMetadata: workspaceEventBatch.objectMetadata,
      flatObjectMetadataMaps: snapshot.flatObjectMetadataMaps,
      flatFieldMetadataMaps: snapshot.flatFieldMetadataMaps,
      objectIdByNameSingular: snapshot.objectIdByNameSingular,
      roleIds,
      workspaceMemberId: subscriberAuthContext.workspaceMemberId,
    });

    const subscriberWorkspaceAuthContext = this.buildSubscriberAuthContext({
      workspaceId: workspaceEventBatch.workspaceId,
      subscriberAuthContext,
      flatWorkspaceMemberMaps,
    });

    // Loading a workspace context is costly, so one stream loads it at most
    // once, for the re-read and the enrichment together.
    let subscriberOrmContext: Promise<ORMWorkspaceContext> | undefined;

    const loadSubscriberOrmContext = (authContext: WorkspaceAuthContext) => {
      subscriberOrmContext ??=
        this.workspaceOrmManager.executeInWorkspaceContext(
          () => getWorkspaceContext(),
          authContext,
        );

      return subscriberOrmContext;
    };

    const { action } = parseEventNameOrThrow(workspaceEventBatch.name);

    // Gated child objects cannot be judged from the event alone, so their
    // ids are re-read as the subscriber through the same SQL rule as reads.
    // A destroyed row cannot be re-read, so its event is dropped.
    const visibleRecordIds =
      gate.kind === 'reread'
        ? isDefined(subscriberWorkspaceAuthContext) &&
          action !== DatabaseEventAction.DESTROYED
          ? await this.findVisibleRecordIds({
              objectNameSingular:
                workspaceEventBatch.objectMetadata.nameSingular,
              recordIds: workspaceEventBatch.events.map(
                (event) => event.recordId,
              ),
              roleIds,
              ormContext: await loadSubscriberOrmContext(
                subscriberWorkspaceAuthContext,
              ),
            })
          : new Set<string>()
        : undefined;

    return {
      deliver: (rawEvent, filteredEvent) => {
        switch (gate.kind) {
          case 'open':
            return filteredEvent;
          case 'reread':
            return visibleRecordIds?.has(filteredEvent.recordId)
              ? filteredEvent
              : undefined;
          case 'owner': {
            const verdict = decideSpiritOwnerEventVerdict({
              event: { action, properties: rawEvent.properties },
              joinColumnName: gate.joinColumnName,
              workspaceMemberId: gate.workspaceMemberId,
            });

            if (verdict === 'keep') {
              return filteredEvent;
            }

            return verdict === 'remove'
              ? buildSpiritRemoveEvent(filteredEvent, new Date().toISOString())
              : undefined;
          }
        }
      },
      // Upstream enriches as the writer; nested relations must be read as
      // the subscriber, or they carry the writer's records.
      runEnrichment: async (enrich) => {
        if (caller.kind === 'see-all') {
          return enrich();
        }

        if (!isDefined(subscriberWorkspaceAuthContext)) {
          return;
        }

        const ormContext = await loadSubscriberOrmContext(
          subscriberWorkspaceAuthContext,
        );

        await withWorkspaceContext(ormContext, enrich);
      },
    };
  }

  private async findVisibleRecordIds({
    objectNameSingular,
    recordIds,
    roleIds,
    ormContext,
  }: {
    objectNameSingular: string;
    recordIds: string[];
    roleIds: string[];
    ormContext: ORMWorkspaceContext;
  }): Promise<Set<string>> {
    const uniqueRecordIds = [...new Set(recordIds)];

    if (uniqueRecordIds.length === 0) {
      return new Set();
    }

    const visibleRecords = await withWorkspaceContext(ormContext, () =>
      this.workspaceOrmManager
        .getRepository<ObjectRecord>(objectNameSingular, {
          intersectionOf: roleIds,
        })
        .find({
          where: { id: In(uniqueRecordIds) },
          select: ['id'],
          withDeleted: true,
        }),
    );

    return new Set(visibleRecords.map((record) => record.id as string));
  }

  // A stream always has a user; with no member the subscriber gets no
  // enrichment and no re-read rows.
  private buildSubscriberAuthContext({
    workspaceId,
    subscriberAuthContext,
    flatWorkspaceMemberMaps,
  }: {
    workspaceId: string;
    subscriberAuthContext: SerializableAuthContext;
    flatWorkspaceMemberMaps: FlatWorkspaceMemberMaps;
  }): WorkspaceAuthContext | undefined {
    const { userId, userWorkspaceId, workspaceMemberId } =
      subscriberAuthContext;

    if (
      !isDefined(userId) ||
      !isDefined(userWorkspaceId) ||
      !isDefined(workspaceMemberId)
    ) {
      return undefined;
    }

    const workspaceMember = flatWorkspaceMemberMaps.byId[workspaceMemberId];

    if (!isDefined(workspaceMember)) {
      return undefined;
    }

    return {
      type: 'user',
      workspace: { id: workspaceId },
      user: { id: userId },
      userWorkspaceId,
      workspaceMemberId,
      workspaceMember,
    } as unknown as WorkspaceAuthContext;
  }
}
