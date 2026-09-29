import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DATA_HASH, PROTOCOL_VERSION, type HealthResponse } from '@ofa/net';

describe('GET /api/health', () => {
	it('reports the protocol version and data hash the client must match', async () => {
		const res = await exports.default.fetch('http://test/api/health');
		expect(res.status).toBe(200);
		expect(await res.json<HealthResponse>()).toEqual({ ok: true, protocol: PROTOCOL_VERSION, dataHash: DATA_HASH });
	});
});
