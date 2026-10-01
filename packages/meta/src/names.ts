export const NAME_MIN = 2;
export const NAME_MAX = 12;

const ALLOWED = /^[가-힣A-Za-z0-9_\- ]+$/;

/** NFC-normalized, trimmed, inner whitespace collapsed to one space; null unless 2–12 code points of
 *  Hangul syllables (U+AC00–U+D7A3), ASCII letters/digits, '_', '-' or ' '. */
export function normalizeNickname(raw: string): string | null {
	const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
	const length = [...name].length;
	if (length < NAME_MIN || length > NAME_MAX) return null;
	return ALLOWED.test(name) ? name : null;
}

const ADJECTIVES = ['날쌘', '용감한', '조용한', '빠른', '강한', '느긋한', '영리한', '수줍은', '듬직한', '씩씩한'];
const NOUNS = ['여우', '호랑이', '토끼', '곰', '늑대', '고양이', '사슴', '부엉이', '너구리', '다람쥐'];

/** "<adjective><noun><2 digits>" in Korean from fixed word lists (≈10 × 10), e.g. "날쌘여우27";
 *  always passes normalizeNickname. */
export function generateGuestName(random: () => number): string {
	const pick = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
	const digits = String(Math.min(99, Math.floor(random() * 100))).padStart(2, '0');
	return `${pick(ADJECTIVES)}${pick(NOUNS)}${digits}`;
}
