"""
Ground decoration: small props that dress the terrain but never block — grass and flowers in
the outer ring, dry grass, twigs and bones in the middle one, ash, embers and charred stumps in
the scorched centre. They go into nature.glb as `decor_*` nodes.

Hundreds are scattered over the map, so each stays small (roughly 40–250 triangles) and they
cast no shadows. Blades are thin closed wedges rather than flat cards: the material is
single-sided, and a wedge still shows from every angle.
"""
import math
import random

import bmesh
from mathutils import Matrix, Vector

from common import Builder, decimate, fbm, ico, lathe, material, mix, rotation, skin, smoothstep, srgb
from nature import boulder, fit_rock, nature_material


def ember_material():
    return material('ember', color=0xFF7A2A, roughness=0.6, emissive=0xFF5212, emissive_strength=1.0)


def _untinted(co, n, poly):
    return Vector((1, 1, 1))


def _grown(obj, k):
    """Scales a finished prop about its base, after colours and occlusion are baked."""
    obj.data.transform(Matrix.Scale(k, 4))
    return obj


# ---------------------------------------------------------------------------------------------
# Blades and tufts


def _blade(height, width, lean, bend, rng, thickness=0.012, segments=2):
    """
    One blade: a triangular wedge tapering from the ground to a point, curving over as it rises.
    `lean` is the direction (radians) it tips toward; `bend` how far its tip droops that way.
    One segment is a straight 3-triangle spike; two curve over at 9 triangles.
    """
    bm = bmesh.new()
    d = Vector((math.cos(lean), math.sin(lean), 0))
    side = Vector((-d.y, d.x, 0))
    rings = []
    for t in [s / segments for s in range(segments)]:
        w = width * (1 - t * 0.55)
        centre = d * bend * height * t * t + Vector((0, 0, height * t * (1 - 0.25 * bend * t)))
        rings.append([
            bm.verts.new(centre - side * w / 2),
            bm.verts.new(centre + side * w / 2),
            bm.verts.new(centre - d * thickness),
        ])
    tip = bm.verts.new(d * bend * height + Vector((0, 0, height * (1 - 0.25 * bend))))
    for a, b in zip(rings, rings[1:]):
        for i in range(3):
            j = (i + 1) % 3
            bm.faces.new((a[i], a[j], b[j], b[i]))
    for i in range(3):
        bm.faces.new((rings[-1][i], rings[-1][(i + 1) % 3], tip))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def _blade_painter(root, tip, seed, height):
    off = Vector((seed, 0, 0))

    def paint(co, n, poly):
        c = mix(root, tip, smoothstep(0.0, height, co.z))
        return c * (1 + 0.1 * fbm(co * 9 + off))

    return paint


def _tuft(b, rng, count, height, width, spread, bend, root, tip, seed, segments=2):
    paint = _blade_painter(root, tip, seed, height)
    for k in range(count):
        a = 2 * math.pi * (k + rng.uniform(-0.3, 0.3)) / count
        r = spread * rng.uniform(0.2, 1.0)
        h = height * rng.uniform(0.6, 1.0)
        blade = _blade(h, width * rng.uniform(0.8, 1.2), a + rng.uniform(-0.5, 0.5), bend * rng.uniform(0.6, 1.2), rng, segments=segments)
        b.add(blade, nature_material(), paint, Matrix.Translation((math.cos(a) * r, math.sin(a) * r, -0.02)), local=False)


def grass():
    rng = random.Random(11)
    b = Builder()
    _tuft(b, rng, 8, 0.6, 0.11, 0.15, 0.35, srgb(0x2A4A2E), srgb(0x8DBB5C), 1)
    return b.finish('decor_grass', ao=dict(samples=16, distance=0.2, strength=0.45))


def grass_dry():
    rng = random.Random(12)
    b = Builder()
    _tuft(b, rng, 6, 0.5, 0.095, 0.17, 0.6, srgb(0x5A4E2C), srgb(0xCBB675), 2)
    return b.finish('decor_grass_dry', ao=dict(samples=16, distance=0.2, strength=0.45))


