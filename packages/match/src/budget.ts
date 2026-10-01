/** Per-connection message budget (docs/multiplayer-server-design.md §10.2 Flood): sustained rate and burst, e.g. frames queued during a stall. */
export const MSG_PER_SECOND = 40;
export const MSG_BURST = 100;

/**
 * Token bucket per connection: honest clients send 20 inputs/s plus a few control messages.
 * On Cloudflare every message is billed (20 messages = 1 request); anywhere, one socket must
 * not be able to monopolise the room.
 */
export class MessageBudget<K> {
	private readonly buckets = new Map<K, { tokens: number; at: number }>();

	constructor(
		private readonly perSecond = MSG_PER_SECOND,
		private readonly burst = MSG_BURST
	) {}

	/** Spends one message for `key`; false once it is over budget. */
	take(key: K, now: number): boolean {
		const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
		b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond) - 1;
		b.at = now;
		this.buckets.set(key, b);
		return b.tokens >= 0;
	}

	forget(key: K): void {
		this.buckets.delete(key);
	}
}
