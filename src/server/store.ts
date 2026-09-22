import {createHash} from 'node:crypto';

/**
 * In-memory domain store for the resumable-upload concatenation workbench.
 *
 * Guarantees:
 *  - A completed part object is never reclaimed while any live final references it.
 *  - A successfully published final always references complete, present objects;
 *    part id / digest / length / order are frozen in the manifest at publish time.
 *  - Refcount mutations and final publication happen in one serializable transaction;
 *    failures roll provisional increments back.
 *  - Reads stream zero-copy Buffer views over part boundaries and honour byte ranges.
 */

export type PartStatus = 'pending' | 'complete' | 'reclaimed';

export interface Part {
  id: string;
  status: PartStatus;
  size: number;
  /** sha256 hex, frozen on completion; null once the object has been reclaimed. */
  digest: string | null;
  createdAt: number;
  /** GC deadline while unreferenced; Infinity for pending parts. */
  expiresAt: number;
  /** Number of distinct live finals referencing this object. */
  refCount: number;
  /** Present for pending/complete parts; dropped on reclamation. */
  content?: Buffer;
  /** Chaos/debug marker: backing bytes no longer match the frozen digest. */
  corrupted: boolean;
}

export interface ManifestEntry {
  ordinal: number;
  partId: string;
  offset: number;
  length: number;
  digest: string;
}

export interface Final {
  id: string;
  size: number;
  /** sha256 over the concatenation of every entry in order. */
  digest: string;
  createdAt: number;
  entries: ManifestEntry[];
}

export interface SourceRef {
  kind: 'part' | 'final';
  id: string;
}

export type StoreErrorCode =
  | 'part_not_found'
  | 'final_not_found'
  | 'part_pending'
  | 'part_reclaimed'
  | 'part_expired'
  | 'part_not_empty'
  | 'digest_mismatch'
  | 'empty_sources'
  | 'final_exists'
  | 'part_exists'
  | 'nested_cycle'
  | 'concat_read_failed';

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface FaultHooks {
  /** Thrown after provisional refcount increments, before the manifest is published. */
  beforePublish?: () => void;
}

const hashChunks = (chunks: Buffer[]): string => {
  const h = createHash('sha256');
  for (const chunk of chunks) h.update(chunk);
  return h.digest('hex');
};

const sha256 = (buf: Buffer): string => hashChunks([buf]);

const uid = (prefix: string) =>
  prefix +
  Math.random().toString(36).slice(2, 10) +
  Date.now().toString(36).slice(-4);

export class UploadStore {
  readonly parts = new Map<string, Part>();
  readonly finals = new Map<string, Final>();
  private clock: () => number = () => Date.now();
  /** Chaos/test hooks. */
  faults: FaultHooks = {};
  /** Part id whose backing storage fails to read (chaos simulation). */
  readFaultPartId: string | null = null;

  private chain: Promise<unknown> = Promise.resolve();

  /** Serialise every mutating transaction and every snapshot read. */
  withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  setClock(clock: () => number) {
    this.clock = clock;
  }

  now(): number {
    return this.clock();
  }

  // ----- parts -------------------------------------------------------------

  createPart(id?: string): Part {
    const partId = id ?? uid('p_');
    if (this.parts.has(partId)) throw new StoreError('part_exists', 409);
    const part: Part = {
      id: partId,
      status: 'pending',
      size: 0,
      digest: null,
      createdAt: this.now(),
      expiresAt: Number.POSITIVE_INFINITY,
      refCount: 0,
      content: Buffer.alloc(0),
      corrupted: false,
    };
    this.parts.set(partId, part);
    return part;
  }

  /** Replace the staged bytes of a pending part. */
  uploadPartData(id: string, data: Buffer): Part {
    const part = this.requirePart(id);
    if (part.status === 'reclaimed') throw new StoreError('part_reclaimed', 409);
    if (part.status !== 'pending') throw new StoreError('part_not_empty', 409);
    part.content = Buffer.from(data);
    part.size = part.content.length;
    return part;
  }

