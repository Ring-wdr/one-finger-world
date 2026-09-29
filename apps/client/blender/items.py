"""
Loot and projectiles: a potion (stat item), a clasped spellbook (skill), an open grimoire with a
floating crystal (bridge/legendary) and an arrow. Loot stands upright since the renderer spins
it; the manifest normalises its height. The arrow points along Blender +Y (the game's forward)
and is centred on its flight point.
"""
import math
import random

import bmesh
from mathutils import Matrix, Vector

from common import Builder, box, fbm, ico, lathe, material, mix, rotation, smoothstep, srgb, torus

WHITE = Vector((1, 1, 1))


def untinted(co, n, poly):
    """For materials that carry their own colour (glass, gems, liquid)."""
    return WHITE


def solid(hex_color, grain=0.0, seed=0):
    """A flat colour, optionally with a little noise so large faces aren't dead flat."""
    c = srgb(hex_color)
    off = Vector((seed, seed * 0.5, 0))

    def paint(co, n, poly):
        return c * (1 + grain * fbm(co * 18 + off)) if grain else c

    return paint


def item_material():
    return material('item', roughness=0.62)


def glass_material():
    return material('glass', color=0xDDF4FF, roughness=0.08, alpha=0.32)


def glow_material(name, color, emissive, strength=0.8):
    return material(name, color=color, roughness=0.3, emissive=emissive, emissive_strength=strength)


def _worn(hex_color, edge_hex, center, size, seed):
    """
    Leather that lightens toward the rim of a board (a box of `size` at `center`), as if rubbed.
    The rim is measured on the board's two long axes.
    """
    base = srgb(hex_color)
    edge = srgb(edge_hex)
    off = Vector((seed, 0, 0))
    long_axes = sorted(range(3), key=lambda i: size[i])[1:]

    def paint(co, n, poly):
        d = min(size[i] / 2 - abs(co[i] - center[i]) for i in long_axes)
        c = mix(edge, base, smoothstep(0.0, 0.05, d))
        return c * (1 + 0.1 * fbm(co * 14 + off))

    return paint


# ---------------------------------------------------------------------------------------------
# Potion


def potion():
    b = Builder()
    glass = [
        (0.0, 0.0), (0.12, 0.0), (0.168, 0.035), (0.196, 0.12), (0.192, 0.22), (0.165, 0.29),
        (0.105, 0.345), (0.062, 0.375), (0.055, 0.45), (0.07, 0.47), (0.072, 0.5), (0.058, 0.51),
    ]
    b.add(lathe(glass, 22, cap_top=True, cap_bottom=False), glass_material(), untinted)
    liquid = [(0.0, 0.012), (0.11, 0.014), (0.158, 0.045), (0.182, 0.12), (0.18, 0.2), (0.168, 0.235), (0.0, 0.235)]
    b.add(lathe(liquid, 22, cap_top=False, cap_bottom=False), glow_material('potion_liquid', 0xFF4868, 0xC0122E, 0.9), untinted)
    # Bubbles suspended in the liquid.
    rng = random.Random(3)
    for _ in range(5):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.03, 0.12)
        b.add(ico(rng.uniform(0.012, 0.022), 1, (r * math.cos(a), r * math.sin(a), rng.uniform(0.06, 0.2))),
              glow_material('potion_bubble', 0xFFD0D8, 0xFF8FA3, 0.9), untinted)
    cork = [(0.0, 0.44), (0.05, 0.44), (0.053, 0.5), (0.064, 0.53), (0.066, 0.58), (0.058, 0.605), (0.0, 0.612)]
    b.add(lathe(cork, 12), item_material(), solid(0xA8784A, 0.12, 1))
    b.add(torus(0.064, 0.011, 16, 6), item_material(), solid(0xD8C49A, 0.1, 2), Matrix.Translation((0, 0, 0.43)))
    b.add(torus(0.066, 0.009, 16, 6), item_material(), solid(0xC9B386, 0.1, 3), Matrix.Translation((0, 0, 0.412)))
    # A parchment label wrapped round the belly.
    label = lathe([(0.2, 0.1), (0.203, 0.1), (0.203, 0.19), (0.199, 0.19)], 22, cap_top=False, cap_bottom=False)
    b.add(label, item_material(), _label_paint())
    return b.finish('potion', ao=dict(samples=32, distance=0.15, strength=0.5, ground=False))


def _label_paint():
    paper = srgb(0xEADCB6)
    ink = srgb(0x7A2130)

    def paint(co, n, poly):
        # A crimson band through the middle of the label.
        return mix(paper, ink, smoothstep(0.012, 0.004, abs(co.z - 0.145)))

    return paint


