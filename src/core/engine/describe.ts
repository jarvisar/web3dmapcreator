// The message the page shows for a job that failed in the worker.

import { needsProxy } from '../data/corsProxy';

// What fetch rejects with when nothing came back, in Chrome, Firefox and Safari.
const FETCH_FAILED = /Failed to fetch|NetworkError|Load failed|network|Internet connection/i;

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Only a download that failed outright, which is map data or elevation.
    // A message quoting one (a LiDAR survey that returned nothing) names the
    // survey and file, and one through the LiDAR proxy says it may be over
    // its daily limit, so those keep their own words.
    const url = (error as { url?: unknown }).url;
    const proxied = typeof url === 'string' && needsProxy(url);
    if (!proxied && (error.name === 'NetworkError' || (error.name === 'TypeError' && FETCH_FAILED.test(error.message)))) {
      return 'Could not reach the map data server. Check your connection and try again.';
    }
    // What a typed array the browser can't find memory for throws. Running
    // out of the JS heap closes the tab instead, with nothing to catch.
    if (error instanceof RangeError && /allocation failed|Invalid typed array length|Invalid array buffer length/i.test(error.message)) {
      return 'The browser ran out of memory building this model. Try a smaller area, or larger cells for a LiDAR only model.';
    }
    return error.message || error.name;
  }
  return String(error);
}
