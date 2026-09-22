import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {StoreError, UploadStore} from '../src/server/store';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function makeStore() {
  let t = 1_000_000;
  const store = new UploadStore();
  store.setClock(() => t);
  const part = (id: string, body: string, ttl = 10_000) => {
    store.createPart(id);
    store.uploadPartData(id, Buffer.from(body));
    store.completePart(id, ttl);
    return id;
  };
  const emptyPart = (id: string, ttl = 10_000) => {
    store.createPart(id);
    store.completePart(id, ttl);
    return id;
  };
  const advance = (ms: number) => {
    t += ms;
  };
  return {store, part, emptyPart, advance, time: () => t};
}

describe('parts', () => {
  it('supports zero-length parts and freezes digest/length/order', async () => {
    const {store, part, emptyPart} = makeStore();
    part('a', 'hello, ');
    emptyPart('b');
    part('c', 'world!');
    const final = await store.commitFinal(
      [
        {kind: 'part', id: 'a'},
        {kind: 'part', id: 'b'},
        {kind: 'part', id: 'c'},
      ],
      'f1',
    );
    expect(final.size).toBe(13);
    expect(final.digest).toBe(sha('hello, world!'));
    expect(final.entries.map(e => [e.partId, e.offset, e.length])).toEqual([
      ['a', 0, 7],
      ['b', 7, 0],
      ['c', 7, 6],
    ]);
  });

  it('rejects an empty source list and references to pending parts', async () => {
    const {store, part} = makeStore();
    part('a', 'x');
    store.createPart('p_pending');
    await expect(store.commitFinal([], 'f')).rejects.toMatchObject({code: 'empty_sources'});
    await expect(
      store.commitFinal([{kind: 'part', id: 'p_pending'}], 'f'),
    ).rejects.toMatchObject({code: 'part_pending'});
    expect(store.finals.size).toBe(0);
  });
});

describe('duplicate references', () => {
  it('repeats bytes in order but counts one distinct reference', async () => {
    const {store, part} = makeStore();
    part('a', 'ab');
    const final = await store.commitFinal(
      [
        {kind: 'part', id: 'a'},
        {kind: 'part', id: 'a'},
        {kind: 'part', id: 'a'},
      ],
      'f1',
    );
    expect(final.size).toBe(6);
    expect(final.digest).toBe(sha('ababab'));
    expect(final.entries).toHaveLength(3);
    expect(store.parts.get('a')!.refCount).toBe(1);
  });
});

describe('expiry and garbage collection', () => {
  it('rejects expired parts at commit time', async () => {
    const {store, part, advance} = makeStore();
    part('a', 'x', 100);
    advance(101);
    await expect(
      store.commitFinal([{kind: 'part', id: 'a'}], 'f'),
    ).rejects.toMatchObject({code: 'part_expired'});
    const {reclaimed} = await store.gc();
    expect(reclaimed.map(p => p.id)).toEqual(['a']);
    // Reclaimed objects can never be referenced by a new final.
    await expect(
      store.commitFinal([{kind: 'part', id: 'a'}], 'f'),
    ).rejects.toMatchObject({code: 'part_reclaimed'});
  });

  it('never reclaims a pinned object, even long past its expiry', async () => {
    const {store, part, advance} = makeStore();
    part('a', 'keep', 100);
    await store.commitFinal([{kind: 'part', id: 'a'}], 'f1');
    advance(100_000);
    const {reclaimed} = await store.gc();
    expect(reclaimed).toEqual([]);
    const object = store.parts.get('a')!;
    expect(object.status).toBe('complete');
    expect(object.content?.toString()).toBe('keep');
  });

  it('reclaims after the last referencing final is deleted', async () => {
    const {store, part, advance} = makeStore();
    part('a', 'temp', 100);
    await store.commitFinal([{kind: 'part', id: 'a'}], 'f1');
    advance(200);
    await store.gc(); // pinned: survives
    expect(store.parts.get('a')!.status).toBe('complete');
    await store.deleteFinal('f1');
    const {reclaimed} = await store.gc();
    expect(reclaimed.map(p => p.id)).toEqual(['a']);
    expect(store.parts.get('a')!.content).toBeUndefined();
  });

  it('refuses to corrupt a pinned immutable object', async () => {
    const {store, part} = makeStore();
    part('a', 'abc');
    await store.commitFinal([{kind: 'part', id: 'a'}], 'f1');
    expect(() => store.corruptPart('a')).toThrow(StoreError);
  });
});

