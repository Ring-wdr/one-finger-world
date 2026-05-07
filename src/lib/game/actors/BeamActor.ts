import * as THREE from 'three';

const BEAM_DURATION_SECONDS = 3;
const BEAM_Y_OFFSET = 0.95;
const BEAM_LENGTH = 5.6;
const BEAM_CORE_OPACITY = 0.78;
const BEAM_SHELL_OPACITY = 0.28;
const MIN_DIRECTION_LENGTH_SQ = 0.000001;

export class BeamActor {
	readonly group = new THREE.Group();

	private readonly coreMaterial: THREE.MeshBasicMaterial;
	private readonly shellMaterial: THREE.MeshBasicMaterial;
	private readonly geometries: THREE.BufferGeometry[] = [];
	private readonly materials: THREE.Material[] = [];
	private remainingSeconds = 0;

	constructor() {
		this.group.name = 'BeamActor';
		this.group.visible = false;

		this.coreMaterial = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color: 0xe0f2fe,
				opacity: BEAM_CORE_OPACITY,
				transparent: true,
				depthWrite: false
			})
		);
		this.shellMaterial = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color: 0x38bdf8,
				opacity: BEAM_SHELL_OPACITY,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);

		this.group.add(
			this.createBeamMesh(0.065, this.coreMaterial, 'beam-core'),
			this.createBeamMesh(0.16, this.shellMaterial, 'beam-shell')
		);
	}

	start(origin: THREE.Vector3, direction: THREE.Vector3) {
		this.setOrigin(origin);
		this.group.rotation.y = this.resolveYaw(direction);
		this.remainingSeconds = BEAM_DURATION_SECONDS;
		this.setOpacity(1);
		this.group.visible = true;
	}

	setOrigin(origin: THREE.Vector3) {
		this.group.position.set(origin.x, origin.y + BEAM_Y_OFFSET, origin.z);
	}

	update(deltaSeconds: number) {
		if (!this.group.visible) return;

		const dt = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
		this.remainingSeconds = Math.max(0, this.remainingSeconds - dt);
		this.setOpacity(this.remainingSeconds / BEAM_DURATION_SECONDS);

		if (this.remainingSeconds === 0) {
			this.group.visible = false;
		}
	}

	dispose() {
		this.group.removeFromParent();
		this.group.clear();

		for (const geometry of this.geometries) {
			geometry.dispose();
		}

		for (const material of this.materials) {
			material.dispose();
		}
	}

	private createBeamMesh(radius: number, material: THREE.Material, name: string) {
		const geometry = this.trackGeometry(new THREE.CylinderGeometry(radius, radius, BEAM_LENGTH, 24, 1));
		geometry.rotateX(Math.PI / 2);

		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = name;
		mesh.position.z = BEAM_LENGTH / 2;
		return mesh;
	}

	private resolveYaw(direction: THREE.Vector3) {
		const x = Number.isFinite(direction.x) ? direction.x : 0;
		const z = Number.isFinite(direction.z) ? direction.z : 0;
		if (x * x + z * z <= MIN_DIRECTION_LENGTH_SQ) return 0;

		return Math.atan2(x, z);
	}

	private setOpacity(scale: number) {
		this.coreMaterial.opacity = BEAM_CORE_OPACITY * scale;
		this.shellMaterial.opacity = BEAM_SHELL_OPACITY * scale;
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
