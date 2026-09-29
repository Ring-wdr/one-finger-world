"""
Shared helpers for the procedural prop builders: mesh assembly, per-corner vertex colours,
ray-traced ambient occlusion, shading and glTF export.

Blender is Z-up; the glTF exporter turns that into Y-up, so Blender +Y becomes the game's
forward (−Z) and the XY plane is the ground.
"""
import math
import random

import bmesh
import bpy
from mathutils import Color, Matrix, Vector, noise
from mathutils.bvhtree import BVHTree


# ---------------------------------------------------------------------------------------------
# Scene


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def srgb(hex_color):
    """Hex sRGB → linear RGB, which is what colour attributes and the glTF store."""
    c = Color()
    c.r, c.g, c.b = ((hex_color >> 16) & 255) / 255, ((hex_color >> 8) & 255) / 255, (hex_color & 255) / 255
    return Vector(c.from_srgb_to_scene_linear())


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return a.lerp(b, t)


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def fbm(p, octaves=3):
    """Signed fractal noise, roughly in [−1, 1]."""
    return noise.fractal(Vector(p), 0.5, 2.0, octaves, noise_basis='PERLIN_ORIGINAL')


# ---------------------------------------------------------------------------------------------
# Materials


def material(name, color=0xFFFFFF, roughness=0.8, vertex_colors=True, alpha=1.0, emissive=None, emissive_strength=1.0):
    """
    A Principled material the glTF exporter maps 1:1: base colour × the `Color` attribute,
    roughness, optional alpha blend and emission.
    """
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    # Every prop is a closed mesh: single-sided halves the fill cost (exported as doubleSided false).
    mat.use_backface_culling = True
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*srgb(color), 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    if vertex_colors:
        attr = nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Color'
        if color == 0xFFFFFF:
            mat.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            mul = nodes.new('ShaderNodeMix')
            mul.data_type = 'RGBA'
            mul.blend_type = 'MULTIPLY'
            mul.inputs['Factor'].default_value = 1.0
            mul.inputs['A'].default_value = (*srgb(color), 1)
            mat.node_tree.links.new(attr.outputs['Color'], mul.inputs['B'])
            mat.node_tree.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
    if alpha < 1:
        bsdf.inputs['Alpha'].default_value = alpha
        mat.surface_render_method = 'BLENDED'
    if emissive is not None:
        bsdf.inputs['Emission Color'].default_value = (*srgb(emissive), 1)
        bsdf.inputs['Emission Strength'].default_value = emissive_strength
    return mat


# ---------------------------------------------------------------------------------------------
# Mesh building


class Face:
    """What a painter learns about the face it colours, in the part's own coordinates."""

    __slots__ = ('index', 'normal', 'center')

    def __init__(self, index, normal, center):
        self.index = index
        self.normal = normal
        self.center = center


class Builder:
    """
    Accumulates parts into one bmesh. Each face remembers a material slot and a colour
    function, so a whole prop ends up one mesh (one draw call per material) painted in one pass.
    """

    def __init__(self):
        self.bm = bmesh.new()
        self.materials = []
        self.mat_index = {}
        self.painters = []
        self.paint_layer = self.bm.faces.layers.int.new('painter')

    def slot(self, mat):
        if mat.name not in self.mat_index:
            self.mat_index[mat.name] = len(self.materials)
            self.materials.append(mat)
        return self.mat_index[mat.name]

    def add(self, other, mat, paint, matrix=None, local=True):
        """
        Appends a bmesh (consumed) with a material and a painter `fn(pos, normal, face) -> linear
        rgb`. With `local` the painter sees the part's own coordinates, from before `matrix`
        placed it; otherwise the finished prop's.
        """
        inverse = None
        if matrix is not None:
            bmesh.ops.transform(other, matrix=matrix, verts=other.verts)
            if local:
                inverse = matrix.inverted()
        slot = self.slot(mat)
        self.painters.append((paint, inverse))
        pid = len(self.painters) - 1
        mesh = bpy.data.meshes.new('tmp')
        other.to_mesh(mesh)
        other.free()
        before = set(self.bm.faces)
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)
        for f in self.bm.faces:
            if f not in before:
                f.material_index = slot
                f[self.paint_layer] = pid

    def finish(self, name, ao=None, sharp_angle=None, smooth=True):
        """
        Builds the object. `ao` = dict(samples, distance, strength, ground) darkens corners by
        ray-traced occlusion (self + ground plane); `sharp_angle` (degrees) keeps facets crisp.
        """
        bm = self.bm
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        painter_of = [f[self.paint_layer] for f in bm.faces]
        bm.free()
        for m in self.materials:
            mesh.materials.append(m)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)

        for p in mesh.polygons:
            p.use_smooth = smooth
        if sharp_angle is not None:
            mesh.set_sharp_from_angle(angle=math.radians(sharp_angle))

        occlusion = vertex_ao(obj, **ao) if ao else None
        layer = mesh.color_attributes.new('Color', 'FLOAT_COLOR', 'CORNER')
        mesh.color_attributes.active_color = layer
        mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
        verts = mesh.vertices
        for poly in mesh.polygons:
            fn, inv = self.painters[painter_of[poly.index]]
            face = Face(poly.index, poly.normal.copy(), poly.center.copy())
            if inv is not None:
                face = Face(poly.index, (inv.to_3x3() @ face.normal).normalized(), inv @ face.center)
            for li in poly.loop_indices:
                vi = mesh.loops[li].vertex_index
                co, n = verts[vi].co, verts[vi].normal
                if inv is not None:
                    co, n = inv @ co, (inv.to_3x3() @ n).normalized()
                col = Vector(fn(co, n, face))
                if occlusion is not None:
                    col *= occlusion[vi]
                layer.data[li].color = (col.x, col.y, col.z, 1.0)
        mesh.attributes.remove(mesh.attributes['painter'])
        # Triangulate here, after painting (a facet keeps one colour), with fixed methods: the
        # exporter's own n-gon split doesn't always give the same index order run to run.
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.triangulate(bm, faces=bm.faces, quad_method='FIXED', ngon_method='EAR_CLIP')
        bm.to_mesh(mesh)
        bm.free()
        return obj


