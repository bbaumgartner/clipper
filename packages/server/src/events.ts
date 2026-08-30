import { EventEmitter } from "node:events";
import type { SseEvent } from "@clipper/shared";

export class EventBus extends EventEmitter {
  emitEvent(event: SseEvent): void {
    this.emit("event", event);
  }

  onEvent(listener: (event: SseEvent) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
  }
}