# ---------------------------------------------------------------------------------------------
# Books


def _page_block(size, center, stripes=10, seed=0):
    """Pages as a box sliced into leaves, so the edges show alternating page lines."""
    bm = box(size, center)
    x0 = center[0] - size[0] / 2
    for i in range(1, stripes):
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(x0 + size[0] * i / stripes, 0, 0), plane_no=(1, 0, 0))
    paper = srgb(0xEFE2C2)
    shade = srgb(0xC9B48C)

    def paint(co, n, poly):
        c = poly.center
        leaf = int((c.x - x0) / size[0] * stripes)
        facing_edge = abs(poly.normal.x) < 0.5
        return mix(paper, shade, 0.45 if facing_edge and leaf % 2 else 0.0) * (1 + 0.04 * fbm(co * 20 + Vector((seed, 0, 0))))

    return bm, paint


def _gem(radius, center, facing):
    """A cut gem: an elongated octahedron-like bipyramid, set flat against a cover."""
    bm = bmesh.new()
    rim = [bm.verts.new((0, radius * math.cos(a), radius * math.sin(a) * 1.25)) for a in (2 * math.pi * i / 8 for i in range(8))]
    top = bm.verts.new((radius * 0.7 * facing, 0, 0))
    bot = bm.verts.new((-radius * 0.2 * facing, 0, 0))
    for i in range(8):
        j = (i + 1) % 8
        bm.faces.new((rim[i], rim[j], top))
        bm.faces.new((rim[j], rim[i], bot))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return bm


def book_closed():
    """A clasped spellbook standing on its tail edge; the spine faces −Y."""
    b = Builder()
    item = item_material()
    gold = solid(0xD9A844, 0.1, 5)
    th, w, h = 0.27, 0.42, 0.56
    board = 0.032
    for side in (-1, 1):
        x = side * (th / 2 - board / 2)
        b.add(box((board, w, h), (x, 0.01, 0), bevel=0.008, segments=2), item, _worn(0x3A2C6E, 0x6F5BAA, (x, 0.01, 0), (board, w, h), side))
        # Gold corner caps on the fore edge.
        for zs in (-1, 1):
            b.add(box((board + 0.012, 0.075, 0.075), (x, w / 2 - 0.028, zs * (h / 2 - 0.028)), bevel=0.01), item, gold)
        # Emblem: gold ring with a gem, and a gold fillet framing the cover.
        ring = torus(0.1, 0.016, 20, 6)
        b.add(ring, item, gold, Matrix.Translation((side * (th / 2 + 0.004), 0.03, 0.02)) @ rotation('Y', 90))
        b.add(_gem(0.07, (side * (th / 2 + 0.004), 0.03, 0.02), side), glow_material('gem_blue', 0x7FE3FF, 0x2FB4FF, 0.9), untinted)
        # A four-segment torus is a square ring; turned 45° its corners sit on the diagonals.
        frame = torus(1.0, 0.03, 4, 4)
        bmesh.ops.transform(frame, matrix=rotation('Z', 45), verts=frame.verts)
        bmesh.ops.scale(frame, vec=Vector((0.235 / math.sqrt(0.5), 0.165 / math.sqrt(0.5), 0.35)), verts=frame.verts)
        b.add(frame, item, gold, Matrix.Translation((side * (th / 2 + 0.002), 0.025, 0)) @ rotation('Y', 90))
    pages, paint = _page_block((th - 2 * board + 0.004, w - 0.03, h - 0.03), (0, 0.02, 0), seed=1)
    b.add(pages, item, paint)
    # A gently rounded spine, darker than the boards, with two thin gilt bands.
    bulge = 0.3
    spine = lathe([(0.0, -h / 2), (th / 2, -h / 2), (th / 2, h / 2), (0.0, h / 2)], 16)
    for v in spine.verts:
        v.co.y = min(v.co.y, 0) * bulge
    b.add(spine, item, _worn(0x271D4A, 0x4A3B7C, (0, 0, 0), (th, th, h), 3), Matrix.Translation((0, -w / 2 + 0.012, 0)))
    for z in (-0.16, 0.16):
        band = lathe([(0.0, z - 0.01), (th / 2 + 0.004, z - 0.01), (th / 2 + 0.004, z + 0.01), (0.0, z + 0.01)], 16)
        for v in band.verts:
            v.co.y = min(v.co.y, 0) * (bulge + 0.04)
        b.add(band, item, gold, Matrix.Translation((0, -w / 2 + 0.012, 0)))
    # Leather strap round the fore edge with a buckle on the front.
    strap = box((th + 0.02, 0.05, 0.075), (0, w / 2 + 0.004, -0.02), bevel=0.01, segments=2)
    b.add(strap, item, solid(0x5A3A26, 0.12, 7))
    b.add(box((0.012, 0.09, 0.075), (th / 2 + 0.012, w / 2 - 0.06, -0.02), bevel=0.004), item, solid(0x5A3A26, 0.12, 8))
    b.add(box((0.018, 0.05, 0.095), (th / 2 + 0.018, w / 2 - 0.085, -0.02), bevel=0.008), item, gold)
    return b.finish('book_closed', ao=dict(samples=32, distance=0.12, strength=0.55, ground=False), sharp_angle=35)