def flowers():
    """A few leaves and stems topped by small flat blossoms — white, yellow and violet."""
    rng = random.Random(13)
    b = Builder()
    _tuft(b, rng, 5, 0.3, 0.08, 0.1, 0.5, srgb(0x2A4A2E), srgb(0x6A9A52), 3, segments=1)
    stem_paint = _blade_painter(srgb(0x2A4A2E), srgb(0x4F7A3E), 4, 0.4)
    colours = [0xF2EEE2, 0xF4CF4A, 0xA98BE0, 0xF2EEE2, 0xF08A9C]
    for k, hex_colour in enumerate(colours):
        a = 2 * math.pi * k / len(colours) + rng.uniform(-0.4, 0.4)
        r = rng.uniform(0.04, 0.12)
        h = rng.uniform(0.36, 0.5)
        base = Vector((math.cos(a) * r, math.sin(a) * r, -0.02))
        lean = a + rng.uniform(-0.3, 0.3)
        stem = _blade(h, 0.02, lean, 0.15, rng, thickness=0.01, segments=1)
        b.add(stem, nature_material(), stem_paint, Matrix.Translation(base), local=False)
        top = base + Vector((math.cos(lean), math.sin(lean), 0)) * 0.15 * h + Vector((0, 0, h * (1 - 0.04)))
        # Blossom: a shallow five-petal cone, pale at the rim, with a golden eye.
        petals = bmesh.new()
        centre = petals.verts.new((0, 0, 0.012))
        rim = []
        for i in range(10):
            ang = 2 * math.pi * i / 10
            rr = 0.075 if i % 2 == 0 else 0.04
            rim.append(petals.verts.new((rr * math.cos(ang), rr * math.sin(ang), 0.018 if i % 2 == 0 else 0.004)))
        under = petals.verts.new((0, 0, -0.012))
        for i in range(10):
            j = (i + 1) % 10
            petals.faces.new((centre, rim[i], rim[j]))
            petals.faces.new((under, rim[j], rim[i]))
        bmesh.ops.recalc_face_normals(petals, faces=petals.faces)
        petal = srgb(hex_colour)
        eye = srgb(0xE0A21E)

        def paint(co, n, poly, petal=petal, eye=eye):
            return mix(eye, petal, smoothstep(0.004, 0.02, math.hypot(co.x, co.y)))

        tilt = rotation('Z', math.degrees(lean)) @ rotation('Y', 25)
        b.add(petals, nature_material(), paint, Matrix.Translation(top) @ tilt)
    return b.finish('decor_flowers', ao=dict(samples=16, distance=0.2, strength=0.4))


def bush():
    """A low, lumpy shrub: a few squashed leafy blobs, darker inside, sunlit on top."""
    rng = random.Random(14)
    b = Builder()
    leaf = srgb(0x3B6B3A)
    light = srgb(0x7FAE55)
    dark = srgb(0x1C3522)
    off = Vector((5, 0, 0))

    def paint(co, n, poly):
        c = mix(dark, leaf, smoothstep(0.0, 0.3, co.z))
        c = mix(c, light, smoothstep(0.2, 0.9, n.z) * smoothstep(0.15, 0.4, co.z) * 0.7)
        return c * (1 + 0.12 * fbm(co * 7 + off))

    blobs = [(0, 0, 0.2, 0.26), (0.19, 0.04, 0.15, 0.19), (-0.12, 0.13, 0.14, 0.17)]
    for x, y, z, r in blobs:
        blob = ico(1.0, 2)
        seed = Vector((rng.uniform(0, 30), rng.uniform(0, 30), 0))
        for v in blob.verts:
            d = v.co.normalized()
            # Leafy lumps.
            v.co = d * (1 + 0.22 * fbm(d * 2.5 + seed))
        bmesh.ops.scale(blob, vec=Vector((r, r, r * 0.8)), verts=blob.verts)
        b.add(blob, nature_material(), paint, Matrix.Translation((x, y, z)), local=False)
    return _grown(b.finish('decor_bush', ao=dict(samples=24, distance=0.3, strength=0.6)), 1.5)


def mushrooms():
    """Two or three toadstools: pale stems, red caps with white flecks, beige gills."""
    rng = random.Random(15)
    b = Builder()
    stem_c = srgb(0xE6DAC0)
    gill = srgb(0xC9B48C)
    cap = srgb(0xB3302A)
    fleck = srgb(0xF4EEE2)
    for k, (x, y, h, r) in enumerate(((0, 0, 0.2, 0.1), (0.11, 0.07, 0.13, 0.07), (-0.08, 0.1, 0.09, 0.05))):
        stem = lathe([(0.0, -0.02), (r * 0.35, -0.02), (r * 0.3, h * 0.6), (r * 0.26, h), (0.0, h)], 6)
        b.add(stem, nature_material(), lambda co, n, p: stem_c, Matrix.Translation((x, y, 0)))
        dome = [(0.0, h - 0.01), (r, h - 0.005), (r * 1.02, h + r * 0.15), (r * 0.8, h + r * 0.5), (r * 0.45, h + r * 0.72), (0.0, h + r * 0.8)]
        cap_mesh = lathe(dome, 9)
        seed = k * 7

        def paint(co, n, poly, h=h, seed=seed):
            if co.z < h:
                return gill
            spot = smoothstep(0.35, 0.5, fbm(co * 60 + Vector((seed, 0, 0)), 1))
            return mix(cap, fleck, spot)

        tilt = rotation('X', rng.uniform(-10, 10)) @ rotation('Y', rng.uniform(-10, 10))
        b.add(cap_mesh, nature_material(), paint, Matrix.Translation((x, y, 0)) @ tilt)
    return _grown(b.finish('decor_mushrooms', ao=dict(samples=16, distance=0.12, strength=0.5)), 1.3)


