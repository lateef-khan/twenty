import {
  type SpiritLiveBatchGate,
  type SpiritLiveStreamGate,
} from 'src/engine/twenty-orm/spirit-row-access/types/spirit-live-event-gate.type';

const SPIRIT_LIVE_STREAM_OFF: SpiritLiveStreamGate = {
  deliver: (_rawEvent, filteredEvent) => filteredEvent,
  runEnrichment: (enrich) => enrich(),
};

// The rule is off: every event passes and enrichment runs as upstream does.
export const SPIRIT_LIVE_EVENTS_OFF: SpiritLiveBatchGate = {
  openStream: async () => SPIRIT_LIVE_STREAM_OFF,
};
