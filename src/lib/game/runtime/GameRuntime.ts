import { PlayerActor } from '$lib/game/actors/PlayerActor';
import { PhysicsFeedbackActor } from '$lib/game/feedback/PhysicsFeedbackActor';
import { InputController } from '$lib/game/input/InputController';
import {
	IDLE_ACTION,
	type ActionState,
	type ActionStateHandler,
	type Direction2,
	type InputFeedbackEvent,
	type InputGesture,
	type MoveMode,
	type RuntimeErrorHandler
} from '$lib/game/types';
import { BlockWorld } from '$lib/game/world/BlockWorld';
import * as THREE from 'three';

interface GameRuntimeOptions {
	container: HTMLElement;
	onActionStateChange: ActionStateHandler;
	onRuntimeError: RuntimeErrorHandler;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_OFFSET = new THREE.Vector3(0, 5.8, -7.2);
const CAMERA_LOOK_OFFSET = new THREE.Vector3(0, 1.05, 0);
const CAMERA_DAMPING = 8;
const PLAYER_MARGIN = 0.35;
const WALK_SPEED = 2.8;
const RUN_SPEED = 4.8;
const DASH_SPEED = 11;
const DASH_DURATION_SECONDS = 0.18;
const ATTACK_FEEDBACK_SECONDS = 0.28;
const MAX_DELTA_SECONDS = 0.05;

export class GameRuntime {
	private readonly container: HTMLElement;
	private onActionStateChange: ActionStateHandler | null;
	private onRuntimeError: RuntimeErrorHandler | null;
	private renderer: THREE.WebGLRenderer | null = null;
	private scene: THREE.Scene | null = null;
	private feedbackScene: THREE.Scene | null = null;
	private camera: THREE.PerspectiveCamera | null = null;
	private feedbackCamera: THREE.OrthographicCamera | null = null;
	private input: InputController | null = null;
	private player: PlayerActor | null = null;
	private feedback: PhysicsFeedbackActor | null = null;
	private world: BlockWorld | null = null;
	private animationFrame: number | null = null;
	private resizeListener: (() => void) | null = null;
	private disposed = false;
	private previousTime = 0;
	private movementMode: MoveMode | null = null;
	private readonly movementDirection = new THREE.Vector3();
	private readonly latestDirection = new THREE.Vector3(0, 0, 1);
	private readonly dashDirection = new THREE.Vector3();
	private dashRemainingSeconds = 0;
	private attackRemainingSeconds = 0;
	private lastPublishedLabel: string | null = null;
	private readonly cameraTarget = new THREE.Vector3();
	private readonly desiredCameraPosition = new THREE.Vector3();
	private readonly cameraForward = new THREE.Vector3();
	private readonly cameraRight = new THREE.Vector3();
	private readonly convertedDirection = new THREE.Vector3();
	private readonly feedbackStartScreen = { x: 0, y: 0 };
	private readonly feedbackThumbScreen = { x: 0, y: 0 };

	constructor({ container, onActionStateChange, onRuntimeError }: GameRuntimeOptions) {
		this.container = container;
		this.onActionStateChange = onActionStateChange;
		this.onRuntimeError = onRuntimeError;

		try {
			this.initialize();
		} catch (error) {
			const notifyRuntimeError = this.onRuntimeError;
			const message = getRuntimeErrorMessage(error);
			this.dispose();
			notifyRuntimeError?.(message);
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;

		if (this.animationFrame !== null) {
			window.cancelAnimationFrame(this.animationFrame);
			this.animationFrame = null;
		}

		if (this.resizeListener) {
			window.removeEventListener('resize', this.resizeListener);
			this.resizeListener = null;
		}

		this.input?.dispose();
		this.input = null;

		this.feedback?.dispose();
		this.feedback = null;

		this.player?.dispose();
		this.player = null;

		this.world?.dispose();
		this.world = null;

		this.scene?.clear();
		this.scene = null;
		this.feedbackScene?.clear();
		this.feedbackScene = null;
		this.camera = null;
		this.feedbackCamera = null;

		const renderer = this.renderer;
		if (renderer) {
			const canvas = renderer.domElement;
			renderer.dispose();
			if (canvas.parentElement === this.container) {
				this.container.removeChild(canvas);
			}
			this.renderer = null;
		}

		this.onActionStateChange = null;
		this.onRuntimeError = null;
	}

	private initialize() {
		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x9ec5df);
		this.scene = scene;

		const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 80);
		this.camera = camera;

		const feedbackScene = new THREE.Scene();
		this.feedbackScene = feedbackScene;

		const feedbackCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 10);
		feedbackCamera.position.z = 5;
		this.feedbackCamera = feedbackCamera;

		const hemisphereLight = new THREE.HemisphereLight(0xb9dcff, 0x52645a, 1.9);
		scene.add(hemisphereLight);

		const directionalLight = new THREE.DirectionalLight(0xfff2d0, 2.4);
		directionalLight.position.set(4, 8, -5);
		scene.add(directionalLight);

