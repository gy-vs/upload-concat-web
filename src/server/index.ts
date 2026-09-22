import express, {type NextFunction, type Request, type Response} from 'express';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {
  StoreError,
  UploadStore,
  type Final,
  type Part,
  type SourceRef,
} from './store';

/**
 * RFC 7233 single-range parser.
 * Returns null when the Range header is absent/malformed (server ignores it),
 * or {unsatisfiable:true} when it is syntactically valid but out of bounds.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): {start: number; end: number} | {unsatisfiable: true} | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // malformed => ignore header, send 200
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // Suffix range: bytes=-N (last N bytes). Empty representation when size is 0.
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    if (size === 0) return {unsatisfiable: true};
    return {start: Math.max(0, size - suffix), end: size - 1};
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0) return null;
  if (start >= size) return {unsatisfiable: true};
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isInteger(end) || end < start) return {unsatisfiable: true};
  return {start, end};
}

const partView = (part: Part) => ({
  id: part.id,
  status: part.status,
  size: part.size,
  digest: part.digest,
  createdAt: part.createdAt,
  expiresAt: Number.isFinite(part.expiresAt) ? part.expiresAt : null,
  refCount: part.refCount,
  corrupted: part.corrupted,
});

const finalView = (final: Final) => ({
  id: final.id,
  size: final.size,
  digest: final.digest,
  createdAt: final.createdAt,
  entries: final.entries,
});

export function createApp(store = new UploadStore()) {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  app.locals.store = store;

  const idOf = (req: Request) => String(req.params.id);

  const wrap =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };

  // ----- parts -------------------------------------------------------------

  app.get(
    '/api/parts',
    wrap((_req, res) => {
      res.json([...store.parts.values()].map(partView));
    }),
  );

  app.post(
    '/api/parts',
    wrap((req, res) => {
      const part = store.createPart(req.body?.id);
      res.status(201).json(partView(part));
    }),
  );

  app.put(
    '/api/parts/:id/data',
    express.raw({type: '*/*', limit: '50mb'}),
    wrap((req, res) => {
      const part = store.uploadPartData(idOf(req), req.body as Buffer);
      res.json(partView(part));
    }),
  );

  app.post(
    '/api/parts/:id/complete',
    wrap((req, res) => {
      const ttl = Number(req.body?.ttlMs);
      const part = store.completePart(
        idOf(req),
        Number.isFinite(ttl) && ttl > 0 ? ttl : 3_600_000,
      );
      res.json(partView(part));
    }),
  );

  // Chaos toggle used by the workbench UI and tests.
  app.post(
    '/api/parts/:id/corrupt',
    wrap((req, res) => {
      const part = store.corruptPart(idOf(req));
      res.json(partView(part));
    }),
  );

  app.post(
    '/api/chaos/read-fault',
    wrap((req, res) => {
      store.readFaultPartId = req.body?.partId ?? null;
      res.json({readFaultPartId: store.readFaultPartId});
    }),
  );

  // ----- finals ------------------------------------------------------------

  app.get(
    '/api/finals',
    wrap((_req, res) => {
      res.json([...store.finals.values()].map(finalView));
    }),
  );

  app.post(
    '/api/finals',
    wrap(async (req, res) => {
      const sources = req.body?.sources as SourceRef[] | undefined;
      const final = await store.commitFinal(sources ?? [], req.body?.id);
      res.status(201).json(finalView(final));
    }),
  );

  app.get(
    '/api/finals/:id/content',
    wrap(async (req, res) => {
      const probe = await store.withLock(() => {
        const final = store.finals.get(idOf(req));
        return final ? final.size : null;
      });
      if (probe === null) {
        res.status(404).json({error: 'final_not_found'});
        return;
      }
      const size = probe;

      const range = parseRange(req.header('range'), size);
      if (range && 'unsatisfiable' in range) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${size}`);
        res.json({error: 'range_not_satisfiable', size});
        return;
      }

      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;

      // Snapshot zero-copy views under the lock; stream afterwards.
      const plan = store.readPlan(idOf(req), start, end);

      res.status(range ? 206 : 200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', `"${plan.final.digest}"`);
      if (range) {
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.setHeader('Content-Length', String(length));

      const stream = new Readable({
        read() {
          // Pushed outside the lock; the Buffer views own the bytes.
          for (const segment of plan.segments) {
            if (store.readFaultPartId === segment.partId) {
              this.destroy(
                new StoreError('concat_read_failed', 500, 'mid-stream read fault'),
              );
              return;
            }
            this.push(segment.view);
          }
          this.push(null);
        },
      });
      stream.on('error', err => {
        if (!res.headersSent) res.status(500).json({error: 'concat_read_failed'});
        else res.destroy(err instanceof Error ? err : undefined);
      });
      stream.pipe(res);
    }),
  );

  app.delete(
    '/api/finals/:id',
    wrap(async (req, res) => {
      const final = await store.deleteFinal(idOf(req));
      res.json(finalView(final));
    }),
  );

  // ----- reclamation -------------------------------------------------------

  app.post(
    '/api/gc',
    wrap(async (_req, res) => {
      const {reclaimed, now} = await store.gc();
      res.json({reclaimed: reclaimed.map(partView), now});
    }),
  );

  // ----- error mapping -----------------------------------------------------

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof StoreError) {
        res.status(err.status).json({error: err.code, message: err.message});
        return;
      }
      res.status(500).json({error: 'internal', message: String(err)});
    },
  );

  return app;
}

/** Demo seed so the workbench is useful immediately. */
export function seedDemo(store: UploadStore) {
  const a = store.createPart('p_seed_a');
  store.uploadPartData(a.id, Buffer.from('hello, '));
  store.completePart(a.id, 3_600_000);

  const b = store.createPart('p_seed_b'); // empty part
  store.completePart(b.id, 3_600_000);

  const c = store.createPart('p_seed_c');
  store.uploadPartData(c.id, Buffer.from('world!'));
  store.completePart(c.id, 3_600_000);

  // Expired and unreferenced: a manual GC sweep reclaims it.
  const stale = store.createPart('p_seed_stale');
  store.uploadPartData(stale.id, Buffer.from('forgotten bytes'));
  store.completePart(stale.id, -10_000);

  void store.commitFinal(
    [
      {kind: 'part', id: a.id},
      {kind: 'part', id: b.id},
      {kind: 'part', id: c.id},
    ],
    'f_seed',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = new UploadStore();
  seedDemo(store);
  // Pinned objects are immune; this only ever sweeps expired unreferenced ones.
  const timer = setInterval(() => void store.gc(), 15_000);
  timer.unref?.();
  createApp(store).listen(4174, '127.0.0.1', () =>
    console.log('server http://127.0.0.1:4174'),
  );
}
