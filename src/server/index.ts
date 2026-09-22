import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  assembleFinal,
  cleanup,
  deleteFinal,
  parseRange,
  readFinal,
  sha256,
} from './concat';
import {ApiError, type Clock, type FinalRecord, type PartRecord, type SourceRef, Store} from './store';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type AppOptions = {
  now?: Clock;
  defaultTtlMs?: number;
};

function partDto(store: Store, part: PartRecord) {
  return {
    id: part.id,
    status: part.status,
    size: part.size,
    digest: part.digest,
    createdAt: new Date(part.createdAt).toISOString(),
    completedAt: part.completedAt !== null ? new Date(part.completedAt).toISOString() : null,
    ttlMs: part.ttlMs,
    expiresAt:
      part.completedAt !== null
        ? new Date(part.completedAt + part.ttlMs).toISOString()
        : null,
    expired: store.isExpired(part),
    refCount: part.refCount,
  };
}

function finalDto(record: FinalRecord) {
  return {
    id: record.id,
    createdAt: new Date(record.createdAt).toISOString(),
    totalSize: record.totalSize,
    digest: record.digest,
    entries: record.manifest.map((entry, index) => ({
      index,
      partId: entry.partId,
      start: entry.offset,
      end: entry.offset + entry.size - 1,
      size: entry.size,
      digest: entry.digest,
      via: entry.source.map((source) => `${source.kind}:${source.id}`),
    })),
  };
}

