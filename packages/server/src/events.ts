import { EventEmitter } from 'node:events';

export type OfficeEventType =
  | 'card'
  | 'card_event'
  | 'comment'
  | 'agent'
  | 'room'
  | 'break_post'
  | 'break_lock'
  | 'quota'
  | 'profile'
  | 'opinion'
  | 'card_feedback'
  | 'retro'
  | 'retro_message'
  | 'retro_proposal'
  | 'retro_vote'
  | 'retro_revert'
  | 'shares'
  | 'settings'
  | 'usage'
  | 'hook';

export interface OfficeEvent {
  type: OfficeEventType;
  at: number;
  data: unknown;
}

/** In-process pub/sub feeding the SSE stream. */
export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  publish(type: OfficeEventType, data: unknown, at = Date.now()) {
    this.emitter.emit('event', { type, at, data } satisfies OfficeEvent);
  }
  subscribe(fn: (e: OfficeEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
