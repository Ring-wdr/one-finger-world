import type { Status } from './types';

export function newStatus(): Status {
	return {
		burnTime: 0,
		burnDps: 0,
		burnSrc: -1,
		bleedStacks: 0,
		bleedTime: 0,
		bleedPerStack: 0,
		bleedSrc: -1
	};
}
