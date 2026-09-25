export type ComboStep = 1 | 2 | 3;

export type MoveMode = 'walk' | 'run';

export interface Direction2 {
	x: number;
	y: number;
}

export interface ScreenPoint {
	x: number;
	y: number;
}

export type InputGesture =
	| { type: 'attack'; comboStep: ComboStep }
	| { type: 'move'; mode: MoveMode; direction: Direction2 }
	| { type: 'dash'; direction: Direction2 }
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
	  };

export type InputFeedbackHandler = (event: InputFeedbackEvent) => void;
