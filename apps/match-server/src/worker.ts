import { INTERNAL_SIG_HEADER, signInternal, type MatchSummary, type RewardGrant, type RewardOutcome } from '@ofa/match';
import { API } from '@ofa/net';

/** Rewards and match rows go through the Worker, which owns D1 (docs/match-server-oracle.md §8). */
export interface WorkerApi {
	grant(g: RewardGrant): Promise<RewardOutcome>;
	recordMatch(s: MatchSummary): Promise<void>;
}

const TIMEOUT_MS = 10_000;

/** Signed POSTs to the Worker's internal routes. Throws on any failure; MatchCore retries grants from its alarm. */
export class WorkerClient implements WorkerApi {
	constructor(
		private readonly origin: string,
		private readonly secret: string,
		private readonly fetchFn: typeof fetch = fetch
	) {}

	async grant(g: RewardGrant): Promise<RewardOutcome> {
		return (await this.post(API.internalGrant, g)) as RewardOutcome;
	}

	async recordMatch(s: MatchSummary): Promise<void> {
		await this.post(API.internalMatch, s);
	}

	private async post(path: string, payload: unknown): Promise<unknown> {
		const body = JSON.stringify(payload);
		const res = await this.fetchFn(`${this.origin}${path}`, {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/json', [INTERNAL_SIG_HEADER]: await signInternal(this.secret, body, Date.now()) },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!res.ok) throw new Error(`${path} answered ${res.status}`);
		return res.json();
	}
}
