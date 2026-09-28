// Worker thread for scripts/lidar-node.ts, speaking the same messages as
// src/worker/lidar.worker.ts.

import { parentPort, workerData } from 'node:worker_threads';
import { lidarWorker, type ToLidarWorker } from '../src/worker/lidarProtocol';
import { setUpLidar } from './lidar-node';

setUpLidar(workerData.cacheDir);
const handle = lidarWorker((message) => parentPort!.postMessage(message));
parentPort!.on('message', (message: ToLidarWorker) => handle(message));
