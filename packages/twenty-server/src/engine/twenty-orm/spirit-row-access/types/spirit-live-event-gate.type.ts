import { type ObjectRecordEvent } from 'twenty-shared/database-events';

import { type SerializableAuthContext } from 'src/engine/core-modules/auth/types/serializable-auth-context.type';
import { type FlatWorkspaceMemberMaps } from 'src/engine/core-modules/user/types/flat-workspace-member-maps.type';
import { type ObjectRecordSubscriptionEvent } from 'src/engine/subscriptions/types/object-record-subscription-event.type';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';

// One subscriber stream within one event batch.
export type SpiritLiveStreamGate = {
  // Undefined drops the event. The verdict is taken on rawEvent; what is
  // returned is built only from filteredEvent (restricted fields removed).
  deliver: (
    rawEvent: ObjectRecordEvent,
    filteredEvent: ObjectRecordSubscriptionEvent,
  ) => ObjectRecordSubscriptionEvent | undefined;
  runEnrichment: (enrich: () => Promise<void>) => Promise<void>;
};

// One event batch, loaded once for every stream it reaches.
export type SpiritLiveBatchGate = {
  openStream: (input: {
    workspaceEventBatch: WorkspaceEventBatch<ObjectRecordEvent>;
    roleIds: string[];
    subscriberAuthContext: SerializableAuthContext;
    flatWorkspaceMemberMaps: FlatWorkspaceMemberMaps;
  }) => Promise<SpiritLiveStreamGate>;
};
