import * as THREE from 'three';

/**
 * The closing zone's wall: an open cylinder of energy, brightest where it meets the ground and
 * fading upward, with streaks drifting up it and faint scanlines. Patterns are sized in world
 * units around the circumference, so they keep their spacing as the zone shrinks.
 */

const HEIGHT = 14;

export class ZoneWall {
	readonly mesh: THREE.Mesh;
	private readonly uniforms = {
		uTime: { value: 0 },
		uRadius: { value: 1 },
		uColor: { value: new THREE.Color(0x58a6ff) }
	};

	constructor() {
		const material = new THREE.ShaderMaterial({
			uniforms: this.uniforms,
			vertexShader: /* glsl */ `
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}`,
			fragmentShader: /* glsl */ `
				uniform float uTime;
				uniform float uRadius;
				uniform vec3 uColor;
				varying vec2 vUv;

				float zHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
				float zNoise(vec2 p) {
					vec2 i = floor(p), f = fract(p);
					vec2 u = f * f * (3.0 - 2.0 * f);
					return mix(mix(zHash(i), zHash(i + vec2(1.0, 0.0)), u.x), mix(zHash(i + vec2(0.0, 1.0)), zHash(i + vec2(1.0, 1.0)), u.x), u.y);
				}

				void main() {
					float h = vUv.y; // 0 at the ground, 1 at the top
					// Around the wall in world units.
					float circ = 6.2831853 * uRadius;
					float around = vUv.x * circ;
					float fade = pow(1.0 - h, 1.2);
					// Rising streaks: stretched noise scrolling up. Blending toward the sample one
					// circumference back makes both ends of the wall agree, so there's no seam.
					vec2 q = vec2(around * 0.4, h * 2.5 - uTime * 0.7);
					float streak = mix(zNoise(q), zNoise(q - vec2(circ * 0.4, 0.0)), vUv.x);
					streak = smoothstep(0.45, 0.95, streak);
					// Faint scanlines drifting up.
					float scan = smoothstep(0.85, 1.0, sin((h * 30.0 - uTime * 2.2) * 3.1415926)) * 0.5;
					// A bright seam where the wall meets the ground.
					float rim = pow(1.0 - h, 18.0);
					float a = fade * (0.3 + 0.6 * streak + scan * 0.35) + rim * 0.9;
					vec3 col = mix(uColor, vec3(0.85, 0.95, 1.0), rim * 0.7 + streak * 0.25);
					gl_FragColor = vec4(col * a, a);
				}`,
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			blending: THREE.AdditiveBlending
		});
		this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, HEIGHT, 160, 1, true), material);
		this.mesh.position.y = HEIGHT / 2;
		this.mesh.name = 'zoneWall';
	}

	update(center: { x: number; z: number }, radius: number, time: number) {
		const r = Math.max(0.01, radius);
		this.mesh.scale.set(r, 1, r);
		this.mesh.position.x = center.x;
		this.mesh.position.z = center.z;
		this.uniforms.uRadius.value = r;
		this.uniforms.uTime.value = time;
	}

	dispose() {
		this.mesh.geometry.dispose();
		(this.mesh.material as THREE.Material).dispose();
	}
}
