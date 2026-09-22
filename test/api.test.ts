import http from 'node:http';
import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {UploadStore} from '../src/server/store';

const buffer = (res: request.Response) => Buffer.from(res.body);

async function setup() {
  let t = 1_000_000;
  const store = new UploadStore();
  store.setClock(() => t);
  const app = createApp(store);
  const mkPart = async (id: string, body: Buffer | string, ttl = 10_000) => {
    await request(app).post('/api/parts').send({id}).expect(201);
    await request(app)
      .put(`/api/parts/${id}/data`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.isBuffer(body) ? body : Buffer.from(body))
      .expect(200);
    await request(app).post(`/api/parts/${id}/complete`).send({ttlMs: ttl}).expect(200);
  };
  const mkEmpty = async (id: string, ttl = 10_000) => {
    await request(app).post('/api/parts').send({id}).expect(201);
    await request(app).post(`/api/parts/${id}/complete`).send({ttlMs: ttl}).expect(200);
  };
  const advance = (ms: number) => {
    t += ms;
  };
  return {app, store, mkPart, mkEmpty, advance};
}

describe('part lifecycle', () => {
  it('creates, uploads and completes a part (including an empty one)', async () => {
    const {app, mkPart, mkEmpty} = await setup();
    await mkPart('a', 'hello');
    await mkEmpty('e');
    const parts = (await request(app).get('/api/parts').expect(200)).body;
    const a = parts.find((p: {id: string}) => p.id === 'a');
    expect(a.size).toBe(5);
    expect(a.status).toBe('complete');
    expect(a.expiresAt).toBeGreaterThan(0);
    const e = parts.find((p: {id: string}) => p.id === 'e');
    expect(e.size).toBe(0);
    expect(e.status).toBe('complete');

    // Cannot re-upload a sealed part.
    await request(app)
      .put('/api/parts/a/data')
      .send(Buffer.from('xxxx'))
      .expect(409);
    const sealed = await request(app)
      .put('/api/parts/a/data')
      .send(Buffer.from('xxxx'));
    expect(sealed.body.error).toBe('part_not_empty');
  });
});

describe('final publication', () => {
  it('publishes the frozen manifest with offsets and composite digest', async () => {
    const {app, mkPart, mkEmpty} = await setup();
    await mkPart('a', 'hello, ');
    await mkEmpty('e');
    await mkPart('b', 'world!');
    const res = await request(app)
      .post('/api/finals')
      .send({
        id: 'f1',
        sources: [
          {kind: 'part', id: 'a'},
          {kind: 'part', id: 'e'},
          {kind: 'part', id: 'b'},
        ],
      })
      .expect(201);
    expect(res.body.size).toBe(13);
    expect(res.body.entries).toMatchObject([
      {ordinal: 0, partId: 'a', offset: 0, length: 7},
      {ordinal: 1, partId: 'e', offset: 7, length: 0},
      {ordinal: 2, partId: 'b', offset: 7, length: 6},
    ]);
    // Parts are now pinned.
    const parts = (await request(app).get('/api/parts').expect(200)).body;
    for (const id of ['a', 'e', 'b']) {
      expect(parts.find((p: {id: string}) => p.id === id).refCount).toBe(1);
    }
  });

  it('maps validation failures to status codes', async () => {
    const {app, mkPart} = await setup();
    await mkPart('a', 'x', 100);
    await request(app).post('/api/finals').send({sources: []}).expect(400);
    await request(app)
      .post('/api/finals')
      .send({sources: [{kind: 'part', id: 'nope'}]})
      .expect(404);
    expect((await request(app)
      .post('/api/finals')
      .send({sources: [{kind: 'part', id: 'nope'}]})).body.error).toBe('part_not_found');
  });

  it('rejects bit-rot objects at commit with no refcount left behind', async () => {
    const {app, mkPart} = await setup();
    await mkPart('a', 'abc');
    await mkPart('b', 'xyz');
    await request(app).post('/api/parts/b/corrupt').expect(200);
    await request(app)
      .post('/api/finals')
      .send({
        sources: [
          {kind: 'part', id: 'a'},
          {kind: 'part', id: 'b'},
        ],
      })
      .expect(409);
    expect((await request(app)
      .post('/api/finals')
      .send({
        sources: [
          {kind: 'part', id: 'a'},
          {kind: 'part', id: 'b'},
        ],
      })).body.error).toBe('digest_mismatch');
    const parts = (await request(app).get('/api/parts').expect(200)).body;
    expect(parts.every((p: {refCount: number}) => p.refCount === 0)).toBe(true);
  });
});