def book_open():
    """An open grimoire standing in a wide V, pages mid-turn, a crystal hovering over the spine."""
    b = Builder()
    item = item_material()
    gold = solid(0xE0B04C, 0.1, 11)
    w, h = 0.4, 0.56
    open_deg = 28  # each half's tilt out of the flat plane, toward +Y
    for side in (-1, 1):
        # Each half is built flat along +X from the spine, pages on +Y, then mirrored (left) and
        # hinged open toward +Y.
        hinge = rotation('Z', side * open_deg) @ Matrix.Diagonal((side, 1, 1, 1))
        # Boards start just off the hinge line so the two halves never share a face.
        b.add(box((w - 0.012, 0.026, h), (w / 2 + 0.006, 0, 0), bevel=0.007, segments=2), item, _worn(0x6A1F2C, 0xA9474F, (w / 2 + 0.006, 0, 0), (w - 0.012, 0.026, h), side), hinge)
        for zs in (-1, 1):
            b.add(box((0.075, 0.038, 0.075), (w - 0.028, 0, zs * (h / 2 - 0.028)), bevel=0.01), item, gold, hinge)
        # Pages bow up from the spine.
        pages = bmesh.new()
        bmesh.ops.create_grid(pages, x_segments=10, y_segments=2, size=0.5)
        for v in pages.verts:
            u = v.co.x + 0.5  # 0 at the spine, 1 at the fore edge
            v.co = Vector((u * (w - 0.025) + 0.005, 0.016 + 0.05 * math.sin(math.pi * min(1.0, u * 1.15)) ** 0.7, v.co.y * (h - 0.03)))
        solid_pages = bmesh.ops.extrude_face_region(pages, geom=list(pages.faces))
        moved = [e for e in solid_pages['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.translate(pages, vec=Vector((0, -0.028, 0)), verts=moved)
        b.add(pages, item, _open_pages(w), hinge)
    # Two loose pages lifting in the middle.
    for k, (lift, bend) in enumerate(((58, 0.05), (78, 0.035))):
        page = bmesh.new()
        bmesh.ops.create_grid(page, x_segments=8, y_segments=1, size=0.5)
        for v in page.verts:
            u = v.co.x + 0.5
            v.co = Vector((u * (w - 0.04), bend * math.sin(math.pi * u), v.co.y * (h - 0.05)))
        both = bmesh.ops.extrude_face_region(page, geom=list(page.faces))
        bmesh.ops.translate(page, vec=Vector((0, -0.004, 0)), verts=[e for e in both['geom'] if isinstance(e, bmesh.types.BMVert)])
        bmesh.ops.recalc_face_normals(page, faces=page.faces)
        b.add(page, item, _open_pages(w), Matrix.Translation((0, 0.03, 0)) @ rotation('Z', lift))
    # The spine: a rounded leather ridge behind the hinge.
    spine = lathe([(0.0, -h / 2), (0.034, -h / 2), (0.034, h / 2), (0.0, h / 2)], 12)
    b.add(spine, item, solid(0x5A1824, 0.12, 13), Matrix.Translation((0, -0.012, 0)))
    # A crystal hovering above: the legendary tell.
    crystal = bmesh.new()
    rim = [crystal.verts.new((0.07 * math.cos(a), 0.07 * math.sin(a), 0)) for a in (2 * math.pi * i / 6 for i in range(6))]
    top = crystal.verts.new((0, 0, 0.16))
    bot = crystal.verts.new((0, 0, -0.1))
    for i in range(6):
        j = (i + 1) % 6
        crystal.faces.new((rim[i], rim[j], top))
        crystal.faces.new((rim[j], rim[i], bot))
    bmesh.ops.recalc_face_normals(crystal, faces=crystal.faces)
    b.add(crystal, glow_material('gem_gold', 0xFFE08A, 0xFFB020, 1.0), untinted, Matrix.Translation((0, 0.08, h / 2 + 0.2)) @ rotation('Z', 15))
    return b.finish('book_open', ao=dict(samples=32, distance=0.12, strength=0.5, ground=False), sharp_angle=35)


def _open_pages(w):
    paper = srgb(0xF2E6C8)
    shade = srgb(0xCDB892)
    ink = srgb(0x5C3B2E)

    def paint(co, n, poly):
        # Darker toward the gutter, with faint lines of script across the page.
        u = co.x / w
        c = mix(shade, paper, smoothstep(0.02, 0.3, u))
        rows = 0.5 + 0.5 * math.sin(co.z * 160)
        return mix(c, ink, 0.18 * rows * smoothstep(0.15, 0.25, u) * smoothstep(0.95, 0.8, u))

    return paint


# ---------------------------------------------------------------------------------------------
# Arrow


def arrow():
    b = Builder()
    item = item_material()
    shaft = lathe([(0.0, -0.47), (0.016, -0.47), (0.016, 0.33), (0.0, 0.33)], 7)
    b.add(shaft, item, _shaft_paint(), rotation('X', -90))
    # Steel socket and broadhead, tip at +Y.
    socket = lathe([(0.0, 0.3), (0.021, 0.3), (0.019, 0.37), (0.0, 0.372)], 7)
    b.add(socket, item, solid(0x7B828C, 0.1, 21), rotation('X', -90))
    head = bmesh.new()
    tip = head.verts.new((0, 0.52, 0))
    back = head.verts.new((0, 0.345, 0))
    left = head.verts.new((-0.06, 0.39, 0))
    right = head.verts.new((0.06, 0.39, 0))
    barb_l = head.verts.new((-0.045, 0.35, 0))
    barb_r = head.verts.new((0.045, 0.35, 0))
    up = head.verts.new((0, 0.41, 0.013))
    down = head.verts.new((0, 0.41, -0.013))
    for ridge in (up, down):
        for a, c in ((tip, left), (right, tip), (left, barb_l), (barb_r, right), (barb_l, back), (back, barb_r)):
            head.faces.new((a, c, ridge) if ridge is up else (c, a, ridge))
    bmesh.ops.recalc_face_normals(head, faces=head.faces)
    b.add(head, item, _steel_paint())
    # Fletching: three vanes, one white cock feather.
    for k in range(3):
        vane = bmesh.new()
        pts = [(0.014, -0.44), (0.014, -0.2), (0.05, -0.27), (0.074, -0.4), (0.07, -0.45)]
        front = [vane.verts.new((x, y, 0.002)) for x, y in pts]
        backs = [vane.verts.new((x, y, -0.002)) for x, y in pts]
        vane.faces.new(front)
        vane.faces.new(list(reversed(backs)))
        for i in range(len(pts)):
            j = (i + 1) % len(pts)
            vane.faces.new((front[i], backs[i], backs[j], front[j]))
        bmesh.ops.recalc_face_normals(vane, faces=vane.faces)
        b.add(vane, item, _feather_paint(0xF1EBDD if k == 0 else 0xD2473A), rotation('Y', 90 + k * 120))
    nock = lathe([(0.0, -0.49), (0.02, -0.49), (0.02, -0.465), (0.0, -0.465)], 7)
    b.add(nock, item, solid(0x2E2420), rotation('X', -90))
    return b.finish('arrow', sharp_angle=40)


def _shaft_paint():
    wood = srgb(0xB88B55)
    dark = srgb(0x6B4A2C)
    wrap = srgb(0x3B2A22)

    def paint(co, n, poly):
        # Binding wraps behind the head and at the fletching.
        y = co.z  # the lathe axis, before it was laid along +Y
        bound = any(a < y < b for a, b in ((0.28, 0.31), (-0.21, -0.18), (-0.45, -0.43)))
        return wrap if bound else mix(dark, wood, 0.6 + 0.4 * fbm(Vector((0, y * 6, 0))))

    return paint


def _steel_paint():
    steel = srgb(0xD8DDE4)
    edge = srgb(0x8D949E)

    def paint(co, n, poly):
        return mix(edge, steel, smoothstep(0.0, 0.012, abs(co.z)) * 0.3 + 0.7 * (1 - smoothstep(0.03, 0.06, abs(co.x))))

    return paint


def _feather_paint(hex_color):
    c = srgb(hex_color)
    tip = c * 0.6

    def paint(co, n, poly):
        return mix(c, tip, smoothstep(-0.25, -0.44, co.y) * 0.6)

    return paint


def build_all():
    return [arrow(), book_closed(), book_open(), potion()]