# ---------------------------------------------------------------------------------------------
# Stones, twigs, bones


def pebbles():
    rng = random.Random(16)
    b = Builder()
    stone = srgb(0x6E7079)
    warm = srgb(0x7E776B)
    for k, (x, y, fp) in enumerate(((0, 0, 0.13), (0.17, 0.08, 0.08), (-0.12, 0.13, 0.07), (0.05, -0.16, 0.09))):
        prng = random.Random(100 + k)
        bm = boulder(prng, 12, (1.0, 0.85, 0.6), cuts=1)
        fit_rock(bm, fp, fp * 0.7, bury=0.02)
        tone = mix(stone, warm, prng.random()) * prng.uniform(0.85, 1.1)
        b.add(bm, nature_material(), lambda co, n, p, tone=tone: tone * (0.8 + 0.2 * smoothstep(-0.02, 0.06, co.z)),
              Matrix.Translation((x, y, 0)) @ rotation('Z', rng.uniform(0, 360)))
    return _grown(b.finish('decor_pebbles', ao=dict(samples=16, distance=0.12, strength=0.5), sharp_angle=40), 1.6)


def _crooked(rng, start, direction, length, segments, r0, r1, wobble):
    """A crooked polyline with tapering radii: verts, edges, radii."""
    verts, radii, edges = [Vector(start)], [r0], []
    d = Vector(direction).normalized()
    p = Vector(start)
    for s in range(1, segments + 1):
        d = (d + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.2, 0.2))) * wobble).normalized()
        p = p + d * (length / segments)
        verts.append(p.copy())
        radii.append(r0 + (r1 - r0) * s / segments)
        edges.append((s - 1, s))
    return verts, edges, radii


def twigs():
    """Fallen sticks lying in the dirt, one forked."""
    rng = random.Random(17)
    b = Builder()
    wood = srgb(0x6B5A48)
    dark = srgb(0x3B3129)
    off = Vector((17, 0, 0))

    def paint(co, n, poly):
        return mix(dark, wood, 0.5 + 0.6 * fbm(co * 20 + off)) * (0.8 + 0.2 * smoothstep(0.0, 0.04, co.z))

    for k, (x, y, a, length) in enumerate(((0, 0, 20, 0.7), (0.1, 0.18, 150, 0.45), (-0.2, -0.12, 260, 0.35))):
        d = Vector((math.cos(math.radians(a)), math.sin(math.radians(a)), 0.02))
        start = Vector((x, y, 0.02)) - d * length / 2
        verts, edges, radii = _crooked(rng, start, d, length, 5, 0.022, 0.009, 0.25)
        if k == 0:
            # A side shoot off the long stick.
            fork, fe, fr = _crooked(rng, verts[2], d + Vector((-d.y, d.x, 0)) * 0.9, 0.22, 3, 0.012, 0.006, 0.3)
            base = len(verts)
            verts += fork[1:]
            radii += fr[1:]
            edges += [(2 if i == 0 else base + i - 1, base + i) for i in range(len(fork) - 1)]
        bm = skin(verts, edges, radii, smoothing=0.3)
        decimate(bm, 90 if k == 0 else 50)
        b.add(bm, nature_material(), paint)
    return _grown(b.finish('decor_twigs', ao=dict(samples=12, distance=0.08, strength=0.4)), 1.3)


