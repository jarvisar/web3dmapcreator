"""Disposable slow worker for the real Blender progress/cancellation UI test."""
import argparse
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external'))
from lidar_progress import ProgressReporter
from lidar_worker import watch_parent

parser=argparse.ArgumentParser()
parser.add_argument('--progress',type=Path,required=True)
parser.add_argument('--parent-pid',type=int)
args,_=parser.parse_known_args()
if args.parent_pid:watch_parent(args.parent_pid)
report=ProgressReporter(args.progress)
for index in range(10):
    report(f'Reconstructing building {index+1}/10: test roof',stage='Reconstructing roofs',
           source='Test survey',completed=index,total=10,cached_buildings=3,point_batches=1,force=True)
    time.sleep(1)
time.sleep(20)  # The GUI test must cancel, not wait for a successful exit.
raise RuntimeError('The UI test did not cancel its worker')
