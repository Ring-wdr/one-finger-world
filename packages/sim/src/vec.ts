export interface Vec2 {
	x: number;
	y: number;
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });
export const copy = (v: Vec2): Vec2 => ({ x: v.x, y: v.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const len = (v: Vec2) => Math.hypot(v.x, v.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec2, b: Vec2) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
	x: a.x + (b.x - a.x) * t,
	y: a.y + (b.y - a.y) * t
});

export function normalize(v: Vec2): Vec2 {
	const l = len(v);
	return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

export function rotate(v: Vec2, radians: number): Vec2 {
	const c = Math.cos(radians);
	const s = Math.sin(radians);
	return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function fromAngle(radians: number, length = 1): Vec2 {
	return { x: Math.cos(radians) * length, y: Math.sin(radians) * length };
}

/** Clamp a point to lie within a circle. */
export function clampToCircle(p: Vec2, center: Vec2, radius: number): Vec2 {
	const d = sub(p, center);
	const l = len(d);
	return l <= radius ? p : add(center, scale(d, radius / l));
}
