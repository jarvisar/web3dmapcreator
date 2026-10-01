// Reads and measures one LiDAR batch at a time for the engine worker, which
// keeps a few of these so batches run in parallel. Downloads go through the
// engine worker, which fetches each file once for all of them.

import lazWasmUrl from '@voxelkloud/wasm-codecs/voxelkloud_wasm_codecs_bg.wasm?url';
import { setCorsProxy } from '../core/data/corsProxy';
import { installLidarCodecs } from './lidarCodecs';
import { lidarWorker, type FromLidarWorker, type ToLidarWorker } from './lidarProtocol';

const ctx = self as unknown as {
  postMessage(message: FromLidarWorker): void;
  onmessage: ((event: MessageEvent<ToLidarWorker>) => void) | null;
};

installLidarCodecs(lazWasmUrl);
setCorsProxy(import.meta.env.VITE_LIDAR_PROXY);
const handle = lidarWorker((message) => ctx.postMessage(message));
ctx.onmessage = ({ data }) => handle(data);
