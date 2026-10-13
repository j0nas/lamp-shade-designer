// Off-main-thread geometry builds with latest-wins coalescing. CSG rebuilds block for longer
// than a frame, so running them on the main thread freezes the very slider that drives them —
// and debouncing only trades the freeze for a dead preview. Instead the app hosts its builders
// in a Web Worker (they are pure `Params -> BufferGeometry`, so they run there unchanged) and
// the main thread stays at full frame rate while the mesh catches up at whatever rate builds
// complete.
//
// Latest-wins lives on the CLIENT: at most one request is ever in flight, and while one is
// building only the newest params are kept — intermediate drags are dropped, never queued. This
// keeps the worker trivially simple (receive → build → reply) and makes the scheduling
// deterministic and unit-testable without a real Worker.
//
// Hand-rolled rather than Comlink/workerpool: those give RPC proxying / pool semantics, but the
// whole problem here is the coalescing policy and the transferable geometry packing — which
// they'd leave us to write anyway. The wire protocol is ~40 lines; a dependency would be larger.

import { BufferAttribute, BufferGeometry } from "three";

// --- geometry packing --------------------------------------------------------
// A BufferGeometry can't cross postMessage, but its typed arrays can — transferred, not copied.
// Packing keeps attributes, index and material groups (laser previews rely on the cap/wall
// groups for their [face, edge] material pairs), so unpack(pack(g)) renders identically.

export type PackedAttribute = { array: Float32Array; itemSize: number };

export type PackedGeometry = {
  /** Non-interleaved float attributes ("position", "normal", "uv", …). */
  attributes: Record<string, PackedAttribute>;
  index: Uint16Array | Uint32Array | null;
  groups: { start: number; count: number; materialIndex: number }[];
};

/** A typed array whose buffer is exactly this view — safe to transfer without dragging along
 *  (or corrupting) data that shares the buffer. Views over a larger buffer get copied out. */
function ownBuffer<T extends Float32Array | Uint16Array | Uint32Array>(arr: T): T {
  const full = arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength;
  return full ? arr : (arr.slice() as T);
}

export function packGeometry(g: BufferGeometry): PackedGeometry {
  const attributes: Record<string, PackedAttribute> = {};
  for (const [name, attr] of Object.entries(g.attributes)) {
    // Manifold output and ExtrudeGeometry are plain float BufferAttributes; anything fancier
    // (interleaved, GPU-only) has no business in a build worker.
    const array = (attr as BufferAttribute).array;
    if (!(array instanceof Float32Array)) continue;
    attributes[name] = { array: ownBuffer(array), itemSize: attr.itemSize };
  }
  const index = g.index ? ownBuffer(g.index.array as Uint16Array | Uint32Array) : null;
  return {
    attributes,
    index,
    groups: g.groups.map((grp) => ({
      start: grp.start,
      count: grp.count,
      materialIndex: grp.materialIndex ?? 0,
    })),
  };
}

export function unpackGeometry(p: PackedGeometry): BufferGeometry {
  const g = new BufferGeometry();
  for (const [name, a] of Object.entries(p.attributes))
    g.setAttribute(name, new BufferAttribute(a.array, a.itemSize));
  if (p.index) g.setIndex(new BufferAttribute(p.index, 1));
  for (const grp of p.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  return g;
}

/** The transfer list for a result carrying these packed geometries (deduplicated — position and
 *  index of one geometry never share a buffer, but be safe across geometries). */
export function geometryTransferables(packed: Iterable<PackedGeometry>): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const p of packed) {
    for (const a of Object.values(p.attributes)) buffers.add(a.array.buffer as ArrayBuffer);
    if (p.index) buffers.add(p.index.buffer as ArrayBuffer);
  }
  return [...buffers];
}

// --- wire protocol -----------------------------------------------------------

type WireRequest<Req> = { t: "build"; seq: number; req: Req };

type WireResponse<Res> =
  | { t: "ready" }
  | { t: "done"; seq: number; res: Res }
  | { t: "error"; seq: number; message: string };

// --- client (main thread) ----------------------------------------------------

