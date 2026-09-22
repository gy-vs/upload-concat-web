# Resumable Upload Studio

Zero-copy concatenation workbench for resumable uploads: stitch several completed
**partial uploads** (and other published finals) into an immutable **final upload**
without re-copying large objects.

Run `npm install`, then `npm run dev` (API on :4174, UI on :4173).

## Model

- **Part** — `pending → complete → reclaimed`。完成时冻结 sha256 摘要、字节长度与
  TTL（未被引用时的回收期限）。空部分是一等公民。
- **Final** — 发布时冻结的不可变清单：每条目含 `ordinal` / `partId` / 字节 `offset`
  / `length` / `digest`，外加整体 sha256。全过程不复制对象字节。
- **refCount** — 每个引用该对象的存活 final 计一次（同一清单内重复引用同一部分只计
  一次；嵌套 final 各自持有独立钉住）。

## Guarantees

- 发布是单事务：校验每个源（已完成、对象存在；直接引用必须未过期；摘要匹配）→
  临时增加引用计数 → 冻结清单并原子发布。任何失败都回滚引用计数，且不会有 final
  可见。
- GC 只回收「**已过期且无引用**」的对象。被钉住的对象无论多旧都存活；因此任何成功
  发布的 final 永远引用着存活、未回收的对象。
- 读取在存储锁内快照零拷贝的 `Buffer.subarray` 视图，随后按部分边界流式输出，支持
  RFC 7233 单段 range（`bytes=a-b`、`a-`、`-N`；非法头忽略返回 200，越界返回 416）。
- 删除 final 与释放其引用计数同事务完成。
- 嵌套：final 可引用已发布的 final，清单在发布时即时展开为叶子。被内层 final 钉住
  的叶子即便自身 TTL 已过，仍可经内层 final 使用；只有所有引用它的 final 都被删除
  后，才可被回收。

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/parts` | create pending part |
| PUT | `/api/parts/:id/data` | stage bytes (raw body) |
| POST | `/api/parts/:id/complete` | freeze digest/length/TTL |
| POST | `/api/finals` | publish `{sources:[{kind:'part'|'final',id}], id?}` |
| GET | `/api/finals/:id/content` | stream concatenation (supports `Range`) |
| DELETE | `/api/finals/:id` | delete final, release pins |
| POST | `/api/gc` | reclaim expired unreferenced objects |
| POST | `/api/parts/:id/corrupt`, `/api/chaos/read-fault` | fault injection |

## Tests

`npm test` — 31 个用例覆盖：空部分、重复引用、部分过期、并发提交 vs 清理的不变量、
发布失败回滚、摘要不匹配（bit-rot）、跨边界 range、流式中途失败、final 删除后回收，
以及嵌套拼接展开。
