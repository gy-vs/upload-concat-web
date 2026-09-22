import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import request from 'supertest';
import type {Test} from 'supertest';
import {createApp} from '../src/server/index';
import type {Express} from 'express';

// Controllable clock so TTL expiry can be driven deterministically.
function makeHarness(defaultTtlMs = 5000) {
  let now = 1_000_000;
  const app = createApp({now: () => now, defaultTtlMs});
  const advance = (ms: number) => {
    now += ms;
  };
  return {app, advance};
}

async function createPart(app: Express, chunks: Buffer[], ttlMs?: number) {
  const created = await request(app).post('/api/parts').send(ttlMs ? {ttlMs} : {}).expect(201);
  const id = created.body.id as string;
  for (const chunk of chunks) {
    await request(app).post(`/api/parts/${id}/chunks`).set('Content-Type', 'application/octet-stream').send(chunk).expect(204);
  }
  const done = await request(app).post(`/api/parts/${id}/complete`).send({}).expect(200);
  return done.body as {id: string; size: number; digest: string; refCount: number; expiresAt: string};
}

function assemble(app: Express, sources: unknown[]): Test {
  return request(app).post('/api/finals').send({sources});
}

// Collects a raw response (octet-stream bypasses superagent's text parsing).
async function fetchContent(app: Express, url: string, range?: string) {
  const chunks: Buffer[] = [];
  const req = request(app).get(url).buffer(true);
  if (range) req.set('Range', range);
  req.parse((response, callback) => {
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  });
  const res = await req;
  return {res, text: (res.body as Buffer).toString('utf8')};
}