		const world = new BlockWorld();
		this.world = world;
		scene.add(world.group);

		const player = new PlayerActor();
		this.player = player;
		player.setPosition(new THREE.Vector3(0, 0, 0));
		player.faceWorldDirection(this.latestDirection);
		scene.add(player.group);

		const feedback = new PhysicsFeedbackActor();
		this.feedback = feedback;
		scene.add(feedback.worldGroup);
		feedbackScene.add(feedback.group);

		const renderer = new THREE.WebGLRenderer({
			antialias: true,
			preserveDrawingBuffer: true
		});
		renderer.autoClear = false;
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.domElement.style.touchAction = 'none';
		this.renderer = renderer;
		this.container.appendChild(renderer.domElement);

		this.input = new InputController(
			renderer.domElement,
			this.handleGesture,
			undefined,
			this.handleInputFeedback
		);
		this.resizeListener = this.handleResize;
		window.addEventListener('resize', this.resizeListener);
		this.handleResize();
		this.snapCameraToPlayer();
		this.publishAction(IDLE_ACTION);

		this.previousTime = performance.now();
		this.animationFrame = window.requestAnimationFrame(this.tick);
	}

	private readonly tick = (now: number) => {
		if (this.disposed) return;

		const deltaSeconds = Math.min(
			MAX_DELTA_SECONDS,
			Math.max(0, (now - this.previousTime) / 1000)
		);
		this.previousTime = now;

		this.input?.update();
		this.updatePlayer(deltaSeconds);
		this.updateAttackState(deltaSeconds);
		this.feedback?.update(deltaSeconds);
		this.updateCamera(deltaSeconds);

		if (this.renderer && this.scene && this.camera) {
			this.renderer.clear();
			this.renderer.render(this.scene, this.camera);
			if (this.feedbackScene && this.feedbackCamera) {
				this.renderer.clearDepth();
				this.renderer.render(this.feedbackScene, this.feedbackCamera);
			}
		}

		this.animationFrame = window.requestAnimationFrame(this.tick);
	};

	private readonly handleResize = () => {
		if (this.disposed || !this.renderer || !this.camera) return;

		const bounds = this.container.getBoundingClientRect();
		const width = Math.max(1, Math.floor(bounds.width || this.container.clientWidth || 1));
		const height = Math.max(1, Math.floor(bounds.height || this.container.clientHeight || 1));

		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		if (this.feedbackCamera) {
			this.feedbackCamera.left = -width * 0.5;
			this.feedbackCamera.right = width * 0.5;
			this.feedbackCamera.top = height * 0.5;
			this.feedbackCamera.bottom = -height * 0.5;
			this.feedbackCamera.updateProjectionMatrix();
		}
		this.feedback?.setViewportSize(width, height);
	};

	private readonly handleGesture = (gesture: InputGesture) => {
		if (this.disposed) return;

		this.emitGestureFeedback(gesture);

		if (gesture.type === 'attack') {
			this.player?.playAttack(gesture.comboStep);
			this.attackRemainingSeconds = ATTACK_FEEDBACK_SECONDS;
			this.publishAction({
				kind: 'attack',
				label: `Attack ${gesture.comboStep}`,
				comboStep: gesture.comboStep
			});
			return;
		}

		if (gesture.type === 'move') {
			const direction = this.directionFromScreen(gesture.direction);
			this.attackRemainingSeconds = 0;
			this.movementDirection.copy(direction);
			this.latestDirection.copy(direction);
			this.movementMode = gesture.mode;
			this.player?.faceWorldDirection(direction);
			this.publishAction({
				kind: gesture.mode,
				label: gesture.mode === 'run' ? 'Run' : 'Walk',
				direction: gesture.direction
			});
			return;
		}

		if (gesture.type === 'dash') {
			const direction = this.directionFromScreen(gesture.direction);
			this.attackRemainingSeconds = 0;
			this.dashDirection.copy(direction.lengthSq() > 0 ? direction : this.latestDirection);
			this.latestDirection.copy(this.dashDirection);
			this.movementMode = null;
			this.dashRemainingSeconds = DASH_DURATION_SECONDS;
			this.player?.faceWorldDirection(this.dashDirection);
			this.publishAction({ kind: 'dash', label: 'Dash', direction: gesture.direction });
			return;
		}

		this.movementMode = null;
		if (this.dashRemainingSeconds <= 0 && this.attackRemainingSeconds <= 0) {
			this.publishAction(IDLE_ACTION);
		}
	};

	private emitGestureFeedback(gesture: InputGesture) {
		if (!this.player) return;

		try {
			this.feedback?.handleGesture(gesture, this.player.group.position);
		} catch {
			// Visual feedback must not block gameplay gesture handling.
		}
	}

	private readonly handleInputFeedback = (event: InputFeedbackEvent) => {
		if (this.disposed || !this.feedback || !this.renderer) return;

		if (event.type === 'skill-buttons' || event.type === 'skill-buttons-hidden') {
			this.feedback.handlePointerFeedback({
				event,
				startScreen: this.feedbackStartScreen,
				thumbScreen: this.feedbackThumbScreen
			});
			return;
		}

		this.clientPointToFeedbackScreen(event.start, this.feedbackStartScreen);
		this.clientPointToFeedbackScreen(event.thumb, this.feedbackThumbScreen);
		this.feedback.handlePointerFeedback({
			event,
			startScreen: this.feedbackStartScreen,
			thumbScreen: this.feedbackThumbScreen
		});
	};

	private clientPointToFeedbackScreen(
		point: { x: number; y: number },
		target: { x: number; y: number }
	) {
		if (!this.renderer) return target;
		const bounds = this.renderer.domElement.getBoundingClientRect();
		target.x = point.x - bounds.left;
		target.y = point.y - bounds.top;
		return target;
	}

	private updatePlayer(deltaSeconds: number) {
		if (!this.player || !this.world) return;

		const position = this.player.group.position;
		const isDashing = this.dashRemainingSeconds > 0;
		let isMoving = false;
		let isRunning = false;

		if (isDashing) {
			const dashStepSeconds = Math.min(deltaSeconds, this.dashRemainingSeconds);
			position.addScaledVector(this.dashDirection, DASH_SPEED * dashStepSeconds);
			this.dashRemainingSeconds = Math.max(0, this.dashRemainingSeconds - deltaSeconds);
			isMoving = true;
			isRunning = true;

			if (
				this.dashRemainingSeconds === 0 &&
				this.movementMode === null &&
				this.attackRemainingSeconds <= 0
			) {
				this.publishAction(IDLE_ACTION);
			}
		} else if (this.movementMode) {
			isMoving = true;
			isRunning = this.movementMode === 'run';
			position.addScaledVector(
				this.movementDirection,
				(isRunning ? RUN_SPEED : WALK_SPEED) * deltaSeconds
			);
		}

		this.world.clampPosition(position, PLAYER_MARGIN);
		this.player.setPosition(position);
		this.player.update(deltaSeconds, isMoving, isRunning, isDashing);
	}

	private updateAttackState(deltaSeconds: number) {
		if (this.attackRemainingSeconds <= 0) return;

		this.attackRemainingSeconds = Math.max(0, this.attackRemainingSeconds - deltaSeconds);
		if (
			this.attackRemainingSeconds === 0 &&
			this.movementMode === null &&
			this.dashRemainingSeconds <= 0
		) {
			this.publishAction(IDLE_ACTION);
		}
	}

	private updateCamera(deltaSeconds: number) {
		if (!this.camera || !this.player) return;

		this.setCameraVectors();
		const damping = 1 - Math.exp(-CAMERA_DAMPING * deltaSeconds);
		this.camera.position.lerp(this.desiredCameraPosition, damping);
		this.camera.lookAt(this.cameraTarget);
	}

	private snapCameraToPlayer() {
		if (!this.camera || !this.player) return;

		this.setCameraVectors();
		this.camera.position.copy(this.desiredCameraPosition);
		this.camera.lookAt(this.cameraTarget);
	}

	private setCameraVectors() {
		if (!this.player) return;

		this.cameraTarget.copy(this.player.group.position).add(CAMERA_LOOK_OFFSET);
		this.desiredCameraPosition.copy(this.player.group.position).add(CAMERA_OFFSET);
	}

	private directionFromScreen(direction: Direction2) {
		if (!this.camera) return this.convertedDirection.set(0, 0, 0);

		this.camera.getWorldDirection(this.cameraForward);
		this.cameraForward.y = 0;
		if (this.cameraForward.lengthSq() <= 0.000001) {
			this.cameraForward.set(0, 0, 1);
		} else {
			this.cameraForward.normalize();
		}

		this.cameraRight.crossVectors(this.cameraForward, WORLD_UP);
		if (this.cameraRight.lengthSq() <= 0.000001) {
			this.cameraRight.set(1, 0, 0);
		} else {
			this.cameraRight.normalize();
		}

		this.convertedDirection
			.copy(this.cameraRight)
			.multiplyScalar(direction.x)
			.addScaledVector(this.cameraForward, direction.y);

		if (this.convertedDirection.lengthSq() <= 0.000001) {
			return this.convertedDirection.set(0, 0, 0);
		}

		return this.convertedDirection.normalize();
	}

	private publishAction(state: ActionState) {
		if (this.disposed) return;
		if (state.label === this.lastPublishedLabel) return;

		this.lastPublishedLabel = state.label;
		this.onActionStateChange?.(state);
	}
}

function getRuntimeErrorMessage(error: unknown) {
	if (error instanceof Error && error.message) {
		return `Unable to start 3D runtime: ${error.message}`;
	}

	return 'Unable to start 3D runtime.';
}