  /** Freeze a pending part: digest, length and GC deadline. */
  completePart(id: string, ttlMs = 3_600_000): Part {
    const part = this.requirePart(id);
    if (part.status === 'reclaimed') throw new StoreError('part_reclaimed', 409);
    if (part.status === 'complete') return part;
    const content = part.content ?? Buffer.alloc(0);
    part.size = content.length; // zero-length parts are first-class
    part.digest = sha256(content);
    part.status = 'complete';
    part.expiresAt = this.now() + ttlMs;
    return part;
  }

  /**
   * Chaos hook: flip a byte of an unreferenced completed part so the frozen
   * digest no longer matches. Only allowed while nothing references the object,
   * because a pinned object must be immutable for the lifetime of the final.
   */
  corruptPart(id: string): Part {
    const part = this.requirePart(id);
    if (part.status !== 'complete') throw new StoreError('part_pending', 409);
    if (part.refCount > 0) throw new StoreError('part_not_empty', 409);
    const content = part.content;
    if (!content || content.length === 0) {
      // An empty part has no byte to flip; its digest can never mismatch.
      throw new StoreError('part_not_empty', 400);
    }
    content[0] ^= 0xff;
    part.corrupted = !part.corrupted;
    return part;
  }

  private requirePart(id: string): Part {
    const part = this.parts.get(id);
    if (!part) throw new StoreError('part_not_found', 404);
    return part;
  }

  // ----- final publication -------------------------------------------------

  /**
   * Publish a composite final.
   *
   * Transaction phases (all under the store lock):
   *   1. Resolve & validate every source: parts must be complete, unexpired,
   *      present and match their frozen digest; nested finals expand to leaves.
   *   2. Apply provisional refcount increments (one per distinct object).
   *   3. Freeze the manifest (ordinal / id / offset / length / digest) and the
   *      composite digest, then publish atomically.
   * Any failure rolls provisional increments back; no final is visible.
   */
  async commitFinal(sources: SourceRef[], id?: string): Promise<Final> {
    return this.withLock(async () => {
      const finalId = id ?? uid('f_');
      if (this.finals.has(finalId)) throw new StoreError('final_exists', 409);
      if (!Array.isArray(sources) || sources.length === 0) {
        throw new StoreError('empty_sources', 400);
      }

      const now = this.now();
      // Ordered leaf parts; duplicates are intentionally preserved.
      const leaves: Part[] = [];

      const addPart = (partId: string, expiredAllowed: boolean) => {
        const part = this.parts.get(partId);
        if (!part) {
          throw new StoreError('part_not_found', 404, `part ${partId} not found`);
        }
        if (part.status === 'reclaimed') {
          throw new StoreError('part_reclaimed', 409, `part ${partId} was reclaimed`);
        }
        if (part.status !== 'complete') {
          throw new StoreError('part_pending', 409, `part ${partId} is not complete`);
        }
        if (!expiredAllowed && part.expiresAt <= now) {
          // A directly-referenced part must still be alive at publish time.
          throw new StoreError('part_expired', 409, `part ${partId} expired`);
        }
        const content = part.content;
        if (!content) throw new StoreError('part_reclaimed', 409);
        // Verify the frozen digest: this is the concatenation-time integrity
        // check and fails closed on corrupted backing storage.
        if (sha256(content) !== part.digest) {
          throw new StoreError('digest_mismatch', 409, `part ${partId} digest mismatch`);
        }
        leaves.push(part);
      };

      const addFinal = (refId: string, seen: Set<string>) => {
        if (seen.has(refId)) throw new StoreError('nested_cycle', 400);
        seen.add(refId);
        const nested = this.finals.get(refId);
        if (!nested) {
          throw new StoreError('final_not_found', 404, `final ${refId} not found`);
        }
        // Published finals are immutable: their leaves are pinned for as long
        // as the nested final lives, so expiry is not re-checked on reuse.
        for (const entry of nested.entries) addPart(entry.partId, true);
      };

      for (const source of sources) {
        if (!source || (source.kind !== 'part' && source.kind !== 'final')) {
          throw new StoreError('empty_sources', 400);
        }
        if (source.kind === 'part') addPart(source.id, false);
        else addFinal(source.id, new Set());
      }

      // Phase 2: provisional refcounts, one per distinct object.
      const touched = new Set<string>();
      for (const part of leaves) {
        if (!touched.has(part.id)) {
          part.refCount += 1;
          touched.add(part.id);
        }
      }

      try {
        // Phase 3: freeze the manifest and composite digest. A fault here
        // (e.g. storage failure while assembling) rolls the transaction back.
        this.faults.beforePublish?.();

        const entries: ManifestEntry[] = [];
        let offset = 0;
        leaves.forEach((part, ordinal) => {
          entries.push({
            ordinal,
            partId: part.id,
            offset,
            length: part.size,
            digest: part.digest as string,
          });
          offset += part.size;
        });

        const final: Final = {
          id: finalId,
          size: offset,
          digest: hashChunks(leaves.map(part => part.content as Buffer)),
          createdAt: now,
          entries,
        };
        this.finals.set(finalId, final); // atomic publication point
        return final;
      } catch (error) {
        for (const partId of touched) {
          const part = this.parts.get(partId);
          if (part) part.refCount = Math.max(0, part.refCount - 1);
        }
        throw error;
      }
    });
  }

