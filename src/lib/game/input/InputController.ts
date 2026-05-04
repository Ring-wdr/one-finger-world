import type { ComboStep, Direction2, InputGesture, MoveMode } from '$lib/game/types';

export interface PointerSurface {
	addEventListener(type: string, listener: (event: PointerEvent) => void): void;
	removeEventListener(type: string, listener: (event: PointerEvent) => void): void;
	setPointerCapture?(pointerId: number): void;
	releasePointerCapture?(pointerId: number): void;
}

interface InputThresholds {
	tapMs: number;
	dragStartPx: number;
	runHoldMs: number;
	runDistancePx: number;
	fastDragPxPerMs: number;
	dashWindowMs: number;
}

const DEFAULT_THRESHOLDS: InputThresholds = {
	tapMs: 180,
	dragStartPx: 14,
	runHoldMs: 450,
	runDistancePx: 72,
	fastDragPxPerMs: 0.9,
	dashWindowMs: 320
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
}

export class InputController {
	private active: ActivePointer | null = null;
	private comboStep: ComboStep = 1;
	private lastFastDragTime: number | null = null;
	private disposed = false;

	constructor(
		private readonly target: PointerSurface,
		private readonly emit: (gesture: InputGesture) => void,
		private readonly thresholds: InputThresholds = DEFAULT_THRESHOLDS
	) {
		this.target.addEventListener('pointerdown', this.handlePointerDown);
		this.target.addEventListener('pointermove', this.handlePointerMove);
		this.target.addEventListener('pointerup', this.handlePointerUp);
		this.target.addEventListener('pointercancel', this.handlePointerCancel);
		this.target.addEventListener('lostpointercapture', this.handleLostPointerCapture);
	}

	update(now: number) {
		if (!this.active?.dragging || this.disposed) return;

		const nextMode = this.getMoveMode(this.active, now);
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
			lastMode: null
		};

		this.target.setPointerCapture?.(event.pointerId);
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
		const mode = this.getMoveMode(active, event.timeStamp);
		active.lastMode = mode;
		this.emit({ type: 'move', mode, direction: active.lastDirection });
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

		if (!active.dragging) {
			this.releaseActivePointer();
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
		const speed = distance / Math.max(1, duration);
		this.releaseActivePointer();
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
		if (!this.getMatchingActivePointer(event)) return;
		this.releaseActivePointer();
		this.active = null;
		this.emit({ type: 'idle' });
	};

	private readonly handleLostPointerCapture = (event: PointerEvent) => {
		if (!this.getMatchingActivePointer(event)) return;
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

	private getMoveMode(active: ActivePointer, now: number): MoveMode {
		const distance = this.distanceFromStart(active);
		const dragStartTime = active.dragStartTime ?? active.startTime;
		const heldLongEnough = now - dragStartTime >= this.thresholds.runHoldMs;
		const draggedFarEnough = distance >= this.thresholds.runDistancePx;

		return heldLongEnough || draggedFarEnough ? 'run' : 'walk';
	}
}

function normalizeSignedZero(direction: Direction2): Direction2 {
	return {
		x: direction.x === 0 ? 0 : direction.x,
		y: direction.y === 0 ? 0 : direction.y
	};
}
