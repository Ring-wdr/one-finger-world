"""
Map props: rocks, pines and dead trees. Each is one mesh with one vertex-coloured material, so
a variant is a single instanced draw call. Sizes are in game units (1 = 1 m, a fighter is ~2
tall) and every prop's pivot sits at its base.

Rock footprints (farthest vertex from the pivot on the ground) must match `PROP_VARIANTS` in
packages/sim/src/obstacles.ts, which sizes their collision circles; the build checks it.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

from common import Builder, cut_flat_below, fbm, lathe, material, mix, rotation, smoothstep, srgb

# Rock name → (footprint, height). Footprints are PROP_VARIANTS.rock.
ROCKS = {
    'rock_a': (0.785, 0.36),
    'rock_b': (0.785, 0.64),
    'rock_c': (0.935, 0.95),
    'rock_d': (0.78, 0.82),
    'rock_e': (1.3, 0.98),
}


def nature_material():
    return material('nature', roughness=0.92)


def _jitter(i, seed=0):
    """Stable per-face value in [−1, 1]."""
    return random.Random(i * 7919 + seed).uniform(-1, 1)


# ---------------------------------------------------------------------------------------------
# Rocks


def _boulder(rng, points, stretch, cuts=3):
    """
    A chiselled boulder: the convex hull of points scattered over a squashed sphere gives big
    flat facets, and a few deep planar cuts break the symmetry into ledges.
    """
    bm = bmesh.new()
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(points):
        # Fibonacci sphere, jittered, so facets come out evenly sized but never regular.
        z = 1 - 2 * (i + 0.5) / points
        r = math.sqrt(1 - z * z)
        a = golden * i + rng.uniform(-0.35, 0.35)
        d = Vector((r * math.cos(a), r * math.sin(a), z + rng.uniform(-0.12, 0.12))).normalized()
        k = rng.uniform(0.82, 1.0)
        bm.verts.new((d.x * stretch[0] * k, d.y * stretch[1] * k, d.z * stretch[2] * k))
    bmesh.ops.convex_hull(bm, input=bm.verts)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(4), verts=bm.verts, edges=bm.edges)
    for _ in range(cuts):
        a = rng.uniform(0, 2 * math.pi)
        el = rng.uniform(0.1, 1.45)
        n = Vector((math.cos(a) * math.cos(el), math.sin(a) * math.cos(el), math.sin(el))).normalized()
        far = max(v.co.dot(n) for v in bm.verts)
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=n * far * rng.uniform(0.7, 0.85), plane_no=n, clear_outer=True)
        edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    return bm


def _chamfer(bm, width, rng):
    """Bevels every hard edge so it catches a rim of light, then roughens the surface a touch."""
    bm.normal_update()
    hard = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(18)]
    bmesh.ops.bevel(bm, geom=hard, offset=width, segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
    off = Vector((rng.uniform(0, 60), rng.uniform(0, 60), 0))
    for v in bm.verts:
        if v.co.z > 0.01:
            v.co += Vector((fbm(v.co * 5 + off), fbm(v.co * 5 + off + Vector((7, 0, 0))), fbm(v.co * 5 + off + Vector((0, 7, 0))))) * width * 0.35


def _fit(bm, footprint, height, bury=0.06):
    """Flat base slightly below ground, centred, with the farthest vertex exactly `footprint` out."""
    zmin = min(v.co.z for v in bm.verts)
    zmax = max(v.co.z for v in bm.verts)
    cut_flat_below(bm, zmin + (zmax - zmin) * 0.18)
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zmin = min(v.co.z for v in bm.verts)
    zmax = max(v.co.z for v in bm.verts)
    bmesh.ops.translate(bm, vec=Vector((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -zmin)), verts=bm.verts)
    reach = max(math.hypot(v.co.x, v.co.y) for v in bm.verts)
    k = footprint / reach
    bmesh.ops.scale(bm, vec=Vector((k, k, (height + bury) / (zmax - zmin))), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector((0, 0, -bury)), verts=bm.verts)


def _rock_painter(height, seed):
    base = srgb(0x6C7079)
    warm = srgb(0x77766C)
    dark = srgb(0x383A41)
    lichen = srgb(0x6E7A45)
    off = Vector((seed * 3.1, seed * 1.7, 0))

    def paint(co, n, poly):
        # Facets are large and have few vertices, so colour is decided mostly per facet (from its
        # centre) and only shaded per vertex: each face reads as one chiselled plane.
        fc = poly.center
        fn = poly.normal
        c = mix(base, warm, 0.5 + 0.9 * fbm(fc * 1.3 + off))
        # Lichen caps some of the upward facets.
        up = smoothstep(0.5, 0.85, fn.z) * smoothstep(-0.05, 0.25, fbm(fc * 1.7 + off + Vector((9, 0, 0)), 2))
        c = mix(c, lichen, up * 0.7)
        # Soil-stained where it meets the ground.
        c = mix(dark * 0.8, c, smoothstep(-0.05, height * 0.35, co.z))
        # Each facet catches the light a little differently.
        return c * (1 + 0.11 * _jitter(poly.index, seed))

    return paint


def rock(name):
    footprint, height = ROCKS[name]
    seed = sum(map(ord, name))
    rng = random.Random(seed)
    b = Builder()
    mat = nature_material()
    # Chunks: (x, y, footprint, height, stretch, tilt°). Overlapping chunks leave crevices the
    # occlusion pass darkens, which reads far better than one convex lump.
    chunks = {
        'rock_a': [(0, 0, 0.62, 0.3, (1.2, 0.95, 0.45), 4), (0.3, 0.2, 0.36, 0.36, (1.0, 0.9, 0.7), -10)],
        'rock_b': [(-0.08, 0.04, 0.6, 0.64, (1.0, 0.9, 0.85), 0), (0.34, -0.22, 0.34, 0.36, (1.0, 0.8, 0.8), 12)],
        'rock_c': [
            (0.05, 0.08, 0.66, 0.95, (0.95, 0.9, 1.1), -5),
            (-0.44, -0.2, 0.38, 0.5, (1.0, 0.85, 0.8), 14),
            (0.4, -0.36, 0.3, 0.3, (1.0, 0.9, 0.7), -8),
        ],
        'rock_d': [(0, 0.05, 0.46, 0.82, (0.8, 0.7, 1.35), 9), (-0.3, -0.3, 0.36, 0.3, (1.1, 0.9, 0.6), -6)],
        'rock_e': [
            (-0.22, 0.12, 0.86, 0.98, (1.1, 0.9, 1.0), 0),
            (0.62, -0.3, 0.46, 0.55, (1.0, 0.85, 0.9), 10),
            (-0.05, -0.72, 0.38, 0.38, (1.0, 0.85, 0.8), -12),
            (0.55, 0.45, 0.3, 0.24, (1.0, 0.9, 0.6), 6),
        ],
    }[name]
    for k, (dx, dy, fp, h, stretch, tilt) in enumerate(chunks):
        crng = random.Random(seed * 13 + k)
        bm = _boulder(crng, 34 if k == 0 else 24, stretch, cuts=5 if k == 0 else 3)
        if tilt:
            bmesh.ops.transform(bm, matrix=rotation('Y', tilt), verts=bm.verts)
        _fit(bm, fp, h)
        _chamfer(bm, 0.045 if k == 0 else 0.03, crng)
        spin = Matrix.Translation((dx, dy, 0)) @ rotation('Z', crng.uniform(0, 360))
        b.add(bm, mat, _rock_painter(height, seed + k), spin)
    obj = b.finish(name, ao=dict(samples=48, distance=0.5, strength=0.7), sharp_angle=40)
    _refit_footprint(obj, footprint)
    return obj


def _refit_footprint(obj, footprint):
    """Cluster parts were placed after fitting; rescale in the plane so the footprint is exact."""
    reach = max(math.hypot(v.co.x, v.co.y) for v in obj.data.vertices)
    k = footprint / reach
    for v in obj.data.vertices:
        v.co.x *= k
        v.co.y *= k


# ---------------------------------------------------------------------------------------------
# Pines


def _trunk(height, r0, r1, rng, roots=5, sides=9):
    """Tapered trunk with flared roots digging into the ground."""
    prof = [(r0 * 1.05, -0.12), (r0, 0.0), (r0 * 0.82, 0.18)]
    steps = 5
    for i in range(1, steps + 1):
        t = i / steps
        prof.append((r0 * 0.82 + (r1 - r0 * 0.82) * t, 0.18 + (height - 0.18) * t))
    prof.append((0, height + 0.02))
    bm = lathe(prof, sides, cap_top=False, phase=rng.uniform(0, 1))
    # Knobbly bark.
    off = Vector((rng.uniform(0, 40), 0, 0))
    for v in bm.verts:
        d = Vector((v.co.x, v.co.y, 0))
        if d.length > 1e-5:
            v.co += d.normalized() * fbm(v.co * 6 + off) * 0.018
    # Root flares: pull the base ring out in a few directions.
    base = [v for v in bm.verts if v.co.z < 0.2]
    for k in range(roots):
        a = 2 * math.pi * (k + rng.uniform(-0.2, 0.2)) / roots
        dirn = Vector((math.cos(a), math.sin(a), 0))
        for v in base:
            d = Vector((v.co.x, v.co.y, 0))
            if d.length < 1e-5:
                continue
            align = max(0.0, d.normalized().dot(dirn)) ** 6
            lift = 1 - smoothstep(-0.12, 0.2, v.co.z)
            v.co += dirn * align * lift * r0 * 0.9
    return bm


def _tier(radius, height, spikes, droop, rng, rings=4):
    """
    One skirt of needles: a domed cone whose rim is star-shaped and droops at the tips, closed
    underneath so the shadow and the silhouette from below stay solid.
    """
    bm = bmesh.new()
    n = spikes * 2
    phase = rng.uniform(0, 2 * math.pi)
    top = bm.verts.new((0, 0, height))
    # Each needle clump has its own length, shared down its column so it reads as one spike.
    reach = [rng.uniform(0.86, 1.12) if i % 2 == 0 else 1.0 for i in range(n)]
    swing = [rng.uniform(-0.06, 0.06) for _ in range(n)]
    rows = []
    for j in range(1, rings + 1):
        t = j / rings
        row = []
        for i in range(n):
            tip = i % 2 == 0
            a = phase + 2 * math.pi * i / n + swing[i] * t
            star = (1.0 if tip else 0.6) if j == rings else (1.0 if tip else 0.86)
            star = 1 + (star - 1) * t ** 1.5
            r = radius * math.sin(t * math.pi / 2) ** 0.8 * star * (reach[i] if tip else 1) ** t
            z = height * (1 - t) - (droop * reach[i] * t ** 3 if tip else droop * 0.2 * t ** 3)
            row.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        rows.append(row)
    for i in range(n):
        bm.faces.new((top, rows[0][i], rows[0][(i + 1) % n]))
    for a, b in zip(rows, rows[1:]):
        for i in range(n):
            k = (i + 1) % n
            bm.faces.new((a[i], b[i], b[k], a[k]))
    # Underside: rim up to a hub inside the cone.
    hub = bm.verts.new((0, 0, height * 0.28))
    rim = rows[-1]
    for i in range(n):
        bm.faces.new((rim[(i + 1) % n], rim[i], hub))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def _pine_painter(height, radius, needles, needles_light, needles_dark, seed):
    bark = srgb(0x5B3F2C)
    bark_dark = srgb(0x3A281D)
    off = Vector((seed, 0, 0))

    def paint_bark(co, n, poly):
        streak = 0.5 + 0.5 * fbm(Vector((co.x * 9, co.y * 9, co.z * 1.5)) + off)
        c = mix(bark_dark, bark, streak)
        return mix(bark_dark * 0.6, c, smoothstep(-0.1, 0.25, co.z))

    def paint_needles(tone):
        """Coloured in the whole tree's space; each tier gets its own slight `tone`."""

        def paint(co, n, poly):
            h = co.z / height
            r = math.hypot(co.x, co.y)
            c = mix(needles_dark, needles, smoothstep(0.0, 0.9, h * 0.6 + r * 0.9))
            # Outer tips and the crown catch the low sun.
            c = mix(c, needles_light, smoothstep(0.45, 1.0, r / radius) * 0.55 + smoothstep(0.75, 1.0, h) * 0.35)
            # Undersides stay in shade (by face, so the top surface keeps shared vertices).
            if poly.normal.z < -0.2:
                c = mix(c, needles_dark * 0.7, 0.7)
            return c * (1 + 0.07 * fbm(co * 5 + off)) * tone

        return paint

    return paint_bark, paint_needles


