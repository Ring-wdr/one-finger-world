import * as THREE from 'three';

/**
 * Dusk over a dying land: a cool sky fill, a warm low sun, and sun shadows that exist only
 * around the camera's focus. The shadow box follows the focus in whole-texel steps so shadow
 * edges don't crawl as the camera glides.
 */

/** Half-width of the shadowed square around the focus. Wide enough for portrait zoom-out. */
const SHADOW_HALF = 40;
const SHADOW_MAP = 2048;
/** Sun direction (from the focus toward the sun): low and from the upper right. */
const SUN_OFFSET = new THREE.Vector3(34, 52, 18);

export class Lighting {
	readonly hemi = new THREE.HemisphereLight(0xa9bcd8, 0x2a2420, 1.6);
	readonly sun = new THREE.DirectionalLight(0xffe2bd, 2);
	private readonly snapped = new THREE.Vector3();

	constructor(scene: THREE.Scene) {
		const { sun } = this;
		sun.castShadow = true;
		sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
		const cam = sun.shadow.camera;
		cam.left = cam.bottom = -SHADOW_HALF;
		cam.right = cam.top = SHADOW_HALF;
		cam.near = 1;
		cam.far = SUN_OFFSET.length() + 60;
		cam.updateProjectionMatrix();
		// Flat ground at a grazing sun angle acnes easily; normalBias pushes lookups off the surface.
		sun.shadow.bias = -0.0004;
		sun.shadow.normalBias = 0.04;
		scene.add(this.hemi, sun, sun.target);
	}

	/** Centre the shadow box on the focus, snapped to the shadow map's texel grid. */
	follow(focus: THREE.Vector3) {
		const texel = (SHADOW_HALF * 2) / SHADOW_MAP;
		this.snapped.set(Math.round(focus.x / texel) * texel, 0, Math.round(focus.z / texel) * texel);
		this.sun.target.position.copy(this.snapped);
		this.sun.position.copy(this.snapped).add(SUN_OFFSET);
	}
}

/** Everything under `obj` casts shadows (and optionally receives them). */
export function castShadows(obj: THREE.Object3D, receive = false) {
	obj.traverse((o) => {
		if (!(o instanceof THREE.Mesh)) return;
		o.castShadow = true;
		o.receiveShadow = receive;
	});
}
