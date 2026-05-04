export type ComboStep = 1 | 2 | 3;

export type ActionKind = 'idle' | 'walk' | 'run' | 'attack' | 'dash';

export interface Direction2 {
	x: number;
	y: number;
}

export interface ActionState {
	kind: ActionKind;
	label: string;
	direction?: Direction2;
	comboStep?: ComboStep;
}

export type MoveMode = 'walk' | 'run';

export type InputGesture =
	| { type: 'attack'; comboStep: ComboStep }
	| { type: 'move'; mode: MoveMode; direction: Direction2 }
	| { type: 'dash'; direction: Direction2 }
	| { type: 'idle' };

export type ActionStateHandler = (state: ActionState) => void;
export type RuntimeErrorHandler = (message: string) => void;

export const IDLE_ACTION: ActionState = { kind: 'idle', label: 'Idle' };
