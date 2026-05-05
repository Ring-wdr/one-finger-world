import type { InputFeedbackEvent, InputGesture, ScreenPoint } from '$lib/game/types';
import * as THREE from 'three';
import { isThumbPointVisible } from './feedbackPhysics';

export interface ScreenInputFeedbackEvent {
	event: InputFeedbackEvent;
	startScreen: ScreenPoint;
	thumbScreen: ScreenPoint;
}

const START_ANCHOR_COLOR = 0xf6d365;
const THUMB_TARGET_COLOR = 0x7dd3fc;
const TETHER_COLOR = 0xe0f2fe;
const DASH_COLOR = 0x93c5fd;
const ATTACK_COLOR = 0xfff7ad;
const WORLD_GROUND_Y = 0.035;
const SCREEN_Z = 0;
const THUMB_SPRING_STIFFNESS = 130;
const THUMB_SPRING_DAMPING = 19;

export class PhysicsFeedbackActor {
	readonly group = new THREE.Group();
	readonly worldGroup = new THREE.Group();

	private readonly startAnchor: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly thumbTarget: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly tether: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private readonly runHalo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly dashWave: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly attackPulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly geometries: THREE.BufferGeometry[] = [];
	private readonly materials: THREE.Material[] = [];
	private readonly startScreen = new THREE.Vector3();
	private readonly thumbTargetScreen = new THREE.Vector3();
	private readonly thumbVisualScreen = new THREE.Vector3();
	private readonly thumbVelocity = new THREE.Vector3();
	private readonly scratch = new THREE.Vector3();
	private viewportWidth = 1;
	private viewportHeight = 1;
	private active = false;
	private thumbVisible = false;
	private runIntensity = 0;
	private runVelocity = 0;
	private dashWaveAge = 1;
	private attackPulseAge = 1;

	constructor() {
		this.group.name = 'PhysicsFeedbackActor';
		this.worldGroup.name = 'PhysicsFeedbackWorldActor';

		this.startAnchor = this.createScreenRing('start-anchor', START_ANCHOR_COLOR, 24, 34, 0.75);
		this.thumbTarget = this.createScreenRing('thumb-target', THUMB_TARGET_COLOR, 18, 28, 0.72);
		this.runHalo = this.createScreenRing('run-halo', TETHER_COLOR, 42, 50, 0.36);
		this.dashWave = this.createGroundRing('dash-wave', DASH_COLOR, 0.34, 0.42, 0);
		this.attackPulse = this.createGroundRing('attack-pulse', ATTACK_COLOR, 0.42, 0.5, 0);

		const tetherGeometry = this.trackGeometry(new THREE.PlaneGeometry(1, 7));
		const tetherMaterial = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color: TETHER_COLOR,
				opacity: 0.5,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);
		this.tether = new THREE.Mesh(tetherGeometry, tetherMaterial);
		this.tether.name = 'feedback-tether';
		this.tether.visible = false;
		this.group.add(this.tether);

