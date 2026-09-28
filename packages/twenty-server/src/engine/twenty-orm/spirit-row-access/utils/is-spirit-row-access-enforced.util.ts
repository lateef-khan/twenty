export const SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME = 'SPIRIT_ROW_ACCESS_ENFORCED';

// Set by SpiritRowAccessSwitchService when this process has the switch off
// but another live process (server or worker) has it on.
let isEnforcedByLivePeer = false;

export const setSpiritRowAccessEnforcedByLivePeer = (value: boolean) => {
  isEnforcedByLivePeer = value;
};

// This process's own env value. Read on every call so a process that sets
// the variable before boot needs no config service.
export const isSpiritRowAccessSwitchOn = (): boolean =>
  process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME] === 'true';

// Off (the default, with no live peer on): the owner rule is inactive
// everywhere and upstream behaviour is unchanged. A switch mismatch between
// processes resolves to on, because a process with the switch off would
// otherwise publish live updates and run AI chat tools unfiltered.
export const isSpiritRowAccessEnforced = (): boolean =>
  isSpiritRowAccessSwitchOn() || isEnforcedByLivePeer;
