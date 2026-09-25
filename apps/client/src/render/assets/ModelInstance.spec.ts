import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ModelInstance } from './ModelInstance';
import type { AnimName } from './types';

/** Each clip holds `.position[x]` at its own value, so the blend shows up in the object's x. */
function instance(durations: Partial<Record<AnimName, number>> = {}) {
	const values: Record<AnimName, number> = { idle: 0, move: 10, attack: 20, hit: 30, dash: 40, death: 50 };
	const clips = new Map<AnimName, THREE.AnimationClip>();
	for (const [name, x] of Object.entries(values) as [AnimName, number][]) {
		const d = durations[name] ?? 1;
		clips.set(name, new THREE.AnimationClip(name, d, [new THREE.NumberKeyframeTrack('.position[x]', [0, d], [x, x])]));
	}
	return new ModelInstance(new THREE.Group(), false, [], [], clips);
}

/** Advances in small frames, as the renderer does. */
const run = (inst: ModelInstance, seconds: number) => {
	for (let t = 0; t < seconds; t += 1 / 60) inst.update(1 / 60);
};

describe('ModelInstance', () => {
	it('ignores a flinch while moving, keeping the move loop at full weight', () => {
		const inst = instance();
		inst.setLoop('move');
		run(inst, 0.2);
		inst.trigger('hit');
		run(inst, 0.2);
		expect(inst.weightOf('move')).toBe(1);
		expect(inst.weightOf('hit')).toBe(0);
		expect(inst.object.position.x).toBeCloseTo(10);
	});

	it('cuts a flinch short when the unit starts moving', () => {
		const inst = instance();
		inst.setLoop('idle');
		inst.trigger('hit');
		run(inst, 0.3);
		expect(inst.weightOf('hit')).toBe(1);
		inst.setLoop('move');
		run(inst, 0.3);
		expect(inst.weightOf('hit')).toBe(0);
		expect(inst.weightOf('move')).toBe(1);
	});

	it('layers an attack over the move loop instead of replacing it', () => {
		const inst = instance();
		inst.setLoop('move');
		inst.trigger('attack');
		run(inst, 0.3);
		expect(inst.weightOf('move')).toBe(1);
		expect(inst.weightOf('attack')).toBeGreaterThan(0);
		expect(inst.weightOf('attack')).toBeLessThan(1);
		const x = inst.object.position.x;
		expect(x).toBeGreaterThan(10);
		expect(x).toBeLessThan(15); // the run keeps the larger share
	});

	it('resumes the loop chosen during a shot once the shot ends', () => {
		const inst = instance({ attack: 0.5 });
		inst.setLoop('idle');
		inst.trigger('attack');
		run(inst, 0.2);
		expect(inst.weightOf('attack')).toBe(1);
		expect(inst.weightOf('idle')).toBe(0);
		inst.setLoop('move'); // starts moving mid-swing: the legs join straight away
		run(inst, 0.2);
		expect(inst.weightOf('move')).toBe(1);
		run(inst, 0.5); // the attack has ended
		expect(inst.weightOf('attack')).toBe(0);
		expect(inst.weightOf('idle')).toBe(0);
		expect(inst.object.position.x).toBeCloseTo(10);
	});

	it('lets a dash replace the move loop, then returns to it', () => {
		const inst = instance({ dash: 0.3 });
		inst.setLoop('move');
		inst.trigger('dash');
		run(inst, 0.2);
		expect(inst.weightOf('dash')).toBe(1);
		expect(inst.weightOf('move')).toBe(0);
		run(inst, 0.4);
		expect(inst.weightOf('move')).toBe(1);
		expect(inst.weightOf('dash')).toBe(0);
	});
});
