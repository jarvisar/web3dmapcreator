"""Jarvizar printable miniature city model Blender add-on."""

bl_info = {
    "name": "Jarvizar City Model",
    "author": "Jarvizar",
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

# Registered in this order: settings first, panels last.
_MODULES = ("config", "operators", "operators_setup", "operators_area", "operators_palette",
            "operators_export", "ui")


def _classes():
    import importlib

    return tuple(cls for name in _MODULES
                 for cls in importlib.import_module(f".{name}", __package__).CLASSES)


def register():
    import bpy

    from . import config

    # A class that fails to register must not leave the others behind, or
    # every later attempt to enable the add-on fails as "already registered".
    registered = []
    try:
        for cls in _classes():
            bpy.utils.register_class(cls)
            registered.append(cls)
        config.register_scene_properties()
    except Exception:
        for cls in reversed(registered):
            bpy.utils.unregister_class(cls)
        raise
    from .blender.generation_modal import register_handlers
    register_handlers()
    from .blender import download_modal
    download_modal.register_handlers()


def unregister():
    import bpy

    from . import config

    from .blender import download_modal
    from .blender.generation_modal import unregister_handlers
    download_modal.unregister_handlers()
    try:
        unregister_handlers()
    finally:
        # Stopping a generation worker can fail; the add-on still unloads.
        config.unregister_scene_properties()
        for cls in reversed(_classes()):
            bpy.utils.unregister_class(cls)
