import { create } from 'zustand';

/**
 * Whether the server runs Grok Bot Live Control. Set only from the SSE snapshot, which carries
 * `liveControl: true` only when the server-side flag is on, so the page makes no live-control
 * request at all while it is off. Never persisted.
 */
export const useLiveFlag = create<{ enabled: boolean }>(() => ({ enabled: false }));

export const setLiveControlEnabled = (enabled: boolean) => {
  if (useLiveFlag.getState().enabled !== enabled) useLiveFlag.setState({ enabled });
};
