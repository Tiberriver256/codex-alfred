import { type MentionEvent } from './types.js';

export type ThreadWorkState = {
  inProgress: boolean;
  abortController?: AbortController;
  queued: MentionEvent[];
  busyMessages: string[];
  activeEventTs?: string;
};

export class ThreadWorkManager {
  private readonly states = new Map<string, ThreadWorkState>();

  isBusy(threadKey: string): boolean {
    return this.getState(threadKey).inProgress;
  }

  tryBegin(threadKey: string, abortController: AbortController, eventTs?: string): boolean {
    const state = this.getState(threadKey);
    if (state.inProgress) return false;
    state.inProgress = true;
    state.abortController = abortController;
    state.activeEventTs = eventTs;
    return true;
  }

  begin(threadKey: string, abortController: AbortController, eventTs?: string): void {
    const state = this.getState(threadKey);
    state.inProgress = true;
    state.abortController = abortController;
    state.activeEventTs = eventTs;
  }

  end(threadKey: string): { queued: MentionEvent[]; busyMessages: string[] } {
    const state = this.getState(threadKey);
    state.inProgress = false;
    state.abortController = undefined;
    state.activeEventTs = undefined;
    const queued = state.queued;
    const busyMessages = state.busyMessages;
    state.queued = [];
    state.busyMessages = [];
    return { queued, busyMessages };
  }

  queueMention(threadKey: string, event: MentionEvent, busyMessageTs?: string): void {
    const state = this.getState(threadKey);
    state.queued.push(event);
    if (busyMessageTs) state.busyMessages.push(busyMessageTs);
  }

  hasSeenMention(threadKey: string, eventTs?: string): boolean {
    if (!eventTs) return false;
    const state = this.getState(threadKey);
    if (state.activeEventTs === eventTs) return true;
    return state.queued.some((queued) => queued.ts === eventTs);
  }

  requestInterrupt(threadKey: string): boolean {
    const state = this.states.get(threadKey);
    if (!state?.abortController) return false;
    state.abortController.abort();
    return true;
  }

  private getState(threadKey: string): ThreadWorkState {
    let state = this.states.get(threadKey);
    if (!state) {
      state = { inProgress: false, queued: [], busyMessages: [] };
      this.states.set(threadKey, state);
    }
    return state;
  }
}
