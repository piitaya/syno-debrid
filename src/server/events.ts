import type { ServerEvents } from '../shared/types.js';

type EventName = keyof ServerEvents;
type Listener = <K extends EventName>(event: K, data: ServerEvents[K]) => void;

/** Fan-out of server-sent events to the open apps. */
export class EventHub {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether the app is open somewhere. */
  isWatching(): boolean {
    return this.listeners.size > 0;
  }

  emit<K extends EventName>(event: K, data: ServerEvents[K]): void {
    for (const listener of this.listeners) listener(event, data);
  }
}
