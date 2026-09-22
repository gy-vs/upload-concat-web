import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ArrowDown,
  ArrowUp,
  Database,
  FilePlus2,
  FlaskConical,
  Play,
  ShieldCheck,
  Trash2,
  Trash,
  X,
} from 'lucide-react';

type PartStatus = 'pending' | 'complete' | 'reclaimed';

interface PartView {
  id: string;
  status: PartStatus;
  size: number;
  digest: string | null;
  createdAt: number;
  expiresAt: number | null;
  refCount: number;
  corrupted: boolean;
}

interface ManifestEntry {
  ordinal: number;
  partId: string;
  offset: number;
  length: number;
  digest: string;
}

interface FinalView {
  id: string;
  size: number;
  digest: string;
  createdAt: number;
  entries: ManifestEntry[];
}

interface SourceRef {
  kind: 'part' | 'final';
  id: string;
}

const short = (digest: string | null) => (digest ? digest.slice(0, 10) : '—');

/** One expanded leaf in the ordered composition preview. */
interface PlannedSegment {
  ordinal: number;
  partId: string;
  offset: number;
  length: number;
  duplicate: boolean;
  via?: string;
}

function StatusPill({status}: {status: PartStatus}) {
  return <span className={`pill status-${status}`}>{status}</span>;
}

