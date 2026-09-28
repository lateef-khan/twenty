import { randomUUID } from 'crypto';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { type RecordGqlOperationSignature } from 'twenty-shared/types';

import { type SerializableAuthContext } from 'src/engine/core-modules/auth/types/serializable-auth-context.type';
import { type EventStreamService } from 'src/engine/subscriptions/event-stream.service';
import { type SubscriptionService } from 'src/engine/subscriptions/subscription.service';
import { type EventStreamPayload } from 'src/engine/subscriptions/types/event-stream-payload.type';
import { type ObjectRecordSubscriptionEvent } from 'src/engine/subscriptions/types/object-record-subscription-event.type';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { USER_WORKSPACE_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-user-workspaces.util';
import { USER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-users.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

export const ALICE_STREAM_AUTH_CONTEXT: SerializableAuthContext = {
  userId: USER_DATA_SEED_IDS.JONY,
  userWorkspaceId: USER_WORKSPACE_DATA_SEED_IDS.JONY,
  workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
};

export const ADMIN_STREAM_AUTH_CONTEXT: SerializableAuthContext = {
  userId: USER_DATA_SEED_IDS.JANE,
  userWorkspaceId: USER_WORKSPACE_DATA_SEED_IDS.JANE,
  workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
};

export type ReceivedStreamEvent = {
  queryIds: string[];
  event: ObjectRecordSubscriptionEvent;
};

export type OpenLiveStream = {
  received: ReceivedStreamEvent[];
  waitFor: (
    predicate: (received: ReceivedStreamEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<ReceivedStreamEvent | undefined>;
  close: () => Promise<void>;
};

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Opens a stream the way the event-stream resolver does (same Redis stream
// data and pub/sub channel), minus the SSE transport. Events come from the
// real publisher, fed by real mutations.
export const openLiveStream = async ({
  authContext,
  queries,
}: {
  authContext: SerializableAuthContext;
  queries: Record<string, RecordGqlOperationSignature>;
}): Promise<OpenLiveStream> => {
  const eventStreamService =
    getAppProviderByClassName<EventStreamService>('EventStreamService');
  const subscriptionService = getAppProviderByClassName<SubscriptionService>(
    'SubscriptionService',
  );

  const eventStreamChannelId = `spirit-owner-${randomUUID()}`;

  await eventStreamService.createEventStream({
    workspaceId: SEED_APPLE_WORKSPACE_ID,
    eventStreamChannelId,
    authContext,
  });

  for (const [queryId, operationSignature] of Object.entries(queries)) {
    await eventStreamService.addQuery({
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      eventStreamChannelId,
      queryId,
      operationSignature,
    });
  }

  const iterator = (await subscriptionService.subscribeToEventStream({
    workspaceId: SEED_APPLE_WORKSPACE_ID,
    eventStreamChannelId,
  })) as AsyncIterator<EventStreamPayload>;

  const received: ReceivedStreamEvent[] = [];
  let isClosed = false;

  const pump = (async () => {
    while (!isClosed) {
      const next = await iterator.next();

      if (next.done === true) {
        return;
      }

      for (const item of next.value.objectRecordEventsWithQueryIds ?? []) {
        received.push({
          queryIds: item.queryIds,
          event: item.objectRecordEvent,
        });
      }
    }
  })();

  // Redis subscribes asynchronously; give it a moment before mutations run
  await sleep(300);

  return {
    received,
    waitFor: async (predicate, timeoutMs = 8000) => {
      const startedAt = Date.now();

      while (Date.now() - startedAt < timeoutMs) {
        const match = received.find(predicate);

        if (match !== undefined) {
          return match;
        }

        await sleep(50);
      }

      return undefined;
    },
    close: async () => {
      isClosed = true;
      await iterator.return?.();
      await pump.catch(() => undefined);
      await eventStreamService.destroyEventStream({
        workspaceId: SEED_APPLE_WORKSPACE_ID,
        eventStreamChannelId,
      });
    },
  };
};

export const eventRecord = (
  received: ReceivedStreamEvent,
  side: 'before' | 'after',
): Record<string, unknown> | undefined =>
  (received.event.properties as Record<string, Record<string, unknown>>)[side];
