"""
Builds the game's prop models procedurally and exports them as .glb bundles, one named node
per prop. Run through `bun run assets:props`, or directly:

  blender -b --factory-startup -P apps/client/blender/build.py -- --out <dir> [--preview <dir>] [--blend <file>]

  --out      writes nature.glb and items.glb (uncompressed; the bun script compresses them)
  --preview  also renders a contact sheet of every prop at the game's camera angle
  --blend    also saves the scene, to open and inspect in Blender
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import common  # noqa: E402
import decor  # noqa: E402
import items  # noqa: E402
import nature  # noqa: E402


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = {}
    for flag, value in zip(argv[::2], argv[1::2]):
        out[flag.lstrip('-')] = value
    return out


def preview(objects, path, columns=5, spacing=4.0, fit=False):
    """
    Lays the props out on a grid and renders them lit like the game (low warm sun, cool fill).
    `fit` scales each to fill its cell, for judging detail rather than relative size.
    """
    scene = bpy.context.scene
    everything = list(scene.objects)
    for o in everything:
        o.hide_render = True
    placed = []
    for i, o in enumerate(objects):
        copy = o.copy()
        copy.hide_render = False
        scene.collection.objects.link(copy)
        copy.location = Vector(((i % columns - (columns - 1) / 2) * spacing, -(i // columns) * spacing, 0))
        if fit:
            size = max(o.dimensions)
            copy.scale = (spacing * 0.7 / size,) * 3
        placed.append(copy)
    rows = (len(objects) + columns - 1) // columns

    ground = bpy.data.meshes.new('ground')
    ground.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new('ground', ground)
    g.data.materials.append(common.material('preview_ground', 0x3A4A36, roughness=1, vertex_colors=False))
    scene.collection.objects.link(g)

    world = bpy.data.worlds.new('dusk')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (*common.srgb(0x55657E), 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    scene.world = world

    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.2
    sun.data.color = tuple(common.srgb(0xFFE2BD))
    sun.data.angle = math.radians(3)
    # The game's sun: three (34, 52, 18) → Blender (34, −18, 52).
    sun.rotation_euler = Vector((34, -18, 52)).to_track_quat('Z', 'Y').to_euler()
    scene.collection.objects.link(sun)

    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    width = columns * spacing
    cam.data.ortho_scale = width * 1.02
    centre = Vector((0, -(rows - 1) * spacing / 2, 0.8))
    # The game camera: three (0, 26, 17) from the focus → Blender (0, −17, 26).
    offset = Vector((0, -17, 26)).normalized() * 40
    cam.location = centre + offset
    cam.rotation_euler = (-offset).to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(cam)
    scene.camera = cam

    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 1600
    scene.render.resolution_y = int(1600 * (rows * spacing * 0.62 + 1.2) / width)
    scene.render.filepath = path
    scene.view_settings.view_transform = 'Standard'
    try:
        scene.eevee.use_shadows = True
    except AttributeError:
        pass
    bpy.ops.render.render(write_still=True)

    for o in placed + [g, sun, cam]:
        bpy.data.objects.remove(o)
    for o in everything:
        o.hide_render = False


def main():
    opts = args()
    common.reset_scene()
    only = set(opts['only'].split(',')) if 'only' in opts else None
    bundles = {'nature.glb': lambda: nature.build_all() + decor.build_all(), 'items.glb': items.build_all}
    built = {}
    for bundle, build in bundles.items():
        if only and bundle.split('.')[0] not in only:
            continue
        built[bundle] = build()
        for o in built[bundle]:
            tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
            print(f'  {o.name:18} {tris:5} tris')
    if 'out' in opts:
        os.makedirs(opts['out'], exist_ok=True)
        for bundle, objs in built.items():
            common.export_glb(os.path.join(opts['out'], bundle), objs)
    if 'preview' in opts:
        os.makedirs(opts['preview'], exist_ok=True)
        for bundle, objs in built.items():
            preview(objs, os.path.join(opts['preview'], bundle.replace('.glb', '.png')))
            preview(objs, os.path.join(opts['preview'], bundle.replace('.glb', '_detail.png')), fit=True)
    if 'blend' in opts:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(opts['blend']))


main()
