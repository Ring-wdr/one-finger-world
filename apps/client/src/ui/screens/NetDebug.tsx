import type { NetStats } from '../../net/onlineMatch';

const ms = (v: number | null) => (v === null ? '-' : `${Math.round(v)}ms`);

/** `?net=1` overlay: what the netcode measures, for tuning and bug reports. */
export function NetDebug({ stats }: { stats: NetStats }) {
	return (
		<pre class="net-debug">
			{`rtt p50 ${ms(stats.rttP50)} p95 ${ms(stats.rttP95)}
jitter ${ms(stats.jitterMs)}
input queue ${stats.inputQueue}
snapshots/s ${stats.snapshotsPerSecond}
tick ${stats.tickMs.toFixed(1)}ms`}
		</pre>
	);
}
