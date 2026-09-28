export type SpiritRowAccessCaller =
  | { kind: 'see-all' }
  | { kind: 'owner'; workspaceMemberId: string | null };
