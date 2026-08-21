// Bounded HITL waits — avenza's pending-set discipline adapted to mausbot's
// approval cards (ADR 0003). The driver-side broker already fails cards
// closed at 15 minutes; this module adds the ENGINE-side wait so a turn can
// sit in `awaiting_input` with its own deadline instead of blocking an
// unbounded promise.
//
// The waiter never touches the DOM or the bus directly: events arrive via
// an injected subscription, keeping the engine decoupled from index.ts.
export interface HitlResolution {
  status: "resolved";
  behavior: string;
}

export interface HitlTimeout {
  status: "timeout";
}

export type HitlWaitResult = HitlResolution | HitlTimeout;

export interface HitlEvent {
  kind: string;
  threadId?: string;
  requestId?: string;
  behavior?: string;
}

export class HitlWaiter {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly subscribe: (handler: (event: HitlEvent) => void) => () => void) {}

  /**
   * Wait for `request.resolved` on this request, or until the deadline.
   * Multiple concurrent waits are independent; each resolves exactly once.
   */
  wait(requestId: string, timeoutMs: number, now: () => number = Date.now): Promise<HitlWaitResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: HitlWaitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.unsubscribe?.();
        this.unsubscribe = null;
        resolve(result);
      };
      const timer = setTimeout(() => settle({ status: "timeout" }), timeoutMs);
      const handler = (event: HitlEvent): void => {
        if (event.kind === "request.resolved" && event.requestId === requestId) {
          settle({ status: "resolved", behavior: event.behavior ?? "unknown" });
        }
      };
      if (!this.unsubscribe) this.unsubscribe = this.subscribe(handler);
      void now;
    });
  }
}