def pine(name):
    """`tree_a`: a tall slender pine. `tree_b`: a fuller, bluer fir."""
    seed = sum(map(ord, name))
    rng = random.Random(seed)
    if name == 'tree_a':
        height, tiers, base_r, spikes = 2.8, 6, 0.72, 9
        colors = (srgb(0x356C40), srgb(0x7FAA56), srgb(0x1C3B27))
    else:
        height, tiers, base_r, spikes = 2.6, 7, 0.86, 10
        colors = (srgb(0x306553), srgb(0x70A283), srgb(0x1A3730))
    paint_bark, paint_needles = _pine_painter(height, base_r, *colors, seed)
    b = Builder()
    mat = nature_material()
    b.add(_trunk(height * 0.62, 0.2, 0.06, rng), mat, paint_bark)
    lowest = 0.5 if name == 'tree_a' else 0.38
    for i in range(tiers):
        t = i / (tiers - 1)
        # Tiers overlap: each skirt starts under the one above it.
        z0 = lowest + (height - lowest) * (t ** 0.92) * 0.78
        th = (height - lowest) * (0.42 - 0.12 * t)
        if i == tiers - 1:
            th = height - z0
        r = base_r * (1 - t * 0.78) * rng.uniform(0.95, 1.05)
        tier = _tier(r, th, spikes - (i // 2), droop=0.16 * (1 - t) + 0.05, rng=rng)
        lean = rotation('X', rng.uniform(-4, 4)) @ rotation('Y', rng.uniform(-4, 4))
        place = Matrix.Translation((rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02), z0)) @ lean
        b.add(tier, mat, paint_needles(rng.uniform(0.93, 1.07)), place, local=False)
    return b.finish(name, ao=dict(samples=40, distance=0.9, strength=0.6), sharp_angle=50)


# ---------------------------------------------------------------------------------------------
# Dead trees


def _branch_graph(rng, spec):
    """
    Grows a skeleton of (position, radius) nodes: a wandering trunk that forks, each branch
    thinner and more crooked than its parent. Returns verts, edges, radii.
    """
    verts, edges, radii = [], [], []

    def node(p, r):
        verts.append(p.copy())
        radii.append(r)
        return len(verts) - 1

    def grow(start_idx, direction, length, r0, depth):
        idx = start_idx
        p = verts[start_idx].copy()
        d = direction.normalized()
        segs = max(2, int(length / spec['seg']))
        forks = spec['forks'][depth] if depth < len(spec['forks']) else 0
        fork_at = sorted(rng.sample(range(1, segs), min(forks, segs - 1))) if forks else []
        for s in range(1, segs + 1):
            t = s / segs
            # Crooked: a random kink every segment; side branches also bend upward (`rise`).
            kink = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.3, 0.5))) * spec['crook'] * (1 + depth * 0.6)
            d = (d + kink).normalized()
            if depth > 0:
                d = (d + Vector((0, 0, spec['rise']))).normalized()
            p = p + d * (length / segs)
            r = r0 * (1 - t * 0.72)
            nxt = node(p, max(r, spec['tip']))
            edges.append((idx, nxt))
            idx = nxt
            if s in fork_at and depth + 1 < spec['depth']:
                side = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0))
                if side.length < 1e-3:
                    side = Vector((1, 0, 0))
                side.normalize()
                bd = (d * math.cos(math.radians(spec['angle'])) + side * math.sin(math.radians(spec['angle']))).normalized()
                grow(idx, bd, length * (1 - t) * rng.uniform(0.7, 1.05) + length * 0.2, max(r * 0.62, spec['tip']), depth + 1)

    root = node(Vector((0, 0, -0.15)), spec['r0'] * 1.1)
    trunk_base = root + 1  # the first trunk node, just above the ground
    grow(root, Vector((spec['lean'][0], spec['lean'][1], 1)), spec['height'], spec['r0'], 0)
    # Roots: short, fat, diving outward into the ground.
    for k in range(spec['roots']):
        a = 2 * math.pi * (k + rng.uniform(-0.25, 0.25)) / spec['roots']
        prev = trunk_base
        base = Vector((0, 0, 0.06))
        for dist, z, r in ((0.15, 0.03, 0.6), (0.3, -0.04, 0.36), (0.44, -0.14, 0.18)):
            p = base + Vector((math.cos(a), math.sin(a), 0)) * dist * spec['r0'] / 0.2
            p.z = z
            cur = node(p, spec['r0'] * r)
            edges.append((prev, cur))
            prev = cur
    return verts, edges, radii