describe('streaming reads and ranges', () => {
  async function seeded() {
    const s = await setup();
    await s.mkPart('a', '<AA>'); // 0-3
    await s.mkEmpty('e'); // 4-3 zero-length at offset 4
    await s.mkPart('b', '<BBBB>'); // offset 4, bytes 4-9
    await s.mkPart('c', '<C>'); // offset 10, bytes 10-12
    await request(s.app)
      .post('/api/finals')
      .send({
        id: 'f1',
        sources: [
          {kind: 'part', id: 'a'},
          {kind: 'part', id: 'e'},
          {kind: 'part', id: 'b'},
          {kind: 'part', id: 'c'},
        ],
      })
      .expect(201);
    return s;
  }

  it('streams the full concatenation without copying', async () => {
    const {app} = await seeded();
    const res = await request(app).get('/api/finals/f1/content').expect(200);
    expect(buffer(res).toString()).toBe('<AA><BBBB><C>');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['etag']).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.header['content-range']).toBeUndefined();
  });

  it.each([
    ['bytes=0-3', '<AA>'], // exactly one part
    ['bytes=3-5', '><B'], // crosses a -> b (empty part sits between, no bytes)
    ['bytes=3-3', '>'], // boundary byte
    ['bytes=4-9', '<BBBB>'], // whole middle part
    ['bytes=8-12', 'B><C>'], // crosses b -> c
    ['bytes=0-12', '<AA><BBBB><C>'], // whole object
    ['bytes=10-', '<C>'], // open-ended
    ['bytes=-3', '<C>'], // suffix range
    ['bytes=999-', null], // unsatisfiable
  ])('serves range %s', async (range, expected) => {
    const {app} = await seeded();
    const res = await request(app)
      .get('/api/finals/f1/content')
      .set('Range', range);
    if (expected === null) {
      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe('bytes */13');
      return;
    }
    expect(res.status).toBe(206);
    expect(buffer(res).toString()).toBe(expected);
  });

  it('ignores malformed range headers and returns 200', async () => {
    const {app} = await seeded();
    const res = await request(app)
      .get('/api/finals/f1/content')
      .set('Range', 'items=0-2');
    expect(res.status).toBe(200);
    expect(buffer(res).toString()).toBe('<AA><BBBB><C>');
  });

  it('serves empty finals as zero-length content', async () => {
    const s = await setup();
    await s.mkEmpty('e', 10_000);
    await request(s.app)
      .post('/api/finals')
      .send({id: 'fe', sources: [{kind: 'part', id: 'e'}]})
      .expect(201);
    const res = await request(s.app).get('/api/finals/fe/content').expect(200);
    expect(buffer(res).length).toBe(0);
    expect(res.headers['content-length']).toBe('0');
    await request(s.app)
      .get('/api/finals/fe/content')
      .set('Range', 'bytes=0-')
      .expect(416);
  });

  it('surfaces a mid-stream concatenation failure', async () => {
    const {app, store} = await seeded();
    await request(app)
      .post('/api/chaos/read-fault')
      .send({partId: 'b'})
      .expect(200);

    const server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no ephemeral port'));
        return;
      }
      const req = http.get(
        {port: address.port, path: '/api/finals/f1/content'},
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('error', () => resolve()); // aborted body: expected
          res.on('end', () => {
            // The server must not deliver the complete object after a read fault.
            const received = Buffer.concat(chunks).toString();
            expect(received.endsWith('<C>')).toBe(false);
            resolve();
          });
        },
      );
      req.on('error', () => resolve()); // socket reset: equally acceptable
    }).finally(() => server.close());
    store.readFaultPartId = null;
  });
});

describe('final deletion and reclamation', () => {
  it('deletes a final, releases refs, then GC reclaims expired objects', async () => {
    const s = await setup();
    await s.mkPart('a', 'aaaa', 100);
    await s.mkPart('b', 'bbbb', 100_000);
    await request(s.app)
      .post('/api/finals')
      .send({
        id: 'f1',
        sources: [
          {kind: 'part', id: 'a'},
          {kind: 'part', id: 'b'},
        ],
      })
      .expect(201);

    s.advance(200);
    // Pinned: both survive despite a being past its expiry.
    let gc = await request(s.app).post('/api/gc').expect(200);
    expect(gc.body.reclaimed).toEqual([]);

    await request(s.app).delete('/api/finals/f1').expect(200);
    await request(s.app).get('/api/finals/f1/content').expect(404);

    gc = await request(s.app).post('/api/gc').expect(200);
    expect(gc.body.reclaimed.map((p: {id: string}) => p.id)).toEqual(['a']);
    const parts = (await request(s.app).get('/api/parts').expect(200)).body;
    const a = parts.find((p: {id: string}) => p.id === 'a');
    expect(a.status).toBe('reclaimed');
    expect(a.digest).toBeNull();
  });

  it('nests a published final and keeps composition immutable', async () => {
    const s = await setup();
    await s.mkPart('a', 'foo');
    await s.mkPart('b', 'bar');
    await request(s.app)
      .post('/api/finals')
      .send({id: 'f1', sources: [{kind: 'part', id: 'a'}]})
      .expect(201);
    const nested = await request(s.app)
      .post('/api/finals')
      .send({
        id: 'f2',
        sources: [
          {kind: 'final', id: 'f1'},
          {kind: 'part', id: 'b'},
        ],
      })
      .expect(201);
    expect(nested.body.entries.map((e: {partId: string}) => e.partId)).toEqual([
      'a',
      'b',
    ]);
    const res = await request(s.app).get('/api/finals/f2/content').expect(200);
    expect(buffer(res).toString()).toBe('foobar');
    // Range landing only on the nested final's leaf.
    const r = await request(s.app)
      .get('/api/finals/f2/content')
      .set('Range', 'bytes=1-2')
      .expect(206);
    expect(buffer(r).toString()).toBe('oo');
  });
});
