import { describe, expect, it } from 'vitest';
import { generateGuestName, normalizeNickname } from './names';

describe('normalizeNickname', () => {
	it('accepts Hangul, ASCII, digits, underscore and hyphen', () => {
		expect(normalizeNickname('날쌘여우27')).toBe('날쌘여우27');
		expect(normalizeNickname('Fox_a-1')).toBe('Fox_a-1');
	});

	it('trims and collapses whitespace', () => {
		expect(normalizeNickname('  a \t  b  ')).toBe('a b');
	});

	it('normalizes decomposed Hangul to NFC', () => {
		const decomposed = '한글'.normalize('NFD');
		expect(decomposed).not.toBe('한글');
		expect(normalizeNickname(decomposed)).toBe('한글');
	});

	it('enforces the length bounds in code points', () => {
		expect(normalizeNickname('a')).toBeNull();
		expect(normalizeNickname('ab')).toBe('ab');
		expect(normalizeNickname('가'.repeat(12))).toBe('가'.repeat(12));
		expect(normalizeNickname('가'.repeat(13))).toBeNull();
		expect(normalizeNickname('   ')).toBeNull();
	});

	it('rejects other characters', () => {
		for (const bad of ['a<b>', 'ab!', '😀😀', 'ㅋㅋ', 'né', 'a.b', '你好']) expect(normalizeNickname(bad)).toBeNull();
	});
});

describe('generateGuestName', () => {
	it('always yields a valid nickname, including at the random extremes', () => {
		for (const r of [0, 0.5, 0.999999]) expect(normalizeNickname(generateGuestName(() => r))).not.toBeNull();
		let seed = 1;
		const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
		for (let i = 0; i < 500; i++) {
			const name = generateGuestName(random);
			expect(normalizeNickname(name)).toBe(name);
		}
	});

	it('is deterministic for a given random source', () => {
		expect(generateGuestName(() => 0)).toBe('날쌘여우00');
	});
});
