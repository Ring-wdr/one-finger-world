import * as THREE from 'three';

/**
 * A fixed pool of additive, soft round particles drawn in one call — fireball trails, explosion
 * sparks. Each particle fades out over its life and cools from its colour toward ember red.
 * Sizes are in world units.
 */
export class Particles {
	readonly points: THREE.Points;
	private readonly material: THREE.ShaderMaterial;
	private readonly pos: Float32Array;
	private readonly vel: Float32Array;
	private readonly color: Float32Array;
	private readonly size: Float32Array;
	private readonly alpha: Float32Array;
	private readonly life: Float32Array;
	private readonly maxLife: Float32Array;
	private next = 0;

	constructor(private readonly capacity = 1024) {
		this.pos = new Float32Array(capacity * 3);
		this.vel = new Float32Array(capacity * 3);
		this.color = new Float32Array(capacity * 3);
		this.size = new Float32Array(capacity);
		this.alpha = new Float32Array(capacity);
		this.life = new Float32Array(capacity);
		this.maxLife = new Float32Array(capacity).fill(1);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
		geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
		geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
		geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
		this.material = new THREE.ShaderMaterial({
			uniforms: { uScale: { value: 400 } },
			vertexShader: /* glsl */ `
				uniform float uScale;
				attribute vec3 aColor;
				attribute float aSize;
				attribute float aAlpha;
				varying vec3 vColor;
				varying float vAlpha;
				void main() {
					vColor = aColor;
					vAlpha = aAlpha;
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = aAlpha > 0.0 ? aSize * uScale / -mv.z : 0.0;
					gl_Position = projectionMatrix * mv;
				}`,
			fragmentShader: /* glsl */ `
				varying vec3 vColor;
				varying float vAlpha;
				void main() {
					float d = length(gl_PointCoord - 0.5);
					float a = smoothstep(0.5, 0.0, d) * vAlpha;
					// Cools toward ember red as it fades.
					vec3 c = mix(vec3(0.55, 0.08, 0.02), vColor, vAlpha);
					gl_FragColor = vec4(c * a, a);
				}`,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending
		});
		this.points = new THREE.Points(geometry, this.material);
		// Positions move every frame; the static bounding sphere would cull them wrongly.
		this.points.frustumCulled = false;
		this.points.renderOrder = 5;
	}

	/** Point size in pixels per world unit at distance 1, from the viewport. */
	setViewport(heightPx: number, fovDeg: number) {
		this.material.uniforms.uScale.value = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
	}

	/** Oldest particles are recycled once the pool is full. */
	emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, color: THREE.Color) {
		const i = this.next;
		this.next = (this.next + 1) % this.capacity;
		this.pos.set([p.x, p.y, p.z], i * 3);
		this.vel.set([v.x, v.y, v.z], i * 3);
		this.color.set([color.r, color.g, color.b], i * 3);
		this.size[i] = size;
		this.life[i] = life;
		this.maxLife[i] = life;
		this.alpha[i] = 1;
	}

	/** Sparks flung outward and up from `at`, e.g. an explosion. */
	burst(at: THREE.Vector3, count: number, speed: number, colors: THREE.Color[]) {
		const v = new THREE.Vector3();
		for (let n = 0; n < count; n++) {
			const a = Math.random() * Math.PI * 2;
			const s = speed * (0.35 + Math.random() * 0.65);
			v.set(Math.cos(a) * s, speed * (0.3 + Math.random() * 0.7), Math.sin(a) * s);
			this.emit(at, v, 0.35 + Math.random() * 0.4, 0.35 + Math.random() * 0.45, colors[n % colors.length]);
		}
	}

	update(dt: number) {
		const drag = Math.exp(-3 * dt);
		for (let i = 0; i < this.capacity; i++) {
			if (this.life[i] <= 0) continue;
			this.life[i] -= dt;
			if (this.life[i] <= 0) {
				this.alpha[i] = 0;
				continue;
			}
			const k = i * 3;
			this.vel[k] *= drag;
			this.vel[k + 2] *= drag;
			// Heat rises, slowly.
			this.vel[k + 1] = this.vel[k + 1] * drag + 1.2 * dt;
			this.pos[k] += this.vel[k] * dt;
			this.pos[k + 1] += this.vel[k + 1] * dt;
			this.pos[k + 2] += this.vel[k + 2] * dt;
			this.alpha[i] = this.life[i] / this.maxLife[i];
		}
		const g = this.points.geometry;
		for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) g.getAttribute(name).needsUpdate = true;
	}

	clear() {
		this.life.fill(0);
		this.alpha.fill(0);
	}

	dispose() {
		this.points.geometry.dispose();
		this.material.dispose();
	}
}

/** A soft radial falloff, white at the centre — tinted by whatever material uses it. */
export function glowTexture(size = 64): THREE.DataTexture {
	const data = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
			const a = Math.max(0, 1 - d) ** 2;
			data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4);
		}
	}
	const tex = new THREE.DataTexture(data, size, size);
	tex.needsUpdate = true;
	return tex;
}
