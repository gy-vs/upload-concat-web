import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
describe('service',()=>{it('loads and conditionally updates a record',async()=>{const app=createApp();const before=await request(app).get('/api/uploads/alpha').expect(200);await request(app).put('/api/uploads/alpha').send({content:'updated',revision:before.body.revision}).expect(200);await request(app).put('/api/uploads/alpha').send({content:'stale',revision:before.body.revision}).expect(409)})});
