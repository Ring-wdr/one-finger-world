import * as THREE from 'three';
import { MAP_RADIUS, RING } from '@ofa/sim';

/**
 * The ground: one disc whose colour is painted per pixel from world position in the shader —
 * scorched earth in the centre, dry dirt in the middle ring, grass outside, dark void past the
 * map edge. Zone borders wander with noise, so they read as land rather than rings; the exact
 * boundaries are still marked by the renderer's ring lines. Nothing to download, and detail
 * holds at any zoom. Lighting and fog come from MeshStandardMaterial as usual.
 */

/** Base tones match the old flat zones, so the danger gradient reads the same. */
const PALETTE = {
	scorched: 0x4a2e2e,
	scorchedDark: 0x2b1a1b,
	ember: 0x8a3a20,
	dirt: 0x46432f,
	dirtDark: 0x383423,
	deadGrass: 0x5a5536,
	grass: 0x2f4634,
	grassLight: 0x3a5a3c,
	grassDark: 0x243a29,
	void: 0x1a2027
};

const glsl = (hex: number) => {
	const c = new THREE.Color(hex);
	return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

const TERRAIN_GLSL = /* glsl */ `
varying vec2 vGround;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tFbm(vec2 p) {
	float v = 0.0, a = 0.5;
	for (int i = 0; i < 4; i++) { v += a * tNoise(p); p = p * 2.03 + 17.0; a *= 0.5; }
	return v;
}

vec3 terrainColor(vec2 p) {
	// Zone borders wander a few units either way.
	float r = length(p) + (tFbm(p * 0.05) - 0.5) * 6.0;
	float patches = tFbm(p * 0.12);
	float grain = tNoise(p * 1.7);

	vec3 scorched = mix(${glsl(PALETTE.scorchedDark)}, ${glsl(PALETTE.scorched)}, smoothstep(0.25, 0.7, patches));
	// Cracks: thin, sparse valleys of a ridged noise. A few glow faintly — kept subtle, since
	// this is where the fighting is densest.
	float crack = (1.0 - smoothstep(0.0, 0.025, abs(tNoise(p * 0.16) - 0.5))) * smoothstep(0.35, 0.6, tNoise(p * 0.05 + 7.0));
	scorched = mix(scorched, ${glsl(PALETTE.scorchedDark)} * 0.7, crack * 0.7);
	scorched += ${glsl(PALETTE.ember)} * crack * smoothstep(0.7, 0.9, tNoise(p * 0.06 + 40.0)) * 0.35;

	vec3 dirt = mix(${glsl(PALETTE.dirtDark)}, ${glsl(PALETTE.dirt)}, smoothstep(0.3, 0.65, patches));
	dirt = mix(dirt, ${glsl(PALETTE.deadGrass)}, smoothstep(0.55, 0.75, tFbm(p * 0.21 + 9.0)) * 0.8);

	vec3 grass = mix(${glsl(PALETTE.grassDark)}, ${glsl(PALETTE.grass)}, smoothstep(0.25, 0.6, patches));
	grass = mix(grass, ${glsl(PALETTE.grassLight)}, smoothstep(0.6, 0.8, tFbm(p * 0.18 + 3.0)) * 0.7);

	vec3 voidCol = ${glsl(PALETTE.void)} * (0.75 + 0.35 * patches);

	const float EDGE = 1.5;
	vec3 col = mix(scorched, dirt, smoothstep(${RING.center.toFixed(1)} - EDGE, ${RING.center.toFixed(1)} + EDGE, r));
	col = mix(col, grass, smoothstep(${RING.mid.toFixed(1)} - EDGE, ${RING.mid.toFixed(1)} + EDGE, r));
	// The map edge stays exact: it is where the playable world ends.
	float edge = length(p);
	col = mix(col, voidCol, smoothstep(${MAP_RADIUS.toFixed(1)} - 0.4, ${MAP_RADIUS.toFixed(1)} + 0.4, edge));
	// Fine grain so close-ups aren't flat.
	return col * (0.92 + 0.16 * grain);
}
`;

export function createTerrain(): THREE.Mesh {
	const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
	material.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = (modelMatrix * vec4(transformed, 1.0)).xz;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\n${TERRAIN_GLSL}`)
			.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = terrainColor(vGround);');
	};
	material.customProgramCacheKey = () => 'terrain';
	const mesh = new THREE.Mesh(new THREE.CircleGeometry(MAP_RADIUS + 200, 192).rotateX(-Math.PI / 2), material);
	mesh.name = 'terrain';
	return mesh;
}
