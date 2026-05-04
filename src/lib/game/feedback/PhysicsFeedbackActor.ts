import type { InputFeedbackEvent, InputGesture } from '$lib/game/types';
import * as THREE from 'three';
import { isThumbPointVisible } from './feedbackPhysics';

export interface WorldInputFeedbackEvent {
	event: InputFeedbackEvent;
	startWorld: THREE.Vector3;
	thumbWorld: THREE.Vector3;
}

const START_ANCHOR_COLOR = 0xf6d365;
const THUMB_TARGET_COLOR = 0x7dd3fc;
const TETHER_COLOR = 0xe0f2fe;
const DASH_COLOR = 0x93c5fd;
const ATTACK_COLOR = 0xfff7ad;
const GROUND_Y = 0.035;

export class PhysicsFeedbackActor {
	readonly group = new THREE.Group();

	private readonly startAnchor: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly thumbTarget: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly tether: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private readonly runHalo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly dashWave: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly attackPulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly geometries: THREE.BufferGeometry[] = [];
	private readonly materials: THREE.Material[] = [];
	private readonly startWorld = new THREE.Vector3();
	private readonly thumbTargetWorld = new THREE.Vector3();
	private readonly thumbVisualWorld = new THREE.Vector3();
	private readonly thumbVelocity = new THREE.Vector3();
	private readonly scratch = new THREE.Vector3();
	private active = false;
	private thumbVisible = false;
	private runIntensity = 0;
	private runVelocity = 0;
	private dashWaveAge = 1;
	private attackPulseAge = 1;

	constructor() {
		this.group.name = 'PhysicsFeedbackActor';

		this.startAnchor = this.createGroundRing('start-anchor', START_ANCHOR_COLOR, 0.32, 0.42, 0.75);
		this.thumbTarget = this.createGroundRing('thumb-target', THUMB_TARGET_COLOR, 0.24, 0.34, 0.72);
		this.runHalo = this.createGroundRing('run-halo', TETHER_COLOR, 0.52, 0.58, 0.36);
		this.dashWave = this.createGroundRing('dash-wave', DASH_COLOR, 0.34, 0.42, 0);
		this.attackPulse = this.createGroundRing('attack-pulse', ATTACK_COLOR, 0.42, 0.5, 0);

		const tetherGeometry = this.trackGeometry(new THREE.PlaneGeometry(1, 0.075));
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
		this.tether.rotation.x = -Math.PI / 2;
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

	handlePointerFeedback({ event, startWorld, thumbWorld }: WorldInputFeedbackEvent) {
		this.startWorld.copy(startWorld);
		this.thumbTargetWorld.copy(thumbWorld);

		if (event.type === 'press') {
			this.active = true;
			this.thumbVisible = false;
			this.runIntensity = 0;
			this.runVelocity = 0;
			this.thumbVisualWorld.copy(thumbWorld);
			this.thumbVelocity.set(0, 0, 0);
			this.startAnchor.visible = true;
			this.startAnchor.scale.setScalar(0.72);
			this.placeGroundObject(this.startAnchor, this.startWorld);
			this.hideThumbAndTether();
			return;
		}

		if (event.type === 'drag') {
			this.active = true;
			this.thumbVisible = isThumbPointVisible(event.start, event.thumb);
			this.runIntensity = event.mode === 'run' ? 1 : 0.35;
			this.startAnchor.visible = true;
			this.placeGroundObject(this.startAnchor, this.startWorld);
			return;
		}

		if (event.type === 'release' || event.type === 'cancel') {
			this.active = false;
			this.runIntensity = 0;
			this.thumbVisible = false;
		}
	}

	handleGesture(gesture: InputGesture, playerWorld: THREE.Vector3) {
		if (gesture.type === 'dash') {
			this.dashWaveAge = 0;
			this.placeGroundObject(this.dashWave, playerWorld);
			this.dashWave.visible = true;
			return;
		}

		if (gesture.type === 'attack') {
			this.attackPulseAge = 0;
			this.placeGroundObject(this.attackPulse, playerWorld);
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

		this.springVector(this.thumbVisualWorld, this.thumbTargetWorld, this.thumbVelocity, deltaSeconds);
		this.placeGroundObject(this.thumbTarget, this.thumbVisualWorld);
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

		this.scratch.copy(this.thumbVisualWorld).sub(this.startWorld);
		const length = Math.hypot(this.scratch.x, this.scratch.z);
		if (length < 0.08) {
			this.tether.visible = false;
			return;
		}

		this.tether.visible = true;
		this.tether.position.set(
			(this.startWorld.x + this.thumbVisualWorld.x) * 0.5,
			GROUND_Y + 0.012,
			(this.startWorld.z + this.thumbVisualWorld.z) * 0.5
		);
		this.tether.scale.set(length, 1, 1);
		this.tether.rotation.z = -Math.atan2(this.scratch.z, this.scratch.x);
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
		this.placeGroundObject(this.runHalo, this.startWorld);
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
		const stiffness = 130;
		const damping = 19;
		velocity.x += ((target.x - current.x) * stiffness - velocity.x * damping) * deltaSeconds;
		velocity.z += ((target.z - current.z) * stiffness - velocity.z * damping) * deltaSeconds;
		current.x += velocity.x * deltaSeconds;
		current.z += velocity.z * deltaSeconds;
		current.y = GROUND_Y;
	}

	private hideThumbAndTether() {
		this.thumbTarget.visible = false;
		this.tether.visible = false;
		this.runHalo.visible = false;
	}

	private createGroundRing(name: string, color: number, innerRadius: number, outerRadius: number, opacity: number) {
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
		this.group.add(mesh);
		return mesh;
	}

	private placeGroundObject(object: THREE.Object3D, position: THREE.Vector3) {
		object.position.set(position.x, GROUND_Y, position.z);
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
