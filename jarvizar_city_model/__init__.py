"""Jarvizar printable miniature city model Blender add-on."""

bl_info = {
    "name": "Jarvizar City Model",
    "author": "Jarvizar workflow / OpenAI",
    "version": (0, 25, 8),
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

    # A class that fails to register must not leave the others behind, or
    # every later attempt to enable the add-on fails as "already registered".
    registered = []
    try:
        for cls in (*config.CLASSES, *operators.CLASSES, *ui.CLASSES):
            bpy.utils.register_class(cls)
            registered.append(cls)
        config.register_scene_properties()
    except Exception:
        for cls in reversed(registered):
            bpy.utils.unregister_class(cls)
        raise
    from .blender.generation_modal import register_handlers
    register_handlers()


def unregister():
    import bpy

    from . import config, operators, ui

    from .blender.generation_modal import unregister_handlers
    try:
        unregister_handlers()
    finally:
        # Stopping a generation worker can fail; the add-on still unloads.
        config.unregister_scene_properties()
        for cls in reversed((*config.CLASSES, *operators.CLASSES, *ui.CLASSES)):
            bpy.utils.unregister_class(cls)
