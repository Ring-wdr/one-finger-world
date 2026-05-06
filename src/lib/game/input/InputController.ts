import type {
	ComboStep,
	Direction2,
	InputFeedbackEvent,
	InputFeedbackHandler,
	InputGesture,
	MoveMode,
	ScreenPoint,
	SkillButtonFeedback,
	SkillSlot
} from '$lib/game/types';

export interface PointerSurface {
	addEventListener(type: string, listener: (event: PointerEvent) => void): void;
	removeEventListener(type: string, listener: (event: PointerEvent) => void): void;
	setPointerCapture?(pointerId: number): void;
	releasePointerCapture?(pointerId: number): void;
}

interface InputThresholds {
	tapMs: number;
	dragStartPx: number;
	runDistancePx: number;
	fastDragPxPerMs: number;
	dashWindowMs: number;
}

const DEFAULT_THRESHOLDS: InputThresholds = {
	tapMs: 180,
	dragStartPx: 14,
	runDistancePx: 72,
	fastDragPxPerMs: 0.9,
	dashWindowMs: 320
};

const SKILL_BUTTON_DISTANCE_PX = 112;
const SKILL_BUTTON_RADIUS_PX = 24;
const SKILL_BUTTON_DIRECTIONS: Record<SkillSlot, Direction2> = {
	1: { x: 1, y: -1 },
	2: { x: -1, y: -1 },
	3: { x: 1, y: 1 },
	4: { x: -1, y: 1 }
};

interface ActivePointer {
	pointerId: number;
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
	startTime: number;
	dragStartTime: number | null;
	dragging: boolean;
	lastDirection: Direction2;
	lastMode: MoveMode | null;
	skillButtons: SkillButtonFeedback[];
	triggeredSkillSlots: Set<SkillSlot>;
	skillButtonsVisible: boolean;
}

export class InputController {
	private active: ActivePointer | null = null;
	private comboStep: ComboStep = 1;
	private lastFastDragTime: number | null = null;
	private disposed = false;

	constructor(
		private readonly target: PointerSurface,
		private readonly emit: (gesture: InputGesture) => void,
		private readonly thresholds: InputThresholds = DEFAULT_THRESHOLDS,
		private readonly emitFeedback: InputFeedbackHandler = () => undefined
	) {
		this.target.addEventListener('pointerdown', this.handlePointerDown);
		this.target.addEventListener('pointermove', this.handlePointerMove);
		this.target.addEventListener('pointerup', this.handlePointerUp);
		this.target.addEventListener('pointercancel', this.handlePointerCancel);
		this.target.addEventListener('lostpointercapture', this.handleLostPointerCapture);
	}

	update() {
		if (!this.active?.dragging || this.disposed) return;

		const nextMode = this.getMoveMode(this.active);
		if (nextMode !== this.active.lastMode) {
			this.active.lastMode = nextMode;
			this.emit({ type: 'move', mode: nextMode, direction: this.active.lastDirection });
		}
	}

	dispose() {
		if (this.disposed) return;

		this.releaseActivePointer();
		this.target.removeEventListener('pointerdown', this.handlePointerDown);
		this.target.removeEventListener('pointermove', this.handlePointerMove);
		this.target.removeEventListener('pointerup', this.handlePointerUp);
		this.target.removeEventListener('pointercancel', this.handlePointerCancel);
		this.target.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
		this.active = null;
		this.disposed = true;
	}

	private readonly handlePointerDown = (event: PointerEvent) => {
		if (this.disposed) return;
		if (event.button !== undefined && event.button !== 0) return;
		if (this.active) return;

		event.preventDefault();
		this.active = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			currentX: event.clientX,
			currentY: event.clientY,
			startTime: event.timeStamp,
			dragStartTime: null,
			dragging: false,
			lastDirection: { x: 0, y: 1 },
			lastMode: null,
			skillButtons: this.createSkillButtons(event.clientX, event.clientY),
			triggeredSkillSlots: new Set<SkillSlot>(),
			skillButtonsVisible: true
		};