def bones():
    """A bleached skull beside two long bones."""
    b = Builder()
    bone = srgb(0xDCD0B6)
    shade = srgb(0x9E9078)
    socket = srgb(0x2A221E)

    skull = ico(1.0, 2)
    for v in skull.verts:
        c = v.co
        # Cranium, narrowing into a jaw at the front (+Y), flat underneath.
        jaw = smoothstep(0.1, 0.9, c.y) * smoothstep(0.3, -0.6, c.z)
        v.co = Vector((c.x * (1 - 0.35 * jaw), c.y * 1.12, max(c.z, -0.55) * 0.85))
    bmesh.ops.scale(skull, vec=Vector((0.1, 0.1, 0.1)), verts=skull.verts)

    def skull_paint(co, n, poly):
        return mix(shade, bone, smoothstep(-0.05, 0.05, co.z))

    # The face (+Y) tips up toward the sky so the sockets show from the camera above; the
    # sockets are dark lenses set into it, too small to paint with this few vertices.
    pose = Matrix.Translation((0, 0, 0.06)) @ rotation('X', 55)
    b.add(skull, nature_material(), skull_paint, pose)
    for s in (-1, 1):
        eye = ico(1.0, 1)
        bmesh.ops.scale(eye, vec=Vector((0.026, 0.012, 0.022)), verts=eye.verts)
        b.add(eye, nature_material(), lambda co, n, p: socket, pose @ Matrix.Translation((s * 0.036, 0.094, 0.014)))
    nose = ico(1.0, 1)
    bmesh.ops.scale(nose, vec=Vector((0.011, 0.01, 0.014)), verts=nose.verts)
    b.add(nose, nature_material(), lambda co, n, p: socket, pose @ Matrix.Translation((0, 0.108, -0.02)))

    def bone_paint(co, n, poly):
        return mix(shade, bone, smoothstep(-0.01, 0.03, co.z))

    for x, y, a, length in ((0.2, -0.04, 70, 0.34), (0.12, 0.16, 5, 0.26)):
        d = Vector((math.cos(math.radians(a)), math.sin(math.radians(a)), 0))
        side = Vector((-d.y, d.x, 0))
        c = Vector((x, y, 0.02))
        # Knobbed ends: two knuckles each side of a thin shaft.
        verts = [c - d * length / 2 - side * 0.018, c - d * length / 2 + side * 0.018, c - d * length * 0.38,
                 c + d * length * 0.38, c + d * length / 2 - side * 0.018, c + d * length / 2 + side * 0.018]
        edges = [(0, 2), (1, 2), (2, 3), (3, 4), (3, 5)]
        radii = [0.02, 0.02, 0.012, 0.012, 0.02, 0.02]
        bm = skin(verts, edges, radii, root=2, smoothing=0.8)
        decimate(bm, 110)
        b.add(bm, nature_material(), bone_paint)
    return _grown(b.finish('decor_bones', ao=dict(samples=16, distance=0.1, strength=0.5)), 1.35)


# ---------------------------------------------------------------------------------------------
# The scorched centre


def stump():
    """A burnt-out stump, split and jagged on top, still smouldering in its cracks."""
    rng = random.Random(18)
    b = Builder()
    char = srgb(0x1E1A18)
    ash = srgb(0x5A524C)
    sides = 10
    prof = [(0.24, -0.08), (0.2, 0.0), (0.17, 0.12), (0.15, 0.3)]
    bm = lathe(prof, sides, cap_top=True, cap_bottom=False, phase=0.3)
    top = [v for v in bm.verts if v.co.z > 0.29]
    for v in top:
        # Splintered, uneven break.
        v.co.z += rng.uniform(-0.12, 0.1)
    off = Vector((18, 0, 0))
    for v in bm.verts:
        d = Vector((v.co.x, v.co.y, 0))
        if d.length > 1e-5:
            v.co += d.normalized() * fbm(v.co * 12 + off) * 0.02

    def paint(co, n, poly):
        # Charcoal, greying to ash on the upper rim.
        return mix(char, ash, smoothstep(0.1, 0.4, co.z) * 0.6 + 0.2 * (0.5 + 0.5 * fbm(co * 14 + off)))

    b.add(bm, nature_material(), paint)
    # Embers glowing in the break and at the foot.
    for k in range(5):
        a = rng.uniform(0, 2 * math.pi)
        at = Vector((math.cos(a) * 0.12, math.sin(a) * 0.12, rng.uniform(0.18, 0.3))) if k < 3 else Vector((math.cos(a) * 0.26, math.sin(a) * 0.26, 0.0))
        ember = ico(rng.uniform(0.025, 0.04), 0, at)
        b.add(ember, ember_material(), _untinted)
    return _grown(b.finish('decor_stump', ao=dict(samples=16, distance=0.2, strength=0.5), sharp_angle=50), 1.2)


def embers():
    """A low mound of ash with a few coals still glowing in it."""
    rng = random.Random(19)
    b = Builder()
    ash = srgb(0x4E4744)
    dark = srgb(0x221D1C)
    mound = ico(1.0, 2)
    off = Vector((19, 0, 0))
    for v in mound.verts:
        d = v.co.normalized()
        v.co = d * (1 + 0.18 * fbm(d * 2 + off))
    bmesh.ops.scale(mound, vec=Vector((0.32, 0.26, 0.09)), verts=mound.verts)
    b.add(mound, nature_material(), lambda co, n, p: mix(dark, ash, smoothstep(-0.02, 0.07, co.z) * (0.8 + 0.4 * fbm(co * 16 + off))))
    for _ in range(4):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.04, 0.2)
        coal = ico(rng.uniform(0.03, 0.05), 0, (math.cos(a) * r, math.sin(a) * r * 0.8, 0.05))
        b.add(coal, ember_material(), _untinted)
    return _grown(b.finish('decor_embers', ao=dict(samples=16, distance=0.15, strength=0.5), sharp_angle=50), 1.3)


def build_all():
    return [grass(), grass_dry(), flowers(), bush(), mushrooms(), pebbles(), twigs(), bones(), stump(), embers()]
