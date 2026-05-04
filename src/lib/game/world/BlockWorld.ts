import * as THREE from 'three';

export interface WorldBounds {
	minX: number;
	maxX: number;
	minZ: number;
	maxZ: number;
}

export class BlockWorld {
	readonly group = new THREE.Group();
	readonly bounds: WorldBounds = { minX: -7.5, maxX: 7.5, minZ: -7.5, maxZ: 7.5 };

	private readonly geometries: THREE.BufferGeometry[] = [];
	private readonly materials: THREE.Material[] = [];

	constructor() {
		const floorMaterial = this.trackMaterial(
			new THREE.MeshStandardMaterial({ color: 0x3f7f5f, roughness: 0.95 })
		);
		const lowBlockMaterial = this.trackMaterial(
			new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.82 })
		);
		const tallBlockMaterial = this.trackMaterial(
			new THREE.MeshStandardMaterial({ color: 0x9a6b42, roughness: 0.78 })
		);
		const accentBlockMaterial = this.trackMaterial(
			new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.86 })
		);

		const floorWidth = this.bounds.maxX - this.bounds.minX;
		const floorDepth = this.bounds.maxZ - this.bounds.minZ;
		const floorGeometry = this.trackGeometry(new THREE.BoxGeometry(floorWidth, 0.08, floorDepth));
		const floor = new THREE.Mesh(floorGeometry, floorMaterial);
		floor.position.y = -0.04;
		this.group.add(floor);

		const props = [
			{ x: -4.8, z: -3.7, width: 1.3, height: 0.7, depth: 1.1, material: lowBlockMaterial },
			{ x: -2.1, z: 3.8, width: 0.9, height: 1.4, depth: 1.2, material: tallBlockMaterial },
			{ x: 1.4, z: -4.5, width: 1.1, height: 0.45, depth: 2, material: accentBlockMaterial },
			{ x: 3.8, z: 1.9, width: 1.6, height: 1, depth: 0.9, material: lowBlockMaterial },
			{ x: 5.5, z: -1.8, width: 0.8, height: 1.8, depth: 0.8, material: tallBlockMaterial }
		];

		for (const prop of props) {
			const geometry = this.trackGeometry(new THREE.BoxGeometry(prop.width, prop.height, prop.depth));
			const mesh = new THREE.Mesh(geometry, prop.material);
			mesh.position.set(prop.x, prop.height / 2, prop.z);
			this.group.add(mesh);
		}
	}

	clampPosition(position: THREE.Vector3, margin = 0.35) {
		position.x = THREE.MathUtils.clamp(
			position.x,
			this.bounds.minX + margin,
			this.bounds.maxX - margin
		);
		position.z = THREE.MathUtils.clamp(
			position.z,
			this.bounds.minZ + margin,
			this.bounds.maxZ - margin
		);
		return position;
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

	private trackGeometry<T extends THREE.BufferGeometry>(geometry: T) {
		this.geometries.push(geometry);
		return geometry;
	}

	private trackMaterial<T extends THREE.Material>(material: T) {
		this.materials.push(material);
		return material;
	}
}