		this.target.setPointerCapture?.(event.pointerId);
		this.safeEmitFeedback({
			type: 'press',
			start: this.pointFromEvent(event),
			thumb: this.pointFromEvent(event),
			timeStamp: event.timeStamp
		});
		this.safeEmitFeedback({
			type: 'skill-buttons',
			buttons: this.active.skillButtons,
			timeStamp: event.timeStamp
		});
	};

	private readonly handlePointerMove = (event: PointerEvent) => {
		const active = this.getMatchingActivePointer(event);
		if (!active) return;

		event.preventDefault();
		active.currentX = event.clientX;
		active.currentY = event.clientY;

		const distance = this.distanceFromStart(active);
		if (!active.dragging && distance >= this.thresholds.dragStartPx) {
			active.dragging = true;
			active.dragStartTime = event.timeStamp;
		}

		if (!active.dragging) return;

		active.lastDirection = this.directionFromStart(active);
		const mode = this.getMoveMode(active);
		this.safeEmitFeedback({
			type: 'drag',
			start: this.startPoint(active),
			thumb: this.thumbPoint(active),
			direction: active.lastDirection,
			mode,
			timeStamp: event.timeStamp
		});
		active.lastMode = mode;
		this.emit({ type: 'move', mode, direction: active.lastDirection });
		this.emitSkillIfNeeded(active, event.timeStamp);
	};

	private readonly handlePointerUp = (event: PointerEvent) => {
		const active = this.getMatchingActivePointer(event);
		if (!active) return;

		event.preventDefault();
		active.currentX = event.clientX;
		active.currentY = event.clientY;

		const duration = event.timeStamp - active.startTime;
		const distance = this.distanceFromStart(active);

		if (!active.dragging && distance >= this.thresholds.dragStartPx) {
			active.dragging = true;
			active.dragStartTime = event.timeStamp;
		}

		const releaseFeedback = {
			type: 'release' as const,
			start: this.startPoint(active),
			thumb: this.thumbPoint(active),
			wasDragging: active.dragging,
			timeStamp: event.timeStamp
		};

		if (!active.dragging) {
			this.hideSkillButtons(active, event.timeStamp);
			this.releaseActivePointer();
			this.safeEmitFeedback(releaseFeedback);
			this.active = null;

			if (duration <= this.thresholds.tapMs && distance < this.thresholds.dragStartPx) {
				const comboStep = this.comboStep;
				this.comboStep = this.comboStep === 3 ? 1 : ((this.comboStep + 1) as ComboStep);
				this.emit({ type: 'attack', comboStep });
			} else {
				this.emit({ type: 'idle' });
			}
			return;
		}

		const direction = this.directionFromStart(active);
		const dragDuration = event.timeStamp - (active.dragStartTime ?? active.startTime);
		const speed = distance / Math.max(1, dragDuration);
		this.hideSkillButtons(active, event.timeStamp);
		this.releaseActivePointer();
		this.safeEmitFeedback(releaseFeedback);
		this.active = null;

		if (speed >= this.thresholds.fastDragPxPerMs) {
			if (
				this.lastFastDragTime !== null &&
				event.timeStamp - this.lastFastDragTime <= this.thresholds.dashWindowMs
			) {
				this.lastFastDragTime = null;
				this.emit({ type: 'dash', direction });
				return;
			}

			this.lastFastDragTime = event.timeStamp;
		}

		this.emit({ type: 'idle' });
	};

	private readonly handlePointerCancel = (event: PointerEvent) => {
		const active = this.getMatchingActivePointer(event);
		if (!active) return;

		active.currentX = event.clientX;
		active.currentY = event.clientY;

		this.safeEmitFeedback({
			type: 'cancel',
			start: this.startPoint(active),
			thumb: this.thumbPoint(active),
			wasDragging: active.dragging,
			timeStamp: event.timeStamp
		});
		this.hideSkillButtons(active, event.timeStamp);
		this.releaseActivePointer();
		this.active = null;
		this.emit({ type: 'idle' });
	};

	private readonly handleLostPointerCapture = (event: PointerEvent) => {
		const active = this.getMatchingActivePointer(event);
		if (!active) return;

		active.currentX = event.clientX;
		active.currentY = event.clientY;

		this.safeEmitFeedback({
			type: 'cancel',
			start: this.startPoint(active),
			thumb: this.thumbPoint(active),
			wasDragging: active.dragging,
			timeStamp: event.timeStamp
		});
		this.hideSkillButtons(active, event.timeStamp);
		this.releaseActivePointer();
		this.active = null;
		this.emit({ type: 'idle' });
	};

	private getMatchingActivePointer(event: PointerEvent) {
		if (this.disposed || !this.active || this.active.pointerId !== event.pointerId) {
			return null;
		}

		return this.active;
	}

	private releaseActivePointer() {
		if (!this.active) return;
		this.target.releasePointerCapture?.(this.active.pointerId);
	}

	private pointFromEvent(event: PointerEvent): ScreenPoint {
		return { x: event.clientX, y: event.clientY };
	}

	private startPoint(active: ActivePointer): ScreenPoint {
		return { x: active.startX, y: active.startY };
	}

	private thumbPoint(active: ActivePointer): ScreenPoint {
		return { x: active.currentX, y: active.currentY };
	}

	private safeEmitFeedback(event: InputFeedbackEvent) {
		try {
			this.emitFeedback(event);
		} catch {
			// Visual feedback must not interrupt gameplay input handling.
		}
	}

	private hideSkillButtons(active: ActivePointer, timeStamp: number) {
		if (!active.skillButtonsVisible) return;

		active.skillButtonsVisible = false;
		this.safeEmitFeedback({
			type: 'skill-buttons-hidden',
			timeStamp
		});
	}

	private createSkillButtons(startX: number, startY: number): SkillButtonFeedback[] {
		return ([1, 2, 3, 4] as SkillSlot[]).map((slot) => {
			const direction = SKILL_BUTTON_DIRECTIONS[slot];
			return {
				slot,
				center: {
					x: startX + direction.x * SKILL_BUTTON_DISTANCE_PX,
					y: startY + direction.y * SKILL_BUTTON_DISTANCE_PX
				},
				radius: SKILL_BUTTON_RADIUS_PX
			};
		});
	}

	private emitSkillIfNeeded(active: ActivePointer, timeStamp: number) {
		for (const button of active.skillButtons) {
			if (active.triggeredSkillSlots.has(button.slot)) continue;
			if (!this.isThumbInsideSkillButton(active, button)) continue;

			active.triggeredSkillSlots.add(button.slot);
			this.hideSkillButtons(active, timeStamp);
			this.emit({ type: 'skill', slot: button.slot });
			return;
		}
	}

	private isThumbInsideSkillButton(active: ActivePointer, button: SkillButtonFeedback) {
		return (
			Math.hypot(active.currentX - button.center.x, active.currentY - button.center.y) <=
			button.radius
		);
	}

	private distanceFromStart(active: ActivePointer) {
		return Math.hypot(active.currentX - active.startX, active.currentY - active.startY);
	}

	private directionFromStart(active: ActivePointer): Direction2 {
		const dx = active.currentX - active.startX;
		const dy = active.currentY - active.startY;
		const length = Math.hypot(dx, dy);

		if (length === 0) return { x: 0, y: 1 };

		return normalizeSignedZero({ x: dx / length, y: -dy / length });
	}

	private getMoveMode(active: ActivePointer): MoveMode {
		const distance = this.distanceFromStart(active);
		const draggedFarEnough = distance >= this.thresholds.runDistancePx;

		return draggedFarEnough ? 'run' : 'walk';
	}
}

function normalizeSignedZero(direction: Direction2): Direction2 {
	return {
		x: direction.x === 0 ? 0 : direction.x,
		y: direction.y === 0 ? 0 : direction.y
	};
}