  // ----- reads -------------------------------------------------------------

  /** Zero-copy read plan over a byte window, resolved under the lock. */
  readPlan(finalId: string, start: number, endInclusive: number) {
    const final = this.requireFinal(finalId);
    const segments: {partId: string; view: Buffer}[] = [];
    for (const entry of final.entries) {
      const entryEnd = entry.offset + entry.length - 1;
      if (entryEnd < start || entry.offset > endInclusive) continue;
      const part = this.parts.get(entry.partId);
      if (!part || part.status !== 'complete' || !part.content) {
        throw new StoreError('concat_read_failed', 500, `object ${entry.partId} unreadable`);
      }
      const from = Math.max(start, entry.offset) - entry.offset;
      const to = Math.min(endInclusive, entryEnd) - entry.offset;
      // subarray shares memory: the view keeps bytes alive even if a GC sweep
      // nulls part.content after this snapshot is released from the lock.
      segments.push({partId: part.id, view: part.content.subarray(from, to + 1)});
    }
    return {final, segments};
  }

  private requireFinal(id: string): Final {
    const final = this.finals.get(id);
    if (!final) throw new StoreError('final_not_found', 404);
    return final;
  }

  // ----- deletion & reclamation -------------------------------------------

  /** Delete a final and release its references synchronously with the removal. */
  async deleteFinal(id: string): Promise<Final> {
    return this.withLock(() => {
      const final = this.requireFinal(id);
      const referenced = new Set<string>();
      for (const entry of final.entries) referenced.add(entry.partId);
      for (const partId of referenced) {
        const part = this.parts.get(partId);
        if (part) part.refCount = Math.max(0, part.refCount - 1);
      }
      this.finals.delete(id);
      return final;
    });
  }

  /**
   * Reclaim objects that are expired AND unreferenced.
   * Pinned objects (refCount > 0) can never be reclaimed, regardless of age.
   */
  async gc(): Promise<{reclaimed: Part[]; now: number}> {
    return this.withLock(() => {
      const now = this.now();
      const reclaimed: Part[] = [];
      for (const part of this.parts.values()) {
        if (
          part.status === 'complete' &&
          part.refCount === 0 &&
          part.expiresAt <= now
        ) {
          part.status = 'reclaimed';
          part.content = undefined;
          part.digest = null;
          reclaimed.push(part); // tombstone keeps historical length
        }
      }
      return {reclaimed, now};
    });
  }
}
