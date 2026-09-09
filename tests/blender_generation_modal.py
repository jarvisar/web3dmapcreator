"""Real offline worker, modal lifecycle, and ownership regressions in Blender."""

from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import jarvizar_city_model as addon
from jarvizar_city_model import operators
from jarvizar_city_model.blender import generation_modal as modal
from jarvizar_city_model.blender.collections import generated_objects, generated_roots
from jarvizar_city_model.blender.generation import GenerationTransaction
from jarvizar_city_model.data.generation_job import GenerationCancelled
from jarvizar_city_model.data import generation_job
from blender_generation_transaction import TransactionTests, scene_snapshot, geometry_digest


class ModalTests(unittest.TestCase):
    run_generation = TransactionTests.run_generation
    previous_model = TransactionTests.previous_model

    def setUp(self):
        TransactionTests.setUp(self)
        self.context.window = bpy.context.window
        self.context.window_manager.windows = []
        self.addCleanup(modal.shutdown_generation)

    def start(self):
        session = modal.GenerationSession(self.context)
        session.start()
        self.assertTrue(modal.is_generating())
        self.assertTrue(self.settings.generation_running)
        return session

    def drive(self, session, *, until_import=False):
        deadline = time.monotonic() + 45
        timings = []
        while time.monotonic() < deadline:
            start = time.monotonic()
            result = session.advance(self.context)
            timings.append(time.monotonic() - start)
            if until_import and session.transaction is not None and not session.cancel_requested:
                return result
            if result != {"RUNNING_MODAL"}:
                print("MODAL_TICK_MAX_SECONDS", round(max(timings), 4))
                print("MODAL_RESULT", result, session.message)
                return result
            time.sleep(.02)
        self.fail(f"Worker/modal timeout: {session.phase}; {session.message}")

    def test_real_worker_success_matches_synchronous_geometry_and_palette(self):
        for merged in (False, True):
            with self.subTest(merged=merged):
                self.settings.merge_buildings_and_trees = merged
                self.assertEqual(self.run_generation(), {"FINISHED"})
                expected = geometry_digest(generated_objects(bpy.context.scene))
                libraries_before = set(bpy.data.libraries)
                counts = generated_roots(bpy.context.scene)[0]["generation_counts_json"]
                material = bpy.data.materials["JCM_Terrain"]
                material["custom_note"] = "keep custom graph"
                material.node_tree.nodes.new("ShaderNodeValue").outputs[0].default_value = .37
                session = self.start()
                self.assertEqual(self.drive(session), {"FINISHED"}, session.message)
                bpy.context.view_layer.update()
                self.assertEqual(geometry_digest(generated_objects(bpy.context.scene)), expected)
                self.assertEqual(set(bpy.data.libraries), libraries_before)
                self.assertEqual(generated_roots(bpy.context.scene)[0]["generation_counts_json"], counts)
                self.assertEqual(bpy.data.materials["JCM_Terrain"]["custom_note"], "keep custom graph")
                self.assertAlmostEqual(bpy.data.materials["JCM_Terrain"].node_tree.nodes["Value"].outputs[0].default_value, .37)
                self.assertFalse(modal.is_generating())
                self.assertFalse(session.job.directory.exists())

    def test_cancel_worker_and_import_preserves_original_and_new_user_data(self):
        self.previous_model()
        for after_import in (False, True):
            with self.subTest(after_import=after_import):
                before = scene_snapshot()
                session = self.start()
                if after_import:
                    self.assertEqual(self.drive(session, until_import=True), {"RUNNING_MODAL"}, session.message)
                # New user data is outside the transaction, even when created
                # between importing the model and the final publication tick.
                mesh = bpy.data.meshes.new("user-created during generation")
                helper = bpy.data.objects.new("new helper", mesh)
                bpy.context.scene.collection.objects.link(helper)
                bpy.context.view_layer.update()
                start = time.monotonic()
                session.request_cancel()
                self.assertLess(time.monotonic() - start, .5)
                self.assertEqual(self.drive(session), {"CANCELLED"})
                self.assertIn(helper.name, bpy.context.scene.objects)
                self.assertIn(mesh.name, bpy.data.meshes)
                bpy.data.objects.remove(helper, do_unlink=True)
                bpy.data.meshes.remove(mesh)
                self.assertEqual(scene_snapshot(), before)
                self.assertFalse(session.job.directory.exists())
                self.assertFalse(any(c.name.startswith("_CITY_MODEL_STAGING") for c in bpy.data.collections))
        retry = self.start()
        self.assertEqual(self.drive(retry), {"FINISHED"}, retry.message)

    def test_cancel_at_every_pipeline_phase_preserves_previous_model(self):
        self.previous_model()
        phases = []
        self.driver._generation_progress = lambda phase, fraction: phases.append(phase) if phase not in phases else None
        self.assertEqual(self.run_generation(), {"FINISHED"})
        for target in phases:
            with self.subTest(phase=target):
                before = scene_snapshot()
                def cancel(phase, fraction):
                    if phase == target:
                        raise GenerationCancelled(phase)
                self.driver._generation_progress = cancel
                self.assertEqual(self.run_generation(), {"CANCELLED"})
                self.assertEqual(scene_snapshot(), before)
                self.assertTrue(self.settings.last_status.startswith("Generation cancelled"))
        del self.driver._generation_progress
        self.assertEqual(self.run_generation(), {"FINISHED"})
        print("CANCELLED_PIPELINE_PHASES", len(phases), phases)

    def test_failure_after_import_and_settings_change(self):
        self.previous_model()
        before = scene_snapshot()
        session = self.start()
        with patch.object(GenerationTransaction, "validate", side_effect=ValueError("injected validation failure")):
            self.assertEqual(self.drive(session), {"CANCELLED"})
        self.assertTrue(session.error)
        self.assertEqual(scene_snapshot(), before)
        session = self.start()
        self.settings.base_thickness_mm += .1
        self.assertEqual(self.drive(session), {"CANCELLED"})
        self.assertIn("settings or scene changed", session.message)
        self.assertEqual(scene_snapshot(), before)

    def test_partial_import_and_startup_failures_are_reaped(self):
        self.previous_model()
        before = scene_snapshot()
        original_import = GenerationTransaction.import_model
        def fail_after_import(transaction, *args):
            original_import(transaction, *args)
            raise ValueError("injected after append")
        session = self.start()
        with patch.object(GenerationTransaction, "import_model", fail_after_import):
            self.assertEqual(self.drive(session), {"CANCELLED"})
        self.assertEqual(scene_snapshot(), before)
        session = modal.GenerationSession(self.context)
        with patch.object(self.context.window_manager, "event_timer_add", side_effect=RuntimeError("timer setup failed")):
            with self.assertRaises(RuntimeError):
                session.start()
        session.detach()
        self.assertEqual(self.drive(session), {"CANCELLED"})
        self.assertEqual(scene_snapshot(), before)
        self.assertIsNotNone(session.job.process.poll())
        self.assertFalse(session.job.directory.exists())

    def test_failed_termination_retains_ownership_and_modal_entrypoints(self):
        self.previous_model()
        session = self.start()
        actual_cancel = session.job.cancel
        with patch.object(session.job, "cancel", side_effect=OSError("injected termination failure")):
            session.request_cancel()
            self.assertEqual(session.advance(self.context), {"RUNNING_MODAL"})
            self.assertTrue(modal.is_generating())
            self.assertFalse(operators.JARVIZAR_OT_generate_model.poll(self.context))
            self.assertFalse(operators.JARVIZAR_OT_clear_model.poll(self.context))
            self.assertFalse(operators.JARVIZAR_OT_download_cache.poll(self.context))
            with self.assertRaises(ValueError):
                modal.GenerationSession(self.context)
        actual_cancel()
        self.assertEqual(self.drive(session), {"CANCELLED"})

    def test_sidebar_cancel_stays_accessible_after_import(self):
        driver = SimpleNamespace(_session=SimpleNamespace(done=False, transaction=object()))
        region = SimpleNamespace(type="UI", x=100, y=100, width=200, height=300)
        context = SimpleNamespace(screen=SimpleNamespace(areas=[SimpleNamespace(type="VIEW_3D", regions=[region])]))
        event = SimpleNamespace(type="LEFTMOUSE", mouse_x=150, mouse_y=150)
        self.assertEqual(operators.JARVIZAR_OT_generate_model.modal(driver, context, event), {"PASS_THROUGH"})
        event.mouse_x = 50
        self.assertEqual(operators.JARVIZAR_OT_generate_model.modal(driver, context, event), {"RUNNING_MODAL"})
        session = self.start()
        driver = SimpleNamespace(_session=session, report=Mock())
        event = SimpleNamespace(type="ESC")
        self.assertEqual(operators.JARVIZAR_OT_generate_model.modal(driver, self.context, event), {"RUNNING_MODAL"})
        self.assertEqual(self.drive(session), {"CANCELLED"})

    def test_shutdown_reaps_worker_before_scene_change(self):
        self.previous_model()
        before = scene_snapshot()
        session = self.start()
        modal.shutdown_generation()
        self.assertIsNotNone(session.job.process.poll())
        self.assertFalse(session.job.directory.exists())
        self.assertFalse(modal.is_generating())
        self.assertEqual(scene_snapshot(), before)
        session = self.start()
        self.assertIsNone(session._watch_window())  # Its owning window was closed.
        self.assertEqual(self.drive(session), {"CANCELLED"})
        self.assertFalse(modal.is_generating())
        self.assertEqual(scene_snapshot(), before)

    def test_real_worker_cancellation_during_each_phase(self):
        self.previous_model()
        phases = []
        self.driver._generation_progress = lambda phase, fraction: phases.append(phase) if phase not in phases else None
        self.assertEqual(self.run_generation(), {"FINISHED"})
        del self.driver._generation_progress
        original_popen = generation_job.subprocess.Popen
        for target in phases + ["Writing finished model"]:
            with self.subTest(phase=target):
                def launch(command, **kwargs):
                    request = Path(command[-1])
                    (request.parent / "pause-phase.txt").write_text(target, encoding="utf-8")
                    command = list(command)
                    command[command.index("--python") + 1] = str(ROOT / "tests/generation_worker_fixture.py")
                    return original_popen(command, **kwargs)
                before = scene_snapshot()
                with patch.object(generation_job.subprocess, "Popen", launch):
                    session = self.start()
                deadline = time.monotonic() + 20
                ticks = 0
                while session.phase != target and time.monotonic() < deadline:
                    self.assertEqual(session.advance(self.context), {"RUNNING_MODAL"}, session.message)
                    self.assertFalse(session.error, session.message)
                    ticks += 1
                    time.sleep(.02)
                self.assertEqual(session.phase, target, session.message)
                self.assertIsNone(session.job.process.poll())
                self.assertGreater(ticks, 1)
                session.request_cancel()
                self.assertEqual(self.drive(session), {"CANCELLED"})
                self.assertEqual(scene_snapshot(), before)
                self.assertFalse(session.job.directory.exists())
        retry = self.start()
        self.assertEqual(self.drive(retry), {"FINISHED"}, retry.message)


if __name__ == "__main__":
    addon.register()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ModalTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    addon.unregister()
    if not result.wasSuccessful():
        raise SystemExit(1)
    print("JARVIZAR_GENERATION_MODAL_OK")
