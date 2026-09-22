import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {
  ApiError,
  type FinalRecord,
  type ManifestEntry,
  type PartRecord,
  type SourceRef,
  Store,
  Tx,
} from './store';

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

type Leaf = {
  part: PartRecord;
  // Provenance chain: the directly supplied reference plus every nested final
  // the leaf was reached through (outermost nested final last).
  source: SourceRef[];
};

function leafFromSource(tx: Tx, source: SourceRef, leaves: Leaf[]): void {
  if (source.kind === 'part') {
    const part = tx.getPart(source.id);
    if (part.status !== 'completed' || part.data === null) {
      throw new ApiError(409, 'part_not_completed', {partId: part.id});
    }
    // Empty parts are rejected when they are completed, but defend the
    // invariant here too: a manifest must not carry zero-length entries.
    if (part.size === 0) {
      throw new ApiError(400, 'empty_part', {partId: part.id});
    }
    if (tx.store.isExpired(part)) {
      throw new ApiError(410, 'part_expired', {partId: part.id});
    }
    leaves.push({part, source: [source]});
    return;
  }
  const inner = tx.getFinal(source.id);
  for (const entry of inner.manifest) {
    const part = tx.getPart(entry.partId);
    // Nested finals pin their leaves, so the part must exist; a mismatch
    // means on-disk corruption rather than a client error.
    if (
      part.status !== 'completed' ||
      part.digest !== entry.digest ||
      part.size !== entry.size
    ) {
      throw new ApiError(409, 'corrupt_manifest', {
        finalId: inner.id,
        partId: entry.partId,
      });
    }
    // Provenance of a flattened leaf: the inner final's own provenance plus
    // the hop through the inner final id.
    leaves.push({
      part,
      source: [...entry.source, {kind: 'final', id: inner.id}],
    });
  }
}

// Expands user-supplied references into leaf parts.
//
// Nested concat strategy: flatten on write. A final manifest only ever points
// at concrete parts (with frozen digests and sizes), never at another
// manifest. Deleting an inner final therefore cannot break an outer one, read
// time needs no manifest indirection, and leaf reference counts stay exact.
// Because manifests are flattened when published, nesting is exactly one hop
// deep at assembly time.
function flatten(tx: Tx, sources: SourceRef[]): Leaf[] {
  const leaves: Leaf[] = [];
  for (const source of sources) leafFromSource(tx, source, leaves);
  return leaves;
}

// Streams a part blob once during assembly so a storage fault fails the
// assembly and rolls reference counts / manifest publication back. Read-time
// faults (failRead) are deliberately tolerated here.
async function verifyReadable(leaves: Leaf[]): Promise<void> {
  for (const leaf of leaves) {
    if (!leaf.part.failAssemble) continue;
    try {
      for await (const _chunk of readPart(leaf.part, 0, leaf.part.size)) {
        void _chunk;
      }
    } catch (error) {
      throw new ApiError(502, 'concat_failed', {
        partId: leaf.part.id,
        reason: (error as Error).message,
      });
    }
  }
}

export type AssembleInput = {
  sources: SourceRef[];
  id?: string;
};

// Creates and atomically publishes a final. Freezing (id/digest/size/order),
// reference counting and manifest publication happen in one transaction: any
// failure rolls every increment and the (not yet visible) manifest back.
export async function assembleFinal(
  store: Store,
  input: AssembleInput,
): Promise<FinalRecord> {
  return store.run(async (tx) => {
    const leaves = flatten(tx, input.sources);
    if (leaves.length === 0) {
      throw new ApiError(400, 'empty_manifest');
    }
    await verifyReadable(leaves);

    const manifest: ManifestEntry[] = [];
    let offset = 0;
    const digestHash = createHash('sha256');
    for (const leaf of leaves) {
      const {part} = leaf;
      manifest.push({
        partId: part.id,
        size: part.size,
        offset,
        digest: part.digest!,
        source: leaf.source,
      });
      // Duplicate references are legal and each occurrence holds its own
      // reference: deleting the final once releases both.
      tx.addRef(part, 1);
      digestHash.update(`${part.id}:${part.digest}:${part.size}\n`);
      offset += part.size;
    }

    const record: FinalRecord = {
      id: input.id ?? store.nextId('final'),
      createdAt: store.now(),
      totalSize: offset,
      digest: digestHash.digest('hex'),
      manifest,
    };
    // Publication is the last step: until this returns the final is invisible.
    tx.insertFinal(record);
    return record;
  });
}

export async function deleteFinal(
  store: Store,
  id: string,
): Promise<FinalRecord> {
  return store.run((tx) => {
    const record = tx.deleteFinal(id);
    for (const entry of record.manifest) {
      tx.addRef(tx.getPart(entry.partId), -1);
    }
    return record;
  });
}

export async function cleanup(store: Store): Promise<{reaped: string[]}> {
  return store.run((tx) => ({reaped: tx.reap()}));
}

// --- Reading: boundary-aware streaming with HTTP byte-range support -------

export function parseRange(
  header: string | undefined,
  totalSize: number,
): {ranges: Array<{start: number; end: number}>; unsatisfied: boolean} {
  if (!header || !header.startsWith('bytes=')) {
    return {ranges: [{start: 0, end: totalSize - 1}], unsatisfied: false};
  }
  const spec = header.slice(6).trim();
  if (spec.includes(',')) {
    // The workbench only streams one contiguous window per request.
    throw new ApiError(416, 'range_not_satisfiable', {multiRange: true});
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === '' && match[2] === '')) {
    throw new ApiError(416, 'range_not_satisfiable', {header});
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    // Suffix range: bytes=-N (last N bytes).
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) {
      throw new ApiError(416, 'range_not_satisfiable', {header});
    }
    if (totalSize === 0 || suffix >= totalSize) {
      start = 0;
    } else {
      start = totalSize - suffix;
    }
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? totalSize - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new ApiError(416, 'range_not_satisfiable', {header});
    }
  }
  if (totalSize === 0 || start >= totalSize) {
    return {ranges: [], unsatisfied: true};
  }
  return {ranges: [{start, end: Math.min(end, totalSize - 1)}], unsatisfied: false};
}

// Streams the [start, end] byte window of a final, slicing each touched part
// at part boundaries. A storage fault surfaces as an 'error' event on the
// returned stream.
export function readFinal(
  record: FinalRecord,
  resolvePart: (id: string) => PartRecord,
  range: {start: number; end: number},
): Readable {
  async function* concat(): AsyncGenerator<Buffer> {
    for (const entry of record.manifest) {
      const partStart = entry.offset;
      const partEnd = entry.offset + entry.size - 1;
      if (partEnd < range.start || partStart > range.end) continue;
      const sliceStart = Math.max(range.start, partStart) - partStart;
      const sliceEnd = Math.min(range.end, partEnd) - partStart;
      // A child error rejects the for-await loop and destroys the outer
      // stream, so faults mid-concat abort the response.
      yield* readPart(resolvePart(entry.partId), sliceStart, sliceEnd + 1);
    }
  }
  return Readable.from(concat());
}

// Reads [start, end) of one part as an async iterable of buffers. Parts
// flagged with a read fault reject instead, simulating a storage failure
// mid-concat.
async function* readPart(
  part: PartRecord,
  start: number,
  end: number,
): AsyncGenerator<Buffer> {
  // Deferred one tick so a faulty first segment surfaces before any byte is
  // written: callers can still answer with a clean error status.
  await new Promise((resolve) => process.nextTick(resolve));
  if (part.failRead || part.failAssemble) {
    throw new Error(`io_error: ${part.id}`);
  }
  yield part.data!.subarray(start, end);
}