def vertex_ao(obj, samples=48, distance=1.0, strength=0.8, ground=True, floor=0.0, seed=7):
    """
    Per-vertex ambient occlusion by cosine-weighted hemisphere rays against the mesh itself and
    (optionally) the ground plane z = `floor`. Returns a brightness multiplier per vertex.
    """
    mesh = obj.data
    bvh = BVHTree.FromPolygons([v.co for v in mesh.vertices], [p.vertices for p in mesh.polygons])
    rng = random.Random(seed)
    dirs = []
    for _ in range(samples):
        u, v = rng.random(), rng.random()
        r = math.sqrt(u)
        a = 2 * math.pi * v
        dirs.append(Vector((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - u)))))
    out = []
    for vert in mesh.vertices:
        n = vert.normal
        # Tangent frame around the normal.
        t = n.orthogonal().normalized()
        b = n.cross(t)
        origin = vert.co + n * 0.004
        hit = 0.0
        for d in dirs:
            w = (t * d.x + b * d.y + n * d.z).normalized()
            loc, _, _, dist = bvh.ray_cast(origin, w, distance)
            if loc is not None:
                hit += 1 - (dist / distance) ** 2
            elif ground and w.z < -1e-4 and origin.z >= floor:
                g = (origin.z - floor) / -w.z
                if g < distance:
                    hit += 1 - (g / distance) ** 2
        occ = hit / samples
        out.append(1 - strength * occ)
    return out


# Primitive bmesh parts ---------------------------------------------------------------------


def lathe(profile, segments=16, cap_top=True, cap_bottom=True, phase=0.0):
    """Revolves (radius, z) points around Z. Zero radii collapse to a pole."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
            continue
        rings.append([
            bm.verts.new((r * math.cos(phase + 2 * math.pi * i / segments), r * math.sin(phase + 2 * math.pi * i / segments), z))
            for i in range(segments)
        ])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(segments):
            j = (i + 1) % segments
            if len(a) == 1:
                bm.faces.new((a[0], b[j], b[i]))
            elif len(b) == 1:
                bm.faces.new((a[i], a[j], b[0]))
            else:
                bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap_bottom and len(rings[0]) > 1:
        bm.faces.new(list(reversed(rings[0])))
    if cap_top and len(rings[-1]) > 1:
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def box(size, center=(0, 0, 0), bevel=0.0, segments=1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segments, profile=0.5, affect='EDGES', clamp_overlap=True)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return bm


def ico(radius, subdivisions=2, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=radius)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return bm


def torus(major, minor, major_segments=16, minor_segments=6):
    bm = bmesh.new()
    rings = []
    for i in range(major_segments):
        a = 2 * math.pi * i / major_segments
        c = Vector((math.cos(a), math.sin(a), 0))
        ring = []
        for j in range(minor_segments):
            b = 2 * math.pi * j / minor_segments
            ring.append(bm.verts.new(c * (major + minor * math.cos(b)) + Vector((0, 0, minor * math.sin(b)))))
        rings.append(ring)
    for i in range(major_segments):
        a, b = rings[i], rings[(i + 1) % major_segments]
        for j in range(minor_segments):
            k = (j + 1) % minor_segments
            bm.faces.new((a[j], b[j], b[k], a[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def skin(verts, edges, radii, root=0, smoothing=0.6, subdivisions=1, squash=None):
    """
    Wraps a skeleton of vertices and edges in a tube whose thickness follows `radii` (Blender's
    Skin modifier, smoothed by subdivision) — branches, twigs, bones. `squash(i)` scales one
    radius axis per vertex, for oval cross-sections. Returns a bmesh.
    """
    mesh = bpy.data.meshes.new('skel')
    mesh.from_pydata([tuple(v) for v in verts], edges, [])
    obj = bpy.data.objects.new('skel', mesh)
    bpy.context.scene.collection.objects.link(obj)
    mod = obj.modifiers.new('skin', 'SKIN')
    mod.branch_smoothing = smoothing
    for i, r in enumerate(radii):
        mesh.skin_vertices[0].data[i].radius = (r, r * (squash(i) if squash else 1))
    mesh.skin_vertices[0].data[root].use_root = True
    if subdivisions:
        sub = obj.modifiers.new('sub', 'SUBSURF')
        sub.levels = sub.render_levels = subdivisions
    deps = bpy.context.evaluated_depsgraph_get()
    evaluated = bpy.data.meshes.new_from_object(obj.evaluated_get(deps))
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(mesh)
    bm = bmesh.new()
    bm.from_mesh(evaluated)
    bpy.data.meshes.remove(evaluated)
    return bm


def decimate(bm, target_tris):
    """Collapses a bmesh down to about `target_tris` triangles, in place."""
    tris = sum(len(f.verts) - 2 for f in bm.faces)
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


def cut_flat_below(bm, z):
    """Slices everything under z off and caps the hole — a flat base that sits on the ground."""
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, -1), clear_outer=True)
    edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    if edges:
        bmesh.ops.edgeloop_fill(bm, edges=edges)


def rotation(axis, degrees):
    return Matrix.Rotation(math.radians(degrees), 4, axis)


# ---------------------------------------------------------------------------------------------
# Export


def export_glb(path, objects):
    """Exports just these objects as roots, keeping their names as glTF node names."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=False,
        export_tangents=False,
        export_materials='EXPORT',
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
    )