/** The slice of Worker the client uses — tests substitute a scripted fake. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export type BuildClient<Req, Res> = {
  /** Ask for a build. Fire-and-forget: while a build is in flight only the newest request is
   *  kept, so calling this on every input event is the intended usage. */
  request(req: Req): void;
  /** Subscribe to completed builds (always delivered oldest→newest, never stale reordered).
   *  Returns the unsubscribe. */
  onResult(listener: (res: Res) => void): () => void;
  /** Subscribe to build failures (bad params making a builder throw). The client keeps
   *  serving later requests. Returns the unsubscribe. */
  onError(listener: (message: string) => void): () => void;
  /** Terminate the worker. A later request() starts a fresh one. */
  dispose(): void;
};

/**
 * Latest-wins scheduler over a build worker. The worker is created lazily on the first
 * request — importing a module that calls createBuildClient is safe under SSR.
 */
export function createBuildClient<Req, Res>(makeWorker: () => WorkerLike): BuildClient<Req, Res> {
  let worker: WorkerLike | null = null;
  let ready = false;
  let inFlight = false;
  let seq = 0;
  let pending: { req: Req } | null = null;
  const resultListeners = new Set<(res: Res) => void>();
  const errorListeners = new Set<(message: string) => void>();

  function pump(): void {
    if (!worker || !ready || inFlight || !pending) return;
    const msg: WireRequest<Req> = { t: "build", seq: seq++, req: pending.req };
    pending = null;
    inFlight = true;
    worker.postMessage(msg);
  }

  function ensureWorker(): void {
    if (worker) return;
    worker = makeWorker();
    worker.addEventListener("message", (e) => {
      const msg = e.data as WireResponse<Res>;
      if (msg.t === "ready") {
        ready = true;
      } else if (msg.t === "done") {
        inFlight = false;
        for (const listener of resultListeners) listener(msg.res);
      } else {
        inFlight = false;
        for (const listener of errorListeners) listener(msg.message);
      }
      pump();
    });
  }

  return {
    request(req) {
      ensureWorker();
      pending = { req };
      pump();
    },
    onResult(listener) {
      resultListeners.add(listener);
      return () => void resultListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => void errorListeners.delete(listener);
    },
    dispose() {
      worker?.terminate();
      worker = null;
      ready = false;
      inFlight = false;
      pending = null;
    },
  };
}

// --- server (worker side) ----------------------------------------------------

/** The slice of DedicatedWorkerGlobalScope the server uses — tests substitute a fake. */
export type WorkerScopeLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export type ServeOptions<Res> = {
  /** One-time async setup gating all builds (initCSG(wasmUrl) for CSG apps). */
  init?: () => Promise<unknown> | void;
  /** Transfer list for a result — pass geometryTransferables(...) so buffers move, not copy. */
  transfer?: (res: Res) => Transferable[];
  /** Injection point for tests; defaults to the worker global scope. */
  scope?: WorkerScopeLike;
};

/**
 * The whole worker entry: `serveBuilds(handle, { init, transfer })`. Requests are handled
 * strictly in order, one at a time (the client only ever has one in flight anyway); a handler
 * throw is reported per-request and the loop keeps serving.
 */
export function serveBuilds<Req, Res>(
  handle: (req: Req) => Res | Promise<Res>,
  options: ServeOptions<Res> = {},
): void {
  const scope = options.scope ?? (globalThis as unknown as WorkerScopeLike);
  const ready = Promise.resolve().then(() => options.init?.());
  ready.then(
    () => scope.postMessage({ t: "ready" } satisfies WireResponse<Res>),
    (err: unknown) =>
      scope.postMessage({
        t: "error",
        seq: -1,
        message: `init failed: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies WireResponse<Res>),
  );
  let chain: Promise<unknown> = ready.catch(() => {});
  scope.addEventListener("message", (e) => {
    const msg = e.data as WireRequest<Req>;
    if (msg?.t !== "build") return;
    chain = chain.then(async () => {
      try {
        const res = await handle(msg.req);
        scope.postMessage(
          { t: "done", seq: msg.seq, res } satisfies WireResponse<Res>,
          options.transfer?.(res) ?? [],
        );
      } catch (err) {
        scope.postMessage({
          t: "error",
          seq: msg.seq,
          message: err instanceof Error ? err.message : String(err),
        } satisfies WireResponse<Res>);
      }
    });
  });
}