		this.startAnchor.visible = false;
		this.thumbTarget.visible = false;
		this.runHalo.visible = false;
		this.dashWave.visible = false;
		this.attackPulse.visible = false;
		this.runHalo.scale.setScalar(0);
		this.dashWave.scale.setScalar(0);
		this.attackPulse.scale.setScalar(0);
	}

	setViewportSize(width: number, height: number) {
		this.viewportWidth = Math.max(1, width);
		this.viewportHeight = Math.max(1, height);
	}

	handlePointerFeedback({ event, startScreen, thumbScreen }: ScreenInputFeedbackEvent) {
		this.screenPointToLayer(startScreen, this.startScreen);
		this.screenPointToLayer(thumbScreen, this.thumbTargetScreen);

		if (event.type === 'press') {
			this.active = true;
			this.thumbVisible = false;
			this.resetRunHalo();
			this.thumbVisualScreen.copy(this.thumbTargetScreen);
			this.thumbVelocity.set(0, 0, 0);
			this.startAnchor.visible = true;
			this.startAnchor.scale.setScalar(0.72);
			this.placeScreenObject(this.startAnchor, this.startScreen);
			this.hideThumbAndTether();
			return;
		}

		if (event.type === 'drag') {
			this.active = true;
			this.thumbVisible = isThumbPointVisible(event.start, event.thumb);
			this.runIntensity = event.mode === 'run' ? 1 : 0.35;
			this.startAnchor.visible = true;
			this.placeScreenObject(this.startAnchor, this.startScreen);
			return;
		}

		if (event.type === 'release' || event.type === 'cancel') {
			this.active = false;
			this.runIntensity = 0;
			this.thumbVisible = false;
		}
	}

	handleGesture(gesture: InputGesture, playerWorld: THREE.Vector3) {
		if (gesture.type === 'move') {
			if (this.active) {
				this.runIntensity = gesture.mode === 'run' ? 1 : 0.35;
			}
			return;
		}

		if (gesture.type === 'dash') {
			this.dashWaveAge = 0;
			this.placeGroundObject(this.dashWave, playerWorld);
			this.dashWave.scale.setScalar(1);
			this.dashWave.material.opacity = 0.68;
			this.dashWave.visible = true;
			return;
		}

		if (gesture.type === 'attack') {
			this.attackPulseAge = 0;
			this.placeGroundObject(this.attackPulse, playerWorld);
			this.attackPulse.scale.setScalar(0.8);
			this.attackPulse.material.opacity = 0.58;
			this.attackPulse.visible = true;
		}
	}

	update(deltaSeconds: number) {
		const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, 0.05)) : 0;
		this.updateAnchor(dt);
		this.updateThumb(dt);
		this.updateTether();
		this.updateRunHalo(dt);
		this.updateDashWave(dt);
		this.updateAttackPulse(dt);
	}

	dispose() {
		this.group.removeFromParent();
		this.group.clear();
		this.worldGroup.removeFromParent();
		this.worldGroup.clear();

		for (const geometry of this.geometries) geometry.dispose();
		for (const material of this.materials) material.dispose();
	}

	private updateAnchor(deltaSeconds: number) {
		if (!this.startAnchor.visible) return;

		const targetScale = this.active ? 1 : 0.92;
		const scale = THREE.MathUtils.damp(this.startAnchor.scale.x, targetScale, 18, deltaSeconds);
		this.startAnchor.scale.setScalar(scale);

		const material = this.startAnchor.material;
		material.opacity = THREE.MathUtils.damp(material.opacity, this.active ? 0.75 : 0, 10, deltaSeconds);
		if (!this.active && material.opacity < 0.02) this.startAnchor.visible = false;
	}

	private updateThumb(deltaSeconds: number) {
		if (!this.thumbVisible) {
			this.thumbTarget.material.opacity = THREE.MathUtils.damp(
				this.thumbTarget.material.opacity,
				0,
				14,
				deltaSeconds
			);
			if (this.thumbTarget.material.opacity < 0.02) this.thumbTarget.visible = false;
			return;
		}

		this.springVector(
			this.thumbVisualScreen,
			this.thumbTargetScreen,
			this.thumbVelocity,
			deltaSeconds
		);
		this.placeScreenObject(this.thumbTarget, this.thumbVisualScreen);
		this.thumbTarget.visible = true;
		this.thumbTarget.material.opacity = THREE.MathUtils.damp(
			this.thumbTarget.material.opacity,
			0.72,
			16,
			deltaSeconds
		);
	}

	private updateTether() {
		if (!this.thumbVisible || !this.thumbTarget.visible) {
			this.tether.visible = false;
			return;
		}

		this.scratch.copy(this.thumbVisualScreen).sub(this.startScreen);
		const length = Math.hypot(this.scratch.x, this.scratch.y);
		if (length < 0.08) {
			this.tether.visible = false;
			return;
		}

		this.tether.visible = true;
		this.tether.position.set(
			(this.startScreen.x + this.thumbVisualScreen.x) * 0.5,
			(this.startScreen.y + this.thumbVisualScreen.y) * 0.5,
			SCREEN_Z
		);
		this.tether.scale.set(length, 1, 1);
		this.tether.rotation.z = Math.atan2(this.scratch.y, this.scratch.x);
		this.tether.material.opacity = THREE.MathUtils.clamp(length / 2.5, 0.18, 0.62);
	}

	private updateRunHalo(deltaSeconds: number) {
		const target = this.active ? this.runIntensity : 0;
		const acceleration = (target - this.runHalo.scale.x) * 140 - this.runVelocity * 20;
		this.runVelocity += acceleration * deltaSeconds;
		const next = Math.max(0, this.runHalo.scale.x + this.runVelocity * deltaSeconds);
		this.runHalo.scale.setScalar(next);
		this.runHalo.visible = next > 0.05;
		this.runHalo.material.opacity = THREE.MathUtils.clamp(next * 0.42, 0, 0.42);
		this.placeScreenObject(this.runHalo, this.startScreen);
	}

	private updateDashWave(deltaSeconds: number) {
		if (!this.dashWave.visible) return;

		this.dashWaveAge += deltaSeconds / 0.34;
		const progress = THREE.MathUtils.clamp(this.dashWaveAge, 0, 1);
		this.dashWave.scale.setScalar(1 + progress * 3.2);
		this.dashWave.material.opacity = (1 - progress) * 0.68;
		if (progress >= 1) this.dashWave.visible = false;
	}

	private updateAttackPulse(deltaSeconds: number) {
		if (!this.attackPulse.visible) return;

		this.attackPulseAge += deltaSeconds / 0.24;
		const progress = THREE.MathUtils.clamp(this.attackPulseAge, 0, 1);
		this.attackPulse.scale.setScalar(0.8 + progress * 1.2);
		this.attackPulse.material.opacity = (1 - progress) * 0.58;
		if (progress >= 1) this.attackPulse.visible = false;
	}

	private springVector(
		current: THREE.Vector3,
		target: THREE.Vector3,
		velocity: THREE.Vector3,
		deltaSeconds: number
	) {
		velocity.x +=
			((target.x - current.x) * THUMB_SPRING_STIFFNESS - velocity.x * THUMB_SPRING_DAMPING) *
			deltaSeconds;
		velocity.y +=
			((target.y - current.y) * THUMB_SPRING_STIFFNESS - velocity.y * THUMB_SPRING_DAMPING) *
			deltaSeconds;
		current.x += velocity.x * deltaSeconds;
		current.y += velocity.y * deltaSeconds;
		current.z = SCREEN_Z;
	}

	private resetRunHalo() {
		this.runIntensity = 0;
		this.runVelocity = 0;
		this.runHalo.scale.setScalar(0);
		this.runHalo.material.opacity = 0;
		this.runHalo.visible = false;
	}

	private hideThumbAndTether() {
		this.thumbTarget.visible = false;
		this.tether.visible = false;
	}

	private createScreenRing(
		name: string,
		color: number,
		innerRadius: number,
		outerRadius: number,
		opacity: number
	) {
		const geometry = this.trackGeometry(new THREE.RingGeometry(innerRadius, outerRadius, 48));
		const material = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color,
				opacity,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = name;
		this.group.add(mesh);
		return mesh;
	}

	private createGroundRing(
		name: string,
		color: number,
		innerRadius: number,
		outerRadius: number,
		opacity: number
	) {
		const geometry = this.trackGeometry(new THREE.RingGeometry(innerRadius, outerRadius, 48));
		const material = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color,
				opacity,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = name;
		mesh.rotation.x = -Math.PI / 2;
		this.worldGroup.add(mesh);
		return mesh;
	}

	private screenPointToLayer(point: ScreenPoint, target: THREE.Vector3) {
		return target.set(point.x - this.viewportWidth * 0.5, this.viewportHeight * 0.5 - point.y, SCREEN_Z);
	}

	private placeScreenObject(object: THREE.Object3D, position: THREE.Vector3) {
		object.position.set(position.x, position.y, SCREEN_Z);
	}

	private placeGroundObject(object: THREE.Object3D, position: THREE.Vector3) {
		object.position.set(position.x, WORLD_GROUND_Y, position.z);
	}

	private trackGeometry<T extends THREE.BufferGeometry>(geometry: T) {
		this.geometries.push(geometry);
		return geometry;
	}

	private trackMaterial<T extends THREE.Material>(material: T) {
		this.materials.push(material);
		return material;
	}
}
