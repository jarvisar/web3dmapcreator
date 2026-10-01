// A fake fetch for the offline tests: serves byte arrays by URL, with range
// requests answered the way S3 answers them.

export interface Served {
  url: string;
  method: string;
  /** [start, end) of a range request. */
  range?: [number, number];
}

export interface MockServer {
  fetch: typeof fetch;
  requests: Served[];
  /** Answers the next matching request with this status instead of the file. */
  failNext(match: (url: string) => boolean, status: number, times?: number): void;
}

export function mockServer(files: Record<string, Uint8Array | string>): MockServer {
  const requests: Served[] = [];
  const failures: { match: (url: string) => boolean; status: number; times: number }[] = [];

  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    const method = init?.method ?? 'GET';
    const header = new Headers(init?.headers).get('range');
    const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
    // An open range (bytes=n-) runs to the end of the file.
    const range: [number, number] | undefined = match ? [Number(match[1]), match[2] ? Number(match[2]) + 1 : Infinity] : undefined;
    requests.push({ url, method, range });
    const failure = failures.find((f) => f.times > 0 && f.match(url));
    if (failure) {
      failure.times--;
      return new Response('failure', { status: failure.status });
    }
    const file = files[url];
    if (file === undefined) return new Response('not found', { status: 404 });
    const body = typeof file === 'string' ? new TextEncoder().encode(file) : file;
    if (!range) return new Response(method === 'HEAD' ? null : body.slice(), { status: 200, headers: { 'content-length': String(body.length) } });
    const end = Math.min(range[1], body.length);
    return new Response(body.slice(range[0], end), {
      status: 206,
      headers: { 'content-range': `bytes ${range[0]}-${end - 1}/${body.length}` },
    });
  };

  return {
    fetch: serve as typeof fetch,
    requests,
    failNext(match, status, times = 1) {
      failures.push({ match, status, times });
    },
  };
}