describe('resumable upload assembly', () => {
  let app: Express;
  let advance: (ms: number) => void;

  beforeAll(() => {
    const harness = makeHarness();
    app = harness.app;
    advance = harness.advance;
  });

  it('assembles completed parts in order without copying bytes', async () => {
    const a = await createPart(app, [Buffer.from('hello ')]);
    const b = await createPart(app, [Buffer.from('world')]);
    const res = await assemble(app, [{kind: 'part', id: a.id}, {kind: 'part', id: b.id}]).expect(201);
    expect(res.body.totalSize).toBe(11);
    expect(res.body.entries.map((e: {partId: string}) => e.partId)).toEqual([a.id, b.id]);
    // frozen boundaries
    expect(res.body.entries[0]).toMatchObject({start: 0, end: 5, size: 6});
    expect(res.body.entries[1]).toMatchObject({start: 6, end: 10, size: 5});
    // reference counts move with publication
    const parts = await request(app).get('/api/parts').expect(200);
    const counts = Object.fromEntries(parts.body.map((p: {id: string; refCount: number}) => [p.id, p.refCount]));
    expect(counts[a.id]).toBe(1);
    expect(counts[b.id]).toBe(1);

    const content = await fetchContent(app, `/api/finals/${res.body.id}/content`);
    expect(content.text).toBe('hello world');
  });

  it('rejects empty parts on completion and empty manifests on assembly', async () => {
    const created = await request(app).post('/api/parts').send({}).expect(201);
    await request(app).post(`/api/parts/${created.body.id}/complete`).send({}).expect(400, /empty_part/);
    await assemble(app, []).expect(400);
  });

  it('allows duplicate references, each holding a refcount', async () => {
    const a = await createPart(app, [Buffer.from('ab')]);
    const res = await assemble(app, [{kind: 'part', id: a.id}, {kind: 'part', id: a.id}]).expect(201);
    expect(res.body.totalSize).toBe(4);
    expect(res.body.entries.map((e: {partId: string}) => e.partId)).toEqual([a.id, a.id]);
    const listed = await request(app).get('/api/parts');
    expect(listed.body.find((p: {id: string}) => p.id === a.id).refCount).toBe(2);
    const content = await fetchContent(app, `/api/finals/${res.body.id}/content`);
    expect(content.text).toBe('abab');
  });

  it('rejects incomplete, missing and expired parts', async () => {
    const open = await request(app).post('/api/parts').send({}).expect(201);
    await assemble(app, [{kind: 'part', id: open.body.id}]).expect(409, /part_not_completed/);
    await assemble(app, [{kind: 'part', id: 'nope'}]).expect(404, /part_not_found/);

    const soon = await createPart(app, [Buffer.from('x')], 10);
    advance(20);
    const expired = await assemble(app, [{kind: 'part', id: soon.id}]).expect(410, /part_expired/);
    expect(expired.body.details.partId).toBe(soon.id);
  });

  it('pins referenced parts past expiry until the final is deleted', async () => {
    const a = await createPart(app, [Buffer.from('keep')], 10);
    const finalRes = await assemble(app, [{kind: 'part', id: a.id}]).expect(201);
    advance(20); // part is now expired, but referenced
    let cleanup = await request(app).post('/api/maintenance/cleanup').expect(200);
    expect(cleanup.body.reaped).not.toContain(a.id);
    // still readable through the final
    const kept = await fetchContent(app, `/api/finals/${finalRes.body.id}/content`);
    expect(kept.res.status).toBe(200);
    expect(kept.text).toBe('keep');

    await request(app).delete(`/api/finals/${finalRes.body.id}`).expect(200);
    cleanup = await request(app).post('/api/maintenance/cleanup').expect(200);
    expect(cleanup.body.reaped).toContain(a.id);
    await request(app).get(`/api/finals/${finalRes.body.id}`).expect(404);
  });

  it('reaps only unreferenced expired parts', async () => {
    const free = await createPart(app, [Buffer.from('free')], 10);
    const held = await createPart(app, [Buffer.from('held')], 10);
    const fresh = await createPart(app, [Buffer.from('fresh')], 10_000);
    const finalRes = await assemble(app, [{kind: 'part', id: held.id}]).expect(201);
    advance(50);
    const cleanup = await request(app).post('/api/maintenance/cleanup').expect(200);
    expect(cleanup.body.reaped).toEqual([free.id]);
    void finalRes;
    void fresh;
  });

  it('rolls back refcounts and publication when concat fails during assembly', async () => {
    const good = await createPart(app, [Buffer.from('good')]);
    const bad = await createPart(app, [Buffer.from('bad')]);
    await request(app).post(`/api/parts/${bad.id}/fault`).send({mode: 'assemble'}).expect(204);
    const res = await assemble(app, [{kind: 'part', id: good.id}, {kind: 'part', id: bad.id}]).expect(502, /concat_failed/);
    void res;
    // no final exists
    const finals = await request(app).get('/api/finals');
    expect(finals.body.find((f: {id: string}) => f.id === res.body?.id)).toBeUndefined();
    // refcounts untouched
    const parts = await request(app).get('/api/parts').expect(200);
    const counts = Object.fromEntries(parts.body.map((p: {id: string; refCount: number}) => [p.id, p.refCount]));
    expect(counts[good.id]).toBe(0);
    expect(counts[bad.id]).toBe(0);
  });

  it('serves ranges that start, end and cross part boundaries', async () => {
    const a = await createPart(app, [Buffer.from('aaaaa')]); // 0-4
    const b = await createPart(app, [Buffer.from('bbbb')]); // 5-8
    const c = await createPart(app, [Buffer.from('cc')]); // 9-10
    const finalRes = await assemble(app, [{kind: 'part', id: a.id}, {kind: 'part', id: b.id}, {kind: 'part', id: c.id}]).expect(201);
    const url = `/api/finals/${finalRes.body.id}/content`;

    const crossing = await fetchContent(app, url, 'bytes=3-7');
    expect(crossing.res.status).toBe(206);
    expect(crossing.res.headers['content-range']).toBe('bytes 3-7/11');
    expect(crossing.text).toBe('aabbb');

    const suffix = await fetchContent(app, url, 'bytes=-4');
    expect(suffix.res.status).toBe(206);
    expect(suffix.text).toBe('bbcc');

    const tail = await fetchContent(app, url, 'bytes=9-');
    expect(tail.text).toBe('cc');

    await request(app).get(url).set('Range', 'bytes=11-20').expect(416);
  });

  it('flattens nested finals and keeps leaves alive when the inner final is deleted', async () => {
    const a = await createPart(app, [Buffer.from('one-')]);
    const b = await createPart(app, [Buffer.from('two')]);
    const inner = await assemble(app, [{kind: 'part', id: a.id}]).expect(201);
    const outer = await assemble(app, [{kind: 'final', id: inner.body.id}, {kind: 'part', id: b.id}]).expect(201);
    // flattened manifest references the leaf part directly with provenance
    expect(outer.body.entries.map((e: {partId: string}) => e.partId)).toEqual([a.id, b.id]);
    expect(outer.body.entries[0].via).toContain(`final:${inner.body.id}`);

    const content = await fetchContent(app, `/api/finals/${outer.body.id}/content`);
    expect(content.text).toBe('one-two');

    // deleting the inner final must not break the outer one
    await request(app).delete(`/api/finals/${inner.body.id}`).expect(200);
    const still = await fetchContent(app, `/api/finals/${outer.body.id}/content`);
    expect(still.res.status).toBe(200);
    expect(still.text).toBe('one-two');
    // the shared leaf still has one reference (from the outer final)
    const parts = await request(app).get('/api/parts');
    expect(parts.body.find((p: {id: string}) => p.id === a.id).refCount).toBe(1);

    // referencing a missing nested final fails
    await assemble(app, [{kind: 'final', id: 'ghost'}]).expect(404, /final_not_found/);
  });

  it('reports read-time concat failures as 502', async () => {
    const good = await createPart(app, [Buffer.from('readable')]);
    const bad = await createPart(app, [Buffer.from('nope')]);
    await request(app).post(`/api/parts/${bad.id}/fault`).send({mode: 'read'}).expect(204);
    const finalRes = await assemble(app, [{kind: 'part', id: good.id}, {kind: 'part', id: bad.id}]).expect(201);
    // a range fully inside the healthy part still streams
    const healthy = await fetchContent(app, `/api/finals/${finalRes.body.id}/content`, 'bytes=0-7');
    expect(healthy.res.status).toBe(206);
    expect(healthy.text).toBe('readable');
    // a range landing on the faulty part surfaces the storage error
    const targeted = await request(app).get(`/api/finals/${finalRes.body.id}/content`).set('Range', 'bytes=8-11');
    expect(targeted.status).toBe(502);
    expect(targeted.body.error).toBe('concat_read_failed');
  });

  it('survives concurrent cleanup racing assembly: no successful final references a reaped part', async () => {
    // Parts already past their expiry: whether assembly sees 410 or cleanup
    // reaps them depends on which transaction takes the store lock first.
    const raced: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const p = await createPart(app, [Buffer.from(`p${i}`)], 10);
      raced.push(p.id);
    }
    const pinned = await createPart(app, [Buffer.from('pinned')], 100_000);
    advance(50);

    const sources = [...raced, pinned.id].map((id) => ({kind: 'part', id}));
    const outcomes = await Promise.all([
      assemble(app, sources).then((r) => ({kind: 'assemble' as const, status: r.status, body: r.body})),
      request(app).post('/api/maintenance/cleanup').then((r) => ({kind: 'cleanup' as const, status: r.status, body: r.body})),
      request(app).post('/api/maintenance/cleanup').then((r) => ({kind: 'cleanup' as const, status: r.status, body: r.body})),
    ]);

    const assembled = outcomes.filter((r) => r.kind === 'assemble' && r.status === 201);
    const reaped = new Set(
      outcomes.filter((r) => r.kind === 'cleanup').flatMap((r) => r.body.reaped as string[]),
    );

    for (const result of assembled) {
      // core invariant: a published final never points at a reclaimed object
      for (const entry of result.body.entries as Array<{partId: string}>) {
        expect(reaped.has(entry.partId)).toBe(false);
        const part = await request(app).get('/api/parts');
        const found = part.body.find((p: {id: string}) => p.id === entry.partId);
        expect(found, `part ${entry.partId} referenced by final ${result.body.id} was reaped`).toBeTruthy();
        expect(found.refCount).toBeGreaterThanOrEqual(1);
      }
      // the final's content is fully readable end to end
      const content = await fetchContent(app, `/api/finals/${result.body.id}/content`);
      expect(content.res.status).toBe(200);
      expect(content.text.endsWith('pinned')).toBe(true);
    }
    // If cleanup lost the race and assembly pinned the expired parts, a later
    // cleanup must still not touch them.
    if (assembled.length > 0) {
      const after = await request(app).post('/api/maintenance/cleanup').expect(200);
      for (const entry of assembled[0].body.entries as Array<{partId: string}>) {
        expect(after.body.reaped).not.toContain(entry.partId);
      }
    }
  });

  afterAll(() => {
    // nothing to close: the harness never binds a port
  });
});
