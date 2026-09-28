// Worker threads don't get tsx's loader from the parent, so register it here
// before loading the TypeScript worker.
import { register } from 'tsx/esm/api';

register();
await import('./lidar-worker.ts');
