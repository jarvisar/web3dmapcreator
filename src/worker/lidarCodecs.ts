// The LAZ decoder and projection library behind src/core's LiDAR interfaces.
// Kept out of src/core so the tests and core code never need the wasm. The
// worker passes the wasm's URL, Node scripts pass its bytes.

import { decodeLazFile, initLazCodec, LazChunkDecoder, LazField } from '@voxelkloud/wasm-codecs';
import proj4 from 'proj4';
import { setProjector } from '../core/lidar/read/crs';
import { setLazDecoder, type LazDecoder } from '../core/lidar/read/laz';

function decoder(): LazDecoder {
  // The fields recordReader reads. For point formats 6 and up the decoder
  // skips the rest (colour, NIR, intensity), whose bytes are then undefined.
  // LazField reads from the wasm, so this can't run before initLazCodec.
  const fields = LazField.XY_RETURNS_CHANNEL | LazField.Z | LazField.CLASSIFICATION | LazField.FLAGS | LazField.GPS_TIME;
  return {
    decodeFile(bytes) {
      const decoded = decodeLazFile(bytes);
      try {
        // Each read of `points` copies out of wasm memory, so read it once.
        return { records: decoded.points, pointCount: decoded.pointCount, pointSize: decoded.pointSize };
      } finally {
        decoded.free();
      }
    },
    chunkDecoder(laszipVlr) {
      const chunks = new LazChunkDecoder(laszipVlr);
      return {
        decode: (chunk, pointCount) => chunks.decodeSelective(chunk, pointCount, fields),
        free: () => chunks.free(),
      };
    },
  };
}

/** Install both. The wasm is only compiled once LiDAR is used. */
export function installLidarCodecs(wasm: string | URL | BufferSource): void {
  setLazDecoder(async () => {
    await initLazCodec(wasm);
    return decoder();
  });
  setProjector((from, to) => proj4(from, to));
}
