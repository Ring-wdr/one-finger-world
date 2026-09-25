export type ComboStep = 1 | 2 | 3;
export type SkillSlot = 1 | 2 | 3 | 4;

export type MoveMode = 'walk' | 'run';

export interface Direction2 {
	x: number;
	y: number;
}

export interface ScreenPoint {
	x: number;
	y: number;
}

export interface SkillButtonFeedback {
	slot: SkillSlot;
	center: ScreenPoint;
	radius: number;
}

export type InputGesture =
	| { type: 'attack'; comboStep: ComboStep }
	| { type: 'move'; mode: MoveMode; direction: Direction2 }
	| { type: 'dash'; direction: Direction2 }
	| { type: 'skill'; slot: SkillSlot }
	| { type: 'idle' };

export type InputFeedbackEvent =
	| { type: 'press'; start: ScreenPoint; thumb: ScreenPoint; timeStamp: number }
	| {
			type: 'drag';
			start: ScreenPoint;
			thumb: ScreenPoint;
			direction: Direction2;
			mode: MoveMode;
			timeStamp: number;
	  }
	| {
			type: 'release';
			start: ScreenPoint;
			thumb: ScreenPoint;
			wasDragging: boolean;
			timeStamp: number;
	  }
	| {
			type: 'cancel';
			start: ScreenPoint;
			thumb: ScreenPoint;
			wasDragging: boolean;
			timeStamp: number;
	  }
	| { type: 'skill-buttons'; buttons: SkillButtonFeedback[]; timeStamp: number }
	| { type: 'skill-buttons-hidden'; timeStamp: number };

export type InputFeedbackHandler = (event: InputFeedbackEvent) => void;
