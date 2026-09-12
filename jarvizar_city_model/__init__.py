"""Jarvizar printable miniature city model Blender add-on."""

bl_info = {
    "name": "Jarvizar City Model",
    "author": "Jarvizar workflow / OpenAI",
    "version": (0, 23, 17),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > City Model",
    "description": (
        "Generate printable city miniatures from cached Overture Maps data "
        "and public elevation tiles: terrain with open water cut out, land "
        "cover, trees, roads, bridges standing on kept ground, and buildings"
    ),
    "category": "Object",
}


def register():
    import bpy

    from . import config, operators, ui

    for cls in (*config.CLASSES, *operators.CLASSES, *ui.CLASSES):
        bpy.utils.register_class(cls)
    config.register_scene_properties()
    from .blender.generation_modal import register_handlers
    register_handlers()


def unregister():
    import bpy

    from . import config, operators, ui

    from .blender.generation_modal import unregister_handlers
    unregister_handlers()
    config.unregister_scene_properties()
    for cls in reversed((*config.CLASSES, *operators.CLASSES, *ui.CLASSES)):
        bpy.utils.unregister_class(cls)
