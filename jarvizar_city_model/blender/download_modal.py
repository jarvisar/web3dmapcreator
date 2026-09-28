"""Foreground lifecycle for cache downloads run by the external downloader."""

import bpy
from bpy.app.handlers import persistent

from ..data.download_job import cached_message, cancelled_message


_active = None


def active_download():
    return _active


def is_downloading():
    """Whether a download owns the cache; generation, LiDAR and export wait."""
    return _active is not None


def _redraw():
    """Redraw the sidebars only; the viewport may hold a large model."""
    manager = bpy.context.window_manager
    for window in manager.windows if manager is not None else ():
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                for region in area.regions:
                    if region.type == "UI":
                        region.tag_redraw()


class DownloadSession:
    """Drive one DownloadJob from timer events until its helper has exited.

    Only the scene's name is kept: undo replaces every ID while the download
    continues.
    """

    def __init__(self, context, job, required, on_success=None):
        if _active is not None:
            raise ValueError("Another download is running")
        self.job = job
        self.required = tuple(required)
        self.on_success = on_success
        self.scene_name = context.scene.name
        self.manager, self.window = context.window_manager, context.window
        self.timer = None
        self.cancel_requested = self.error = self.done = False
        self.message = ""
        self._shown = None

    def start(self):
        global _active
        _active = self
        self.manager.progress_begin(0, 1000)
        self.job.start()
        self.timer = self.manager.event_timer_add(0.2, window=self.window)
        bpy.app.timers.register(self._watch_window, first_interval=0.5, persistent=True)
        _redraw()

    def status(self):
        status = self.job.status()
        stopping = self.cancel_requested or status["state"] == "stopping"
        status["title"] = "Stopping download" if stopping else "Downloading data"
        return status

    def request_cancel(self):
        if self.done:
            return
        self.cancel_requested = True
        self.job.cancel()
        _redraw()

    def advance(self):
        if self.done:
            return {"CANCELLED"}
        try:
            running = self.job.poll()
        except Exception as exc:  # noqa: BLE001 - stop the helper before reporting
            try:
                self.job.abort(5.0)
            except Exception:  # noqa: BLE001
                pass
            return self._finish(f"Download stopped: {exc}")
        if running:
            status = self.status()
            if self.manager is not None:
                self.manager.progress_update(int(status["fraction"] * 1000))
            shown = (status["title"], status["stage"], status["message"], int(status["elapsed"]))
            if shown != self._shown:
                self._shown = shown
                _redraw()
            return {"RUNNING_MODAL"}
        return self._finish()

    def _finish(self, failure=""):
        global _active
        job = self.job
        succeeded = job.state == "succeeded" and not failure
        if succeeded:
            manifest = job.manifest if job.manifest is not None else job.bundle.read_manifest()
            self.message = cached_message(manifest, self.required, job.bundle.has_dem())
        elif job.state == "cancelled" and not failure:
            self.message = cancelled_message(job.completed)
        else:
            self.error = True
            self.message = f"Download failed: {failure or job.error}"
        self._release()
        scene = bpy.data.scenes.get(self.scene_name) if self.scene_name else None
        if scene is not None:
            scene.jarvizar_city_model.last_status = self.message
        self.done = True
        if _active is self:
            _active = None
        print(f"{self.message}; log: {job.log_path or 'not written'}")
        _redraw()
        if succeeded and self.on_success is not None:
            self.on_success()
        return {"FINISHED"} if succeeded else {"CANCELLED"}

    def _release(self):
        """Remove the event timer and progress display from the window manager."""
        if self.manager is not None:
            if self.timer is not None:
                self.manager.event_timer_remove(self.timer)
            self.manager.progress_end()
        self.manager = self.window = self.timer = None

    def detach(self):
        """Stop the helper when Blender drops the modal handler: a file load,
        a closed window or add-on unload."""
        if self.done:
            return
        self.on_success = None
        self.request_cancel()
        if self.job.wait(5.0):
            self._finish()
            return
        # A file load replaces the window manager; release it now and reap
        # the helper from a timer. The scene may not survive either.
        self._release()
        self.scene_name = None
        if not bpy.app.timers.is_registered(self._reap):
            bpy.app.timers.register(self._reap, first_interval=0.2, persistent=True)

    def _reap(self):
        return 0.2 if self.advance() == {"RUNNING_MODAL"} else None

    def _watch_window(self):
        if self.done:
            return None
        if self.manager is not None and self.window is not None \
                and self.window not in self.manager.windows[:]:
            self.detach()
            return None
        return 0.5


@persistent
def shutdown_download(*_args):
    """Stop the helper before another file replaces this one."""
    session = _active
    if session is not None:
        session.detach()


def register_handlers():
    if shutdown_download not in bpy.app.handlers.load_pre:
        bpy.app.handlers.load_pre.append(shutdown_download)


def unregister_handlers():
    """Never raises: the add-on must unload even if the helper will not stop."""
    try:
        session = _active
        if session is not None:
            # The scene properties are unregistered with the add-on.
            session.scene_name = None
            session.detach()
    except Exception as exc:  # noqa: BLE001
        print(f"Download could not be stopped: {exc}")
    finally:
        if shutdown_download in bpy.app.handlers.load_pre:
            bpy.app.handlers.load_pre.remove(shutdown_download)
