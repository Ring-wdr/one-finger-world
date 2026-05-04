import type { ComboStep } from '$lib/game/types';
// @ts-expect-error The repo has the three runtime package but no declarations in this task scope.
import * as THREE from 'three';

export class PlayerActor {
	readonly group = new THREE.Group();

	private readonly model = new THREE.Group();
	private readonly torso: THREE.Mesh;
	private readonly head: THREE.Mesh;
	private readonly leftArm = new THREE.Group();
	private readonly rightArm = new THREE.Group();
	private readonly leftLeg = new THREE.Group();
	private readonly rightLeg = new THREE.Group();
	private readonly attackArc: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly attackMaterial: THREE.MeshBasicMaterial;
	private readonly geometries: THREE.BufferGeometry[] = [];
	private readonly materials: THREE.Material[] = [];
	private motionTime = 0;
	private attackTimer = 0;
	private attackDuration = 0.18;
	private attackStep: ComboStep = 1;

	constructor() {
		this.group.add(this.model);

		const skinMaterial = this.trackMaterial(
			new THREE.MeshStandardMaterial({ color: 0xffc7a0, roughness: 0.8 })
		);
		const suitMaterial = this.trackMaterial(
			new THREE.MeshStandardMaterial({ color: 0x4263eb, roughness: 0.7 })
		);
		const bootMaterial = this.trackMaterial(
			new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.65 })
		);
		const markerMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({ color: 0x111827 }));
		this.attackMaterial = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color: 0x7dd3fc,
				opacity: 0.5,
				side: THREE.DoubleSide,
				transparent: true
			})
		);

		const torsoGeometry = this.trackGeometry(new THREE.BoxGeometry(0.58, 0.64, 0.38));
		this.torso = new THREE.Mesh(torsoGeometry, suitMaterial);
		this.torso.position.set(0, 1, 0);
		this.model.add(this.torso);

		const headGeometry = this.trackGeometry(new THREE.SphereGeometry(0.34, 24, 18));
		this.head = new THREE.Mesh(headGeometry, skinMaterial);
		this.head.position.set(0, 1.66, 0);
		this.model.add(this.head);

		const eyeGeometry = this.trackGeometry(new THREE.SphereGeometry(0.035, 10, 8));
		const leftEye = new THREE.Mesh(eyeGeometry, markerMaterial);
		leftEye.position.set(-0.1, 1.72, 0.315);
		this.model.add(leftEye);

		const rightEye = new THREE.Mesh(eyeGeometry, markerMaterial);
		rightEye.position.set(0.1, 1.72, 0.315);
		this.model.add(rightEye);

		const directionMarkerGeometry = this.trackGeometry(new THREE.BoxGeometry(0.12, 0.06, 0.04));
		const directionMarker = new THREE.Mesh(directionMarkerGeometry, markerMaterial);
		directionMarker.position.set(0, 1.59, 0.345);
		this.model.add(directionMarker);

		const armGeometry = this.trackGeometry(new THREE.BoxGeometry(0.16, 0.46, 0.16));
		this.leftArm.position.set(-0.38, 1.18, 0);
		this.leftArm.rotation.z = 0.18;
		this.leftArm.add(this.createLimbMesh(armGeometry, suitMaterial, -0.2));
		this.model.add(this.leftArm);

		this.rightArm.position.set(0.38, 1.18, 0);
		this.rightArm.rotation.z = -0.18;
		this.rightArm.add(this.createLimbMesh(armGeometry, suitMaterial, -0.2));
		this.model.add(this.rightArm);

		const legGeometry = this.trackGeometry(new THREE.BoxGeometry(0.18, 0.48, 0.18));
		const footGeometry = this.trackGeometry(new THREE.BoxGeometry(0.22, 0.12, 0.3));
		this.leftLeg.position.set(-0.17, 0.68, 0);
		this.leftLeg.add(this.createLimbMesh(legGeometry, suitMaterial, -0.24));
		this.leftLeg.add(this.createFootMesh(footGeometry, bootMaterial));
		this.model.add(this.leftLeg);

		this.rightLeg.position.set(0.17, 0.68, 0);
		this.rightLeg.add(this.createLimbMesh(legGeometry, suitMaterial, -0.24));
		this.rightLeg.add(this.createFootMesh(footGeometry, bootMaterial));
		this.model.add(this.rightLeg);

		const attackGeometry = this.trackGeometry(
			new THREE.RingGeometry(0.54, 0.96, 36, 1, -Math.PI * 0.85, Math.PI * 0.7)
		);
		this.attackArc = new THREE.Mesh(attackGeometry, this.attackMaterial);
		this.attackArc.position.set(0, 0.78, 0.18);
		this.attackArc.rotation.x = -Math.PI / 2;
		this.attackArc.visible = false;
		this.model.add(this.attackArc);
	}

	setPosition(position: THREE.Vector3) {
		this.group.position.copy(position);
	}

	faceWorldDirection(direction: THREE.Vector3) {
		const horizontalLengthSq = direction.x * direction.x + direction.z * direction.z;
		if (horizontalLengthSq <= 0.000001) return;

		this.group.rotation.y = Math.atan2(direction.x, direction.z);
	}

	playAttack(comboStep: ComboStep) {
		this.attackStep = comboStep;
		this.attackDuration = comboStep === 3 ? 0.24 : 0.18;
		this.attackTimer = this.attackDuration;
		this.attackMaterial.opacity = 0.5;

		const scale = comboStep === 1 ? 0.92 : comboStep === 2 ? 1.06 : 1.2;
		const sideOffset = comboStep === 2 ? -0.22 : comboStep === 3 ? 0.18 : 0;
		this.attackArc.scale.set(scale, scale, scale);
		this.attackArc.rotation.z = sideOffset;
		this.attackArc.visible = true;
		this.applyMotionPose(0, 0, 1);
	}

	update(deltaSeconds: number, moving: boolean, running: boolean, dashing: boolean) {
		const dt = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
		const pace = dashing ? 10 : running ? 7 : 4.5;
		const swingAmount = moving ? (dashing ? 0.62 : running ? 0.48 : 0.28) : 0;
		this.motionTime += dt * pace;

		if (this.attackTimer > 0) {
			this.attackTimer = Math.max(0, this.attackTimer - dt);
			if (this.attackTimer === 0) {
				this.attackArc.visible = false;
			}
		}

		const swing = Math.sin(this.motionTime) * swingAmount;
		const lean = dashing ? 0.26 : running ? 0.16 : moving ? 0.08 : 0;
		const attackPose = this.attackTimer / this.attackDuration;

		this.model.position.y = moving ? Math.abs(Math.sin(this.motionTime * 2)) * 0.025 : 0;
		this.applyMotionPose(swing, lean, attackPose);

		if (this.attackArc.visible) {
			this.attackMaterial.opacity = 0.18 + attackPose * 0.36;
		}
	}

	dispose() {
		for (const geometry of this.geometries) {
			geometry.dispose();
		}

		for (const material of this.materials) {
			material.dispose();
		}
	}

	private applyMotionPose(swing: number, lean: number, attackPose: number) {
		const attackSide = this.attackStep === 2 ? -1 : 1;
		const attackPower = this.attackStep === 3 ? 1.2 : this.attackStep === 2 ? 1.05 : 0.9;

		this.model.rotation.x = lean + attackPose * 0.06;
		this.model.rotation.z = attackPose * attackSide * (this.attackStep === 3 ? 0.16 : 0.1);
		this.torso.rotation.y = attackPose * attackSide * 0.16 * attackPower;
		this.head.rotation.y = attackPose * attackSide * 0.1;

		this.leftArm.rotation.x = swing * 0.75 + attackPose * 0.18;
		this.leftArm.rotation.y = 0;
		this.leftArm.rotation.z = 0.18 + attackPose * attackSide * 0.2;

		this.rightArm.rotation.x = -swing - attackPose * 1.2 * attackPower;
		this.rightArm.rotation.y = attackPose * attackSide * 0.35;
		this.rightArm.rotation.z = -0.18 - attackPose * attackSide * 0.48;

		this.leftLeg.rotation.x = -swing * 0.62;
		this.rightLeg.rotation.x = swing * 0.62;
	}

	private createLimbMesh(
		geometry: THREE.BufferGeometry,
		material: THREE.Material,
		localY: number
	) {
		const mesh = new THREE.Mesh(geometry, material);
		mesh.position.y = localY;
		return mesh;
	}

	private createFootMesh(geometry: THREE.BufferGeometry, material: THREE.Material) {
		const mesh = new THREE.Mesh(geometry, material);
		mesh.position.set(0, -0.52, 0.06);
		return mesh;
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