DEAD_TREES = {
    'dead_tree_small': dict(height=1.8, r0=0.19, seg=0.2, forks=[2, 1], depth=3, angle=42, crook=0.2, rise=0.25, tip=0.009, lean=(0.35, 0.1), roots=4),
    'dead_tree_medium': dict(height=2.15, r0=0.21, seg=0.22, forks=[3, 2, 1], depth=3, angle=38, crook=0.17, rise=0.3, tip=0.009, lean=(-0.15, 0.2), roots=5),
    'dead_tree_large': dict(height=2.55, r0=0.22, seg=0.24, forks=[4, 2, 1], depth=4, angle=40, crook=0.16, rise=0.32, tip=0.008, lean=(0.05, -0.1), roots=5),
}


def dead_tree(name):
    spec = DEAD_TREES[name]
    seed = sum(map(ord, name)) * 3
    rng = random.Random(seed)
    verts, edges, radii = _branch_graph(rng, spec)
    mesh = bpy.data.meshes.new(name + '_skel')
    mesh.from_pydata([tuple(v) for v in verts], edges, [])
    obj = bpy.data.objects.new(name + '_skel', mesh)
    bpy.context.scene.collection.objects.link(obj)
    skin = obj.modifiers.new('skin', 'SKIN')
    skin.branch_smoothing = 0.6
    for i, r in enumerate(radii):
        mesh.skin_vertices[0].data[i].radius = (r, r * rng.uniform(0.85, 1.0))
    mesh.skin_vertices[0].data[0].use_root = True
    sub = obj.modifiers.new('sub', 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 1
    deps = bpy.context.evaluated_depsgraph_get()
    evaluated = bpy.data.meshes.new_from_object(obj.evaluated_get(deps))
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(mesh)

    bm = bmesh.new()
    bm.from_mesh(evaluated)
    bpy.data.meshes.remove(evaluated)
    # Gnarled bark: displace along normals.
    off = Vector((seed, 0, 0))
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * fbm(v.co * 7 + off) * 0.022
    bmesh.ops.triangulate(bm, faces=bm.faces)
    target = {'dead_tree_small': 900, 'dead_tree_medium': 1300, 'dead_tree_large': 1700}[name]
    _decimate(bm, target)

    wood = srgb(0x655A51)
    wood_dark = srgb(0x3A322C)
    bleached = srgb(0xB8AC98)
    char = srgb(0x1E1A17)
    top = spec['height']

    def paint(co, n, poly):
        streak = 0.5 + 0.5 * fbm(Vector((co.x * 10, co.y * 10, co.z * 2)) + off)
        c = mix(wood_dark, wood, streak)
        # Thin, high twigs are sun-bleached; the base is charred and soil-stained.
        c = mix(c, bleached, smoothstep(0.35, 1.0, co.z / top) * 0.5 + smoothstep(0.2, 0.9, n.z) * 0.12)
        c = mix(char, c, smoothstep(-0.1, 0.35, co.z))
        return c

    b = Builder()
    b.add(bm, nature_material(), paint)
    return b.finish(name, ao=dict(samples=36, distance=0.7, strength=0.6), sharp_angle=None)


def _decimate(bm, target_tris):
    tris = len(bm.faces)
    if tris <= target_tris:
        return
    mesh = bpy.data.meshes.new('dec')
    bm.to_mesh(mesh)
    obj = bpy.data.objects.new('dec', mesh)
    bpy.context.scene.collection.objects.link(obj)
    mod = obj.modifiers.new('dec', 'DECIMATE')
    mod.ratio = target_tris / tris
    deps = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(obj.evaluated_get(deps))
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(mesh)
    bm.clear()
    bm.from_mesh(out)
    bpy.data.meshes.remove(out)


def build_all():
    objs = [rock(n) for n in ROCKS]
    objs += [pine('tree_a'), pine('tree_b')]
    objs += [dead_tree(n) for n in DEAD_TREES]
    return objs
