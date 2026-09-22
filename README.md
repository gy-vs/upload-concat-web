# Resumable Upload Studio

Workbench for assembling completed resumable-upload **parts** into **final**
uploads by manifest — zero bytes are copied when a final is published. Parts
are pinned for the lifetime of every final that references them.

Run `npm install`, then `npm run dev` (API on :4174, Vite on :4173).

## Model

- **Part** — a resumable upload. Chunks are appended while `open`; on
  completion the blob is frozen with a sha256 digest, size and a TTL measured
  from completion. Empty parts are rejected.
- **Final** — an ordered, frozen manifest of leaf parts: `{partId, offset,
  size, digest, source[]}` plus a manifest digest and total size. Byte ranges
  in the manifest never change after publication.
- **Reference count** — every manifest occurrence (duplicates included) holds
  one reference on its part. Counts are updated **in the same transaction** as
  manifest publication/deletion; a failed assembly rolls every increment and
  the unpublished manifest back.

## Guarantees

- Assembly atomically freezes ids, digests, lengths and order; all parts must
  be completed and non-expired. The final becomes visible only on commit.
- Cleanup reaps only parts that are **both expired and unreferenced**.
  Assembly and cleanup take the same store lock, so they interleave as whole
  transactions: **a successfully published final never references a reaped
  object**. Parts survive past expiry while pinned.
- Reads stream parts back-to-back from manifest boundaries with HTTP range
  support (`206`, `Content-Range`, suffix/open ranges; `416` when
  unsatisfiable). A storage fault during assembly fails publication; a fault
  while streaming surfaces as `502 concat_read_failed`.
- Nested concat uses **flatten-on-write**: referencing another final copies
  its leaf entries into the new manifest with provenance (`via`). Deleting an
  inner final never breaks an outer one.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/parts` | open a part (`{ttlMs?}`) |
| POST | `/api/parts/:id/chunks` | append an octet-stream chunk |
| POST | `/api/parts/:id/complete` | freeze blob/digest/size (rejects empty) |
| GET | `/api/parts` | list parts with expiry and ref counts |
| POST | `/api/parts/:id/fault` | test hook: arm `assemble`/`read` storage fault |
| POST | `/api/finals` | publish `{sources:[{kind:"part"|"final",id}]}` |
| GET | `/api/finals`, `/api/finals/:id` | list / frozen manifest with byte ranges |
| GET | `/api/finals/:id/content` | streamed concat, supports `Range` |
| DELETE | `/api/finals/:id` | remove manifest, release all leaf refs |
| POST | `/api/maintenance/cleanup` | reap expired, unreferenced parts |

Tests: `npm test` (11 cases covering empty parts, duplicate refs, expiry,
concurrent cleanup races, concat failure rollback, cross-boundary ranges,
final deletion and nested assembly).