describe('concatenation failure rollback', () => {
  it('reverts provisional refcounts when the publish phase fails', async () => {
    const {store, part} = makeStore();
    part('a', 'aa');
    part('b', 'bb');
    store.faults.beforePublish = () => {
      throw new StoreError('concat_read_failed', 500, 'storage exploded');
    };
    await expect(
      store.commitFinal(
        [
          {kind: 'part', id: 'a'},
          {kind: 'part', id: 'b'},
        ],
        'f1',
      ),
    ).rejects.toMatchObject({code: 'concat_read_failed'});
    expect(store.finals.has('f1')).toBe(false);
    expect(store.parts.get('a')!.refCount).toBe(0);
    expect(store.parts.get('b')!.refCount).toBe(0);
    // Objects are still usable once the fault clears.
    store.faults.beforePublish = undefined;
    const final = await store.commitFinal([{kind: 'part', id: 'a'}], 'f2');
    expect(final.size).toBe(2);
  });

  it('fails closed on digest mismatch (bit rot) and leaves no refs', async () => {
    const {store, part} = makeStore();
    part('a', 'abc');
    part('b', 'xyz');
    store.corruptPart('b');
    await expect(
      store.commitFinal(
        [
          {kind: 'part', id: 'a'},
          {kind: 'part', id: 'b'},
        ],
        'f1',
      ),
    ).rejects.toMatchObject({code: 'digest_mismatch'});
    expect(store.finals.size).toBe(0);
    expect(store.parts.get('a')!.refCount).toBe(0);
    expect(store.parts.get('b')!.refCount).toBe(0);
  });
});

describe('nested composition', () => {
  it('flattens nested finals to leaf entries and shares pins', async () => {
    const {store, part, emptyPart} = makeStore();
    part('a', 'foo');
    emptyPart('e');
    part('b', 'bar');
    const f1 = await store.commitFinal(
      [
        {kind: 'part', id: 'a'},
        {kind: 'part', id: 'e'},
      ],
      'f1',
    );
    const f2 = await store.commitFinal(
      [
        {kind: 'final', id: 'f1'},
        {kind: 'part', id: 'b'},
      ],
      'f2',
    );
    expect(f2.size).toBe(6);
    expect(f2.digest).toBe(sha('foobar'));
    expect(f2.entries.map(e => e.partId)).toEqual(['a', 'e', 'b']);
    // Both live finals pin the shared leaves: one reference counted per final.
    expect(store.parts.get('a')!.refCount).toBe(2);
    expect(store.parts.get('b')!.refCount).toBe(1);
    expect(f1.digest).toBe(sha('foo'));

    // Deleting the outer final releases its extra pin; f1 still holds one.
    await store.deleteFinal('f2');
    expect(store.parts.get('a')!.refCount).toBe(1);
    expect(store.finals.has('f1')).toBe(true);
  });

  it('reuses a published final whose leaves have since expired (still pinned)', async () => {
    const {store, part, advance} = makeStore();
    part('a', 'old', 100);
    await store.commitFinal([{kind: 'part', id: 'a'}], 'f1');
    advance(1_000);
    await store.gc(); // pinned, survives expiry
    // Direct reuse of the expired leaf is rejected...
    await expect(
      store.commitFinal([{kind: 'part', id: 'a'}], 'f2'),
    ).rejects.toMatchObject({code: 'part_expired'});
    // ...but reuse through the published final is allowed and pins again.
    const f3 = await store.commitFinal([{kind: 'final', id: 'f1'}], 'f3');
    expect(f3.digest).toBe(sha('old'));
    // f1 and f3 both pin the leaf; expiry never applied while it was pinned.
    expect(store.parts.get('a')!.refCount).toBe(2);
  });
});

describe('concurrent publication vs cleanup', () => {
  it('preserves the refcount invariant under interleaved commits and GC sweeps', async () => {
    const {store, part, advance} = makeStore();
    const ids = Array.from({length: 20}, (_, i) => {
      const id = `p${i}`;
      // Half expire immediately when unreferenced; the rest stay fresh.
      part(id, `body-${i}`, i % 2 === 0 ? 50 : 100_000);
      return id;
    });

    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      const a = ids[i % ids.length];
      const b = ids[(i * 7 + 3) % ids.length];
      // Some commits may legitimately fail once short-TTL objects expire;
      // failures roll back atomically, which is also under test here.
      jobs.push(
        store
          .commitFinal([{kind: 'part', id: a}, {kind: 'part', id: b}], `f${i}`)
          .catch(err => err),
      );
      if (i % 5 === 0) {
        advance(60);
        jobs.push(store.gc());
      }
    }
    await Promise.all(jobs);

    // No successful final references a reclaimed or missing object.
    for (const final of store.finals.values()) {
      for (const entry of final.entries) {
        const object = store.parts.get(entry.partId);
        expect(object?.status).toBe('complete');
        expect(object?.content).toBeInstanceOf(Buffer);
        expect(object?.digest).toBe(entry.digest);
      }
    }

    // refCount exactly equals the number of distinct live finals referencing it.
    const expected = new Map<string, number>();
    for (const final of store.finals.values()) {
      for (const id of new Set(final.entries.map(e => e.partId))) {
        expected.set(id, (expected.get(id) ?? 0) + 1);
      }
    }
    for (const object of store.parts.values()) {
      expect(object.refCount).toBe(expected.get(object.id) ?? 0);
      if (object.refCount > 0) expect(object.status).toBe('complete');
    }
  });
});
