// Transactional in-memory store for the resumable upload workbench.
//
// Parts are the completed chunks of a resumable upload. A final upload is a
// manifest referencing parts (possibly repeatedly, possibly flattened from
// nested finals). No bytes are copied when a final is assembled: the store
// keeps every part blob once and relies on reference counts to decide when a
// part may be reaped.

export type PartStatus = 'open' | 'completed';

export type PartRecord = {
  id: string;
  status: PartStatus;
  createdAt: number;
  completedAt: number | null;
  ttlMs: number; // expiry window, counted from completion
  chunks: Buffer[]; // raw uploaded chunks
  data: Buffer | null; // frozen blob once completed
  digest: string | null; // sha256 hex of the frozen blob
  size: number;
  refCount: number; // number of manifest entries (duplicates count separately)
  failAssemble: boolean; // test hook: storage fault while assembling a final
  failRead: boolean; // test hook: storage fault while streaming content
};

// One flattened leaf reference inside a final manifest.
export type ManifestEntry = {
  partId: string;
  size: number;
  offset: number; // absolute offset inside the assembled final
  digest: string;
  source: SourceRef[]; // user-supplied references that produced this leaf
};

// A reference as provided by the client: either a raw part or a nested final.
export type SourceRef = {kind: 'part'; id: string} | {kind: 'final'; id: string};

export type FinalRecord = {
  id: string;
  createdAt: number;
  totalSize: number;
  digest: string;
  manifest: ManifestEntry[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

export type Clock = () => number;

export class Store {
  parts = new Map<string, PartRecord>();
  finals = new Map<string, FinalRecord>();
  now: Clock;
  private seq = 0;

  constructor(now: Clock = () => Date.now()) {
    this.now = now;
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.now().toString(36)}_${this.seq.toString(36)}`;
  }

  isExpired(part: PartRecord, at: number = this.now()): boolean {
    return (
      part.status === 'completed' &&
      part.completedAt !== null &&
      at - part.completedAt > part.ttlMs
    );
  }

  // Serialises all mutating transactions. Anything registered via tx.undo is
  // replayed in reverse on a thrown error, so failed assemblies or failed
  // deletes leave the store exactly as they was. Because assembly and reaping
  // take the same lock, a cleaner can never remove a part that a concurrent
  // final assembly is in the middle of referencing.
  private lock: Promise<void> = Promise.resolve();

  async run<T>(fn: (tx: Tx) => Promise<T> | T): Promise<T> {
    const acquire = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await acquire;
    const tx = new Tx(this);
    try {
      const result = await fn(tx);
      tx.committed = true;
      return result;
    } finally {
      if (!tx.committed) tx.rollback();
      release();
    }
  }
}

export class Tx {
  committed = false;
  private undos: Array<() => void> = [];

  constructor(public store: Store) {}

  onRollback(undo: () => void): void {
    this.undos.push(undo);
  }

  rollback(): void {
    for (let i = this.undos.length - 1; i >= 0; i -= 1) {
      try {
        this.undos[i]();
      } catch {
        // undo steps are best effort; continue unwinding the rest
      }
    }
    this.undos = [];
  }

  getPart(id: string): PartRecord {
    const part = this.store.parts.get(id);
    if (!part) throw new ApiError(404, 'part_not_found', {partId: id});
    return part;
  }

  getFinal(id: string): FinalRecord {
    const record = this.store.finals.get(id);
    if (!record) throw new ApiError(404, 'final_not_found', {finalId: id});
    return record;
  }

  insertPart(part: PartRecord): void {
    this.store.parts.set(part.id, part);
    this.onRollback(() => this.store.parts.delete(part.id));
  }

  insertFinal(record: FinalRecord): void {
    if (this.store.finals.has(record.id)) {
      throw new ApiError(409, 'final_exists', {finalId: record.id});
    }
    this.store.finals.set(record.id, record);
    this.onRollback(() => this.store.finals.delete(record.id));
  }

  deleteFinal(id: string): FinalRecord {
    const record = this.getFinal(id);
    this.store.finals.delete(id);
    this.onRollback(() => this.store.finals.set(id, record));
    return record;
  }

  addRef(part: PartRecord, delta: number): void {
    const before = part.refCount;
    part.refCount += delta;
    if (part.refCount < 0) {
      // Revert synchronously and signal a store invariant violation.
      part.refCount = before;
      throw new ApiError(500, 'refcount_underflow', {partId: part.id});
    }
    this.onRollback(() => {
      part.refCount = before;
    });
  }

  // Reclaims every completed part that is both expired and unreferenced.
  // Reaping runs inside the same kind of transaction as assembly, so it can
  // never remove a part that a concurrent final assembly just referenced.
  reap(at: number = this.store.now()): string[] {
    const reaped: string[] = [];
    for (const [id, part] of this.store.parts) {
      if (part.status !== 'completed' || part.refCount > 0) continue;
      if (!this.store.isExpired(part, at)) continue;
      this.store.parts.delete(id);
      this.onRollback(() => this.store.parts.set(id, part));
      reaped.push(id);
    }
    return reaped;
  }
}
