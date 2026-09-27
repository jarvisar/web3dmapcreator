"""Foreground lifecycle for offline generation in an isolated Blender process."""

from pathlib import Path
import time
from types import SimpleNamespace

import bpy
from bpy.app.handlers import persistent

from ..data.generation_job import GenerationJob
from .generation import GenerationTransaction


_active = None
_RUNTIME = {"rna_type", "name", "last_status", "lidar_preparation_status", "lidar_generation_status",
            "lidar_preparing", "generation_running", "generation_phase", "generation_progress",
            "show_laz_offer_details"}


def settings_snapshot(settings):
    result = {prop.identifier: getattr(settings, prop.identifier) for prop in settings.bl_rna.properties
              if prop.identifier not in _RUNTIME and not prop.is_readonly
              and prop.type in {"BOOLEAN", "INT", "FLOAT", "STRING", "ENUM"}}
    result["cache_directory"] = str(Path(bpy.path.abspath(settings.cache_directory)).expanduser().resolve())
    return result


def active_session():
    return _active


def is_generating():
    return _active is not None


class GenerationSession:
    def __init__(self, context):
        if is_generating():
            raise ValueError("Another model is being generated")
        self.context = SimpleNamespace(scene=context.scene, view_layer=context.view_layer)
        self.scene = context.scene
        self.settings = self.scene.jarvizar_city_model
        self.inputs = settings_snapshot(self.settings)
        self.manager, self.window = context.window_manager, context.window
        self.job = self.timer = self.transaction = self.result = None
        self.phase, self.fraction = "Starting generation", 0.0
        self.cancel_requested = self.error = self.done = False
        self.message = "Generation cancelled; previous model kept"
        self.ready_at = 0.0

    def start(self):
        global _active
        _active = self
        self.settings.generation_running = True
        self.manager.progress_begin(0, 1000)
        self._progress(self.phase, 0.0)
        self.job = GenerationJob(bpy.app.binary_path, self.inputs)
        self.timer = self.manager.event_timer_add(.1, window=self.window)
        bpy.app.timers.register(self._watch_window, first_interval=.5)

    def _progress(self, phase, fraction):
        self.phase, self.fraction = phase, max(self.fraction, fraction)
        self.settings.generation_phase = phase
        self.settings.generation_progress = self.fraction
        self.manager.progress_update(int(self.fraction * 1000))
        self._redraw()

    def _redraw(self):
        for window in self.manager.windows:
            for area in window.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()

    def request_cancel(self, message=None):
        if self.done:
            return
        self.cancel_requested = True
        if message:
            self.message = message
        self._progress("Cancelling generation", self.fraction)
        if self.job is not None:
            try:
                self.job.cancel()
            except OSError as exc:
                # Keep the job owned and retry on later ticks. No blocking wait
                # or second worker is allowed while termination is unresolved.
                self._progress(f"Waiting to stop generation: {exc}", self.fraction)

    def advance(self, context):
        if self.done:
            return {"CANCELLED"}
        try:
            if context.scene != self.scene or settings_snapshot(self.settings) != self.inputs:
                self.request_cancel("Generation cancelled because settings or scene changed; generate again")
            if self.cancel_requested:
                if self.job is not None and self.job.process.poll() is None:
                    self.request_cancel()
                    return {"RUNNING_MODAL"}
                if self.transaction is not None:
                    self.transaction.rollback()
                return self._finish(False)
            if self.job.process.poll() is None:
                progress = self.job.progress()
                if progress:
                    self._progress(progress[0], .95 * progress[1])
                return {"RUNNING_MODAL"}
            if self.transaction is None:
                self.result = self.job.result()
                self._progress("Loading finished model", .96)
                self.transaction = GenerationTransaction(self.context)
                self.transaction.import_model(self.job.model_path, self.result["root"])
                self._progress("Ready to replace model", .98)
                self.ready_at = time.monotonic() + .1
                # Give queued Esc/Cancel events a chance before the final commit.
                return {"RUNNING_MODAL"}
            if time.monotonic() < self.ready_at:
                return {"RUNNING_MODAL"}
            self._progress("Validating and replacing model", .99)
            self.job.cleanup()
            self.transaction.commit(message=self.result["message"], lidar_status=self.result["lidar_status"],
                                    set_scene_units=self.inputs["set_scene_units"])
            self.message = self.result["message"]
            return self._finish(True)
        except Exception as exc:
            self.error = True
            self.request_cancel(f"Generation failed during {self.phase}: {exc}")
            # Cleanup happens on the next tick, after confirming worker exit.
            return {"RUNNING_MODAL"}

    def _remove_timer(self):
        if self.timer is not None:
            self.manager.event_timer_remove(self.timer)
            self.timer = None

    def _finish(self, success):
        global _active
        if self.job is not None:
            self.job.cleanup()
        self._remove_timer()
        self.manager.progress_end()
        self.settings.generation_running = False
        self.settings.generation_phase = ""
        self.settings.generation_progress = 0.0
        self.settings.last_status = self.message
        self.done = True
        if _active is self:
            _active = None
        self._redraw()
        return {"FINISHED"} if success else {"CANCELLED"}

    def detach(self):
        """Reap even if adding the modal handler failed or Blender removed it."""
        if self.done:
            return
        self.request_cancel()
        self._remove_timer()
        if not bpy.app.timers.is_registered(self._reap):
            bpy.app.timers.register(self._reap, first_interval=.1)

    def _reap(self):
        return .1 if self.advance(self.context) == {"RUNNING_MODAL"} else None

    def _watch_window(self):
        if self.done:
            return None
        if self.window not in self.manager.windows[:]:
            self.detach()
            return None
        return .5


@persistent
def shutdown_generation(*_args):
    """Stop our worker before scene replacement, undo, or add-on unload."""
    session = _active
    if session is None:
        return
    session.request_cancel()
    if session.job is not None:
        session.job.wait_or_kill()
    if session.transaction is not None:
        session.transaction.rollback()
    session._finish(False)


def register_handlers():
    for handlers in (bpy.app.handlers.load_pre, bpy.app.handlers.undo_pre, bpy.app.handlers.redo_pre):
        if shutdown_generation not in handlers:
            handlers.append(shutdown_generation)


def unregister_handlers():
    try:
        shutdown_generation()
    finally:
        for handlers in (bpy.app.handlers.load_pre, bpy.app.handlers.undo_pre, bpy.app.handlers.redo_pre):
            if shutdown_generation in handlers:
                handlers.remove(shutdown_generation)