/** Visual composed byte range: one weighted segment per manifest entry. */
function CompositionBar({entries, size}: {entries: ManifestEntry[]; size: number}) {
  if (entries.length === 0) return <div className="empty-hint">no entries</div>;
  return (
    <div className="range-track" title={`total ${size} bytes`}>
      {entries.map(entry => {
        const width = size === 0 ? 0 : Math.max(2, (entry.length / size) * 100);
        const hue =
          entry.partId.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;
        return (
          <div
            key={entry.ordinal}
            className={`range-seg${entry.length === 0 ? ' zero' : ''}`}
            style={
              entry.length === 0
                ? undefined
                : {width: `${width}%`, background: `hsl(${hue} 55% 72%)`}
            }
            title={`#${entry.ordinal} ${entry.partId} · bytes ${entry.offset}-${
              entry.offset + entry.length - 1
            } · ${entry.length}B`}
          >
            {entry.length === 0 ? '∅' : entry.partId.replace(/^p_/, '').slice(0, 6)}
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [parts, setParts] = useState<PartView[]>([]);
  const [finals, setFinals] = useState<FinalView[]>([]);
  const [status, setStatus] = useState('Ready');

  // part editor
  const [newPartId, setNewPartId] = useState('');
  const [partData, setPartData] = useState('');
  const [ttlMs, setTtlMs] = useState(3_600_000);

  // composition
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [pickKind, setPickKind] = useState<'part' | 'final'>('part');
  const [pickId, setPickId] = useState('');
  const [finalId, setFinalId] = useState('');

  // reader
  const [readFinal, setReadFinal] = useState('');
  const [rangeHeader, setRangeHeader] = useState('');
  const [readResult, setReadResult] = useState<null | {
    status: number;
    contentRange?: string;
    body: string;
  }>(null);

  const refresh = useCallback(async () => {
    const [p, f] = await Promise.all([
      fetch('/api/parts').then(r => r.json()),
      fetch('/api/finals').then(r => r.json()),
    ]);
    setParts(p as PartView[]);
    setFinals(f as FinalView[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const completeParts = useMemo(
    () => parts.filter(p => p.status === 'complete'),
    [parts],
  );

  // Live composition preview for the ordered source list.
  const preview = useMemo(() => {
    const idSize = new Map(parts.map(p => [p.id, p.size]));
    const idCount = new Map<string, number>();
    for (const source of sources) {
      if (source.kind === 'part') {
        idCount.set(source.id, (idCount.get(source.id) ?? 0) + 1);
      } else {
        const nested = finals.find(f => f.id === source.id);
        for (const id of new Set(nested?.entries.map(e => e.partId) ?? [])) {
          idCount.set(id, (idCount.get(id) ?? 0) + 1);
        }
      }
    }
    const segs: PlannedSegment[] = [];
    let offset = 0;
    const addLeaf = (partId: string, length: number, via?: string) => {
      segs.push({
        ordinal: segs.length,
        partId,
        offset,
        length,
        duplicate: (idCount.get(partId) ?? 0) > 1,
        ...(via ? {via} : {}),
      });
      offset += length;
    };
    for (const source of sources) {
      if (source.kind === 'part') {
        addLeaf(source.id, idSize.get(source.id) ?? 0);
      } else {
        const nested = finals.find(f => f.id === source.id);
        for (const entry of nested?.entries ?? []) addLeaf(entry.partId, entry.length, source.id);
      }
    }
    return {segs, total: offset};
  }, [sources, parts, finals]);

  async function createAndComplete() {
    setStatus('Uploading part');
    const id = newPartId.trim() || undefined;
    const created = await fetch('/api/parts', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(id ? {id} : {}),
    }).then(r => r.json());
    await fetch(`/api/parts/${created.id}/data`, {
      method: 'PUT',
      headers: {'content-type': 'application/octet-stream'},
      body: partData,
    });
    const res = await fetch(`/api/parts/${created.id}/complete`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ttlMs: Number(ttlMs) || 3_600_000}),
    });
    if (!res.ok) {
      setStatus(`Part failed: ${(await res.json()).error}`);
    } else {
      setStatus(`Part ${created.id} complete`);
      setNewPartId('');
      setPartData('');
    }
    void refresh();
  }

  async function completeExisting(id: string) {
    await fetch(`/api/parts/${id}/complete`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ttlMs: Number(ttlMs) || 3_600_000}),
    });
    void refresh();
  }

  async function toggleCorrupt(id: string) {
    await fetch(`/api/parts/${id}/corrupt`, {method: 'POST'}).catch(() => undefined);
    void refresh();
  }

  async function sweep() {
    setStatus('Sweeping expired, unreferenced objects');
    const result = await fetch('/api/gc', {method: 'POST'}).then(r => r.json());
    setStatus(`Reclaimed ${result.reclaimed.length} object(s); pinned objects untouched`);
    void refresh();
  }

  function addSource() {
    if (!pickId) return;
    setSources(list => [...list, {kind: pickKind, id: pickId}]);
    setPickId('');
  }

  async function publish() {
    setStatus('Publishing final');
    const res = await fetch('/api/finals', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        sources,
        ...(finalId.trim() ? {id: finalId.trim()} : {}),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(`Publish rejected: ${body.error}${body.message ? ` — ${body.message}` : ''}`);
      void refresh();
      return;
    }
    setStatus(`Final ${body.id} published · ${body.size} bytes · refs frozen`);
    setSources([]);
    setFinalId('');
    setReadFinal(body.id);
    void refresh();
  }

  async function removeFinal(id: string) {
    await fetch(`/api/finals/${id}`, {method: 'DELETE'});
    if (readFinal === id) setReadFinal('');
    setStatus(`Final ${id} deleted; pins released`);
    void refresh();
  }

  async function readContent() {
    if (!readFinal) return;
    const headers: Record<string, string> = {};
    if (rangeHeader.trim()) headers.Range = rangeHeader.trim();
    const res = await fetch(`/api/finals/${readFinal}/content`, {headers});
    const text = await res.text();
    setReadResult({
      status: res.status,
      contentRange: res.headers.get('content-range') ?? undefined,
      body: text,
    });
    setStatus(`Read ${res.status}${res.headers.get('content-range') ? ` · ${res.headers.get('content-range')}` : ''}`);
  }

  const move = (index: number, delta: number) => {
    setSources(list => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Resumable Upload Studio</strong>
        <small>zero-copy concatenation workbench</small>
        <span className="topbar-status">{status}</span>
      </header>

      <section className="workspace">
        {/* parts */}
        <aside className="pane">
          <h2>Parts</h2>
          <div className="form">
            <input
              placeholder="part id (optional)"
              value={newPartId}
              onChange={e => setNewPartId(e.target.value)}
            />
            <textarea
              aria-label="part bytes"
              placeholder="part bytes (text)"
              value={partData}
              onChange={e => setPartData(e.target.value)}
            />
            <label className="row">
              TTL ms
              <input
                type="number"
                value={ttlMs}
                onChange={e => setTtlMs(Number(e.target.value))}
              />
            </label>
            <button className="primary" onClick={createAndComplete}>
              <FilePlus2 size={15} /> create + complete
            </button>
            <button onClick={sweep}>
              <Trash size={15} /> GC sweep (expired &amp; unreferenced)
            </button>
          </div>

          <div className="list">
            {parts.map(part => (
              <div className="card" key={part.id}>
                <div className="card-head">
                  <code>{part.id}</code>
                  <StatusPill status={part.status} />
                </div>
                <div className="meta">
                  <span>{part.size}B</span>
                  <span title={part.digest ?? ''}>sha {short(part.digest)}</span>
                  <span className={part.refCount > 0 ? 'pinned' : ''}>
                    <ShieldCheck size={12} /> refs {part.refCount}
                  </span>
                  {part.corrupted && <span className="warn">bit-rot</span>}
                </div>
                <div className="meta">
                  <span>
                    {part.expiresAt
                      ? `expires ${new Date(part.expiresAt).toLocaleTimeString()}`
                      : 'no expiry'}
                  </span>
                </div>
                <div className="card-actions">
                  {part.status === 'pending' && (
                    <button onClick={() => completeExisting(part.id)}>complete</button>
                  )}
                  {part.status === 'complete' && part.refCount === 0 && part.size > 0 && (
                    <button
                      className="ghost"
                      onClick={() => toggleCorrupt(part.id)}
                      title="flip one byte to simulate storage rot"
                    >
                      corrupt
                    </button>
                  )}
                  {part.refCount > 0 && (
                    <span className="lock-note">pinned · immutable</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* composition */}
        <section className="pane">
          <h2>Compose final</h2>
          <p className="hint">
            Sources are frozen in order: part id, digest, length and offsets. Refs are
            taken in the same transaction as publication and rolled back on any failure.
          </p>

          <div className="composer">
            <select value={pickKind} onChange={e => {setPickKind(e.target.value as 'part' | 'final');setPickId('');}}>
              <option value="part">part</option>
              <option value="final">final (nested)</option>
            </select>
            <select value={pickId} onChange={e => setPickId(e.target.value)}>
              <option value="">choose…</option>
              {(pickKind === 'part' ? completeParts : finals).map(item => (
                <option key={item.id} value={item.id}>
                  {item.id} · {item.size}B
                </option>
              ))}
            </select>
            <button onClick={addSource} disabled={!pickId}>
              add
            </button>
            <input
              placeholder="final id (optional)"
              value={finalId}
              onChange={e => setFinalId(e.target.value)}
            />
            <button className="primary" onClick={publish} disabled={sources.length === 0}>
              <Database size={15} /> publish final
            </button>
          </div>

          <h3>Ordered sources · composed range {preview.total} bytes</h3>
          <div className="sources">
            {preview.segs.map(seg => (
              <div className="source-row" key={`${seg.ordinal}-${seg.partId}-${seg.via ?? ''}`}>
                <span className="ordinal">#{seg.ordinal}</span>
                <code>{seg.partId}</code>
                <span className="byte-range">
                  bytes {seg.offset}–{seg.offset + seg.length - 1}
                  {seg.length === 0 ? ' (empty)' : ` · ${seg.length}B`}
                </span>
                {seg.duplicate && <span className="badge dup">duplicate ref</span>}
                {seg.via && <span className="badge via">via {seg.via}</span>}
              </div>
            ))}
            {sources.length === 0 && <div className="empty-hint">add parts or finals above</div>}
          </div>

          <div className="raw-sources">
            {sources.map((source, index) => (
              <div className="source-row raw" key={`${source.kind}-${source.id}-${index}`}>
                <span className="ordinal">{index + 1}.</span>
                <span className={`kind-tag ${source.kind}`}>{source.kind}</span>
                <code>{source.id}</code>
                <span className="spacer" />
                <button onClick={() => move(index, -1)} disabled={index === 0}>
                  <ArrowUp size={13} />
                </button>
                <button onClick={() => move(index, 1)} disabled={index === sources.length - 1}>
                  <ArrowDown size={13} />
                </button>
                <button
                  className="ghost"
                  onClick={() => setSources(list => list.filter((_, i) => i !== index))}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>

          <h3>Published finals</h3>
          <div className="list">
            {finals.map(final => (
              <div
                className={`card final-card${readFinal === final.id ? ' selected' : ''}`}
                key={final.id}
                onClick={() => setReadFinal(final.id)}
              >
                <div className="card-head">
                  <code>{final.id}</code>
                  <span className="pill">{final.size}B</span>
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    onClick={e => {
                      e.stopPropagation();
                      void removeFinal(final.id);
                    }}
                    title="delete final (releases pins)"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <CompositionBar entries={final.entries} size={final.size} />
                <div className="entries">
                  {final.entries.map(entry => (
                    <span className="entry" key={entry.ordinal}>
                      #{entry.ordinal} <code>{entry.partId}</code>{' '}
                      <em>
                        [{entry.offset}, {entry.offset + entry.length})
                      </em>
                      {entry.length === 0 && <strong> ∅</strong>}
                    </span>
                  ))}
                </div>
                <div className="meta">
                  <span title={final.digest}>sha {short(final.digest)}</span>
                </div>
              </div>
            ))}
            {finals.length === 0 && <div className="empty-hint">no finals yet</div>}
          </div>
        </section>

        {/* reader */}
        <aside className="pane">
          <h2>Range reader</h2>
          <div className="form">
            <select value={readFinal} onChange={e => setReadFinal(e.target.value)}>
              <option value="">choose final…</option>
              {finals.map(f => (
                <option key={f.id} value={f.id}>
                  {f.id} · {f.size}B
                </option>
              ))}
            </select>
            <input
              placeholder="Range: bytes=0-99 (blank = all)"
              value={rangeHeader}
              onChange={e => setRangeHeader(e.target.value)}
            />
            <button className="primary" onClick={readContent} disabled={!readFinal}>
              <Play size={15} /> stream
            </button>
          </div>

          {readResult && (
            <div className="readout">
              <div className="meta">
                <span className={`pill http-${Math.floor(readResult.status / 100)}`}>
                  HTTP {readResult.status}
                </span>
                {readResult.contentRange && <code>{readResult.contentRange}</code>}
              </div>
              <pre>{readResult.body || '(empty body)'}</pre>
            </div>
          )}

          {readFinal &&
            (() => {
              const chosen = finals.find(f => f.id === readFinal);
              if (!chosen) return null;
              return (
                <div className="manifest">
                  <h3>Frozen manifest</h3>
                  <CompositionBar entries={chosen.entries} size={chosen.size} />
                  <pre>{JSON.stringify(chosen.entries, null, 2)}</pre>
                </div>
              );
            })()}
        </aside>
      </section>
    </main>
  );
}
