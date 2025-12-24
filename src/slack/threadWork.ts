import { type MentionEvent } from './types.js';

export type ThreadWorkState = {
  inProgress: boolean;
  abortController?: AbortController;
  queued: MentionEvent[];
  busyMessages: string[];
};

export class ThreadWorkManager {
  private readonly states = new Map<string, ThreadWorkState>();

  isBusy(threadKey: string): boolean {
    return this.getState(threadKey).inProgress;
  }

  begin(threadKey: string, abortController: AbortController): void {
    const state = this.getState(threadKey);
    state.inProgress = true;
    state.abortController = abortController;
  }

  end(threadKey: string): { queued: MentionEvent[]; busyMessages: string[] } {
    const state = this.getState(threadKey);
    state.inProgress = false;
    state.abortController = undefined;
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