export function createApp(options: AppOptions = {}) {
  const store = new Store(options.now);
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const app = express();

  app.use(express.json({limit: '1mb'}));

  // --- Parts ---------------------------------------------------------------

  app.post('/api/parts', (req, res) => {
    const ttlMs = Number(req.body?.ttlMs ?? defaultTtlMs);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      res.status(400).json({error: 'invalid_ttl'});
      return;
    }
    const part: PartRecord = {
      id: store.nextId('part'),
      status: 'open',
      createdAt: store.now(),
      completedAt: null,
      ttlMs,
      chunks: [],
      data: null,
      digest: null,
      size: 0,
      refCount: 0,
      failAssemble: false,
      failRead: false,
    };
    store.run((tx) => tx.insertPart(part)).then(
      () => res.status(201).json(partDto(store, part)),
      (error) => forwardError(error, res),
    );
  });

  // Raw chunk upload: callers POST text/octet-stream slices; chunks are only
  // concatenated and frozen on completion.
  app.post(
    '/api/parts/:id/chunks',
    express.raw({type: () => true, limit: '25mb'}),
    (req, res) => {
      store.run((tx) => {
        const part = tx.getPart(req.params.id);
        if (part.status !== 'open') throw new ApiError(409, 'part_already_completed');
        const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        part.chunks.push(chunk);
        part.size += chunk.length;
      }).then(
        () => res.status(204).end(),
        (error) => forwardError(error, res),
      );
    },
  );

  app.post('/api/parts/:id/complete', (req, res) => {
    store.run((tx) => {
      const part = tx.getPart(req.params.id);
      if (part.status === 'completed') throw new ApiError(409, 'part_already_completed');
      const data = Buffer.concat(part.chunks);
      if (data.length === 0) {
        // Empty parts are never frozen: they cannot become manifest entries.
        throw new ApiError(400, 'empty_part', {partId: part.id});
      }
      part.data = data;
      part.size = data.length;
      part.digest = sha256(data);
      part.completedAt = store.now();
      part.status = 'completed';
      part.chunks = [];
      if (req.body?.failAssemble) part.failAssemble = true;
      if (req.body?.failRead) part.failRead = true;
      return part;
    }).then(
      (part) => res.json(partDto(store, part)),
      (error) => forwardError(error, res),
    );
  });

  app.get('/api/parts', (_req, res) => {
    res.json([...store.parts.values()].map((part) => partDto(store, part)));
  });

  // Test hook: arm a storage fault for a part.
  app.post('/api/parts/:id/fault', (req, res) => {
    const mode = String(req.body?.mode ?? 'assemble');
    if (mode !== 'assemble' && mode !== 'read') {
      res.status(400).json({error: 'invalid_fault_mode'});
      return;
    }
    store.run((tx) => {
      const part = tx.getPart(req.params.id);
      if (mode === 'assemble') part.failAssemble = true;
      else part.failRead = true;
    }).then(
      () => res.status(204).end(),
      (error) => forwardError(error, res),
    );
  });

  // --- Finals --------------------------------------------------------------

  function parseSources(body: unknown): SourceRef[] {
    const raw = (body as {sources?: unknown})?.sources;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ApiError(400, 'sources_required');
    }
    return raw.map((item, index) => {
      const candidate = item as {kind?: unknown; id?: unknown};
      if (
        (candidate.kind !== 'part' && candidate.kind !== 'final') ||
        typeof candidate.id !== 'string' ||
        candidate.id.length === 0
      ) {
        throw new ApiError(400, 'invalid_source', {index});
      }
      return {kind: candidate.kind, id: candidate.id} as SourceRef;
    });
  }

  app.post('/api/finals', (req, res) => {
    let sources: SourceRef[];
    try {
      sources = parseSources(req.body);
    } catch (error) {
      forwardError(error, res);
      return;
    }
    assembleFinal(store, {sources, id: typeof req.body?.id === 'string' ? req.body.id : undefined}).then(
      (record) => res.status(201).json(finalDto(record)),
      (error) => forwardError(error, res),
    );
  });

  app.get('/api/finals', (_req, res) => {
    res.json(
      [...store.finals.values()].map((record) => ({
        id: record.id,
        createdAt: new Date(record.createdAt).toISOString(),
        totalSize: record.totalSize,
        digest: record.digest,
        entryCount: record.manifest.length,
      })),
    );
  });

  app.get('/api/finals/:id', (req, res) => {
    const record = store.finals.get(req.params.id);
    if (!record) {
      res.status(404).json({error: 'final_not_found'});
      return;
    }
    res.json(finalDto(record));
  });

  app.get('/api/finals/:id/content', (req, res) => {
    const record = store.finals.get(req.params.id);
    if (!record) {
      res.status(404).json({error: 'final_not_found'});
      return;
    }
    let range: {start: number; end: number};
    try {
      const parsed = parseRange(req.headers.range, record.totalSize);
      if (parsed.unsatisfied) {
        res.status(416).set('Content-Range', `bytes */${record.totalSize}`).end();
        return;
      }
      range = parsed.ranges[0];
    } catch (error) {
      forwardError(error, res);
      return;
    }

    const statusCode =
      req.headers.range && (range.start !== 0 || range.end !== record.totalSize - 1)
        ? 206
        : 200;
    res.status(statusCode);
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', 'application/octet-stream');
    res.set('ETag', `"${record.digest}"`);
    if (statusCode === 206) {
      res.set('Content-Range', `bytes ${range.start}-${range.end}/${record.totalSize}`);
    }
    res.set('Content-Length', String(range.end - range.start + 1));

    const stream = readFinal(
      record,
      (id) => {
        const part = store.parts.get(id);
        if (!part) throw new ApiError(410, 'part_reaped', {partId: id});
        return part;
      },
      range,
    );
    stream.on('error', (error) => {
      if (!res.headersSent) {
        // Drop the byte-stream headers prepared for the success path so the
        // JSON error body parses cleanly for the client.
        for (const name of ['content-length', 'content-range', 'content-type', 'etag']) {
          res.removeHeader(name);
        }
        res.status(502).json({error: 'concat_read_failed', reason: error.message});
      } else {
        res.destroy(error);
      }
    });
    stream.pipe(res);
  });

  app.delete('/api/finals/:id', (req, res) => {
    deleteFinal(store, req.params.id).then(
      (record) =>
        res.json({
          id: record.id,
          released: record.manifest.length,
        }),
      (error) => forwardError(error, res),
    );
  });

  // Reaps expired, unreferenced completed parts. Referenced parts survive
  // indefinitely even past their expiry: the final's manifest pins them.
  app.post('/api/maintenance/cleanup', (_req, res) => {
    cleanup(store).then((result) => res.json(result), (error) => forwardError(error, res));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({error: 'bad_json'});
      return;
    }
    next(error);
  });

  return app;
}

function forwardError(error: unknown, res: express.Response): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({error: error.code, details: error.details});
    return;
  }
  res.status(500).json({error: 'internal_error', reason: String((error as Error)?.message)});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
