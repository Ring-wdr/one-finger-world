/** Placeholder for contract functions whose implementation is a pending task. */
export function todo(task: string, ..._args: unknown[]): never {
	throw new Error(`not implemented yet (${task})`);
}
