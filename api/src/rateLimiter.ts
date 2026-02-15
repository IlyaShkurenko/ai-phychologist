export class SessionRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly state = new Map<string, number[]>();

  constructor(windowMs = 60_000, maxRequests = 5) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  assertWithinLimit(sessionId: string): void {
    const now = Date.now();
    const requests = (this.state.get(sessionId) ?? []).filter((ts) => now - ts < this.windowMs);

    if (requests.length >= this.maxRequests) {
      throw new Error("Too many analysis requests. Please wait a bit and retry.");
    }

    requests.push(now);
    this.state.set(sessionId, requests);
  }

  clear(sessionId: string): void {
    this.state.delete(sessionId);
  }
}
