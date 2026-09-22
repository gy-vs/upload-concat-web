import {useCallback, useEffect, useState} from 'react';
import {
  AlertTriangle,
  Box,
  Copy,
  Eraser,
  FileStack,
  Play,
  Plus,
  Trash2,
  UploadCloud,
} from 'lucide-react';

type Part = {
  id: string;
  status: 'open' | 'completed';
  size: number;
  digest: string | null;
  completedAt: string | null;
  ttlMs: number;
  expiresAt: string | null;
  expired: boolean;
  refCount: number;
};

type Entry = {
  index: number;
  partId: string;
  start: number;
  end: number;
  size: number;
  digest: string;
  via: string[];
};

type Final = {
  id: string;
  createdAt: string;
  totalSize: number;
  digest: string;
  entries: Entry[];
  entryCount?: number;
};

type Notice = {kind: 'ok' | 'error'; text: string};

function short(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function App() {
  const [parts, setParts] = useState<Part[]>([]);
  const [finals, setFinals] = useState<Final[]>([]);
  const [selectedFinal, setSelectedFinal] = useState<Final | null>(null);
  const [picked, setPicked] = useState<Array<{kind: 'part' | 'final'; id: string}>>([]);
  const [chunkText, setChunkText] = useState('');
  const [ttlMs, setTtlMs] = useState('30000');
  const [content, setContent] = useState<{range?: string; status: number; body: string; header?: string} | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (selectId?: string) => {
    const [partsRes, finalsRes] = await Promise.all([
      fetch('/api/parts').then((r) => r.json() as Promise<Part[]>),
      fetch('/api/finals').then((r) => r.json() as Promise<Array<Omit<Final, 'entries'>>>),
    ]);
    setParts(partsRes);
    setFinals(finalsRes as Final[]);
    if (selectId) {
      const detail = await fetch(`/api/finals/${selectId}`).then((r) => (r.ok ? (r.json() as Promise<Final>) : null));
      setSelectedFinal(detail);
    } else if (selectedFinal) {
      const still = finalsRes.find((f) => f.id === selectedFinal?.id);
      if (!still) setSelectedFinal(null);
      else {
        const detail = await fetch(`/api/finals/${still.id}`).then((r) => (r.ok ? (r.json() as Promise<Final>) : null));
        setSelectedFinal(detail);
      }
    }
  }, [selectedFinal]);

  useEffect(() => {
    refresh().catch(() => setNotice({kind: 'error', text: 'Failed to load workbench state'}));
    const timer = setInterval(() => refresh().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function call(action: () => Promise<Response>, ok: string, selectId?: string) {
    setBusy(true);
    try {
      const res = await action();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {error?: string; details?: unknown};
        setNotice({kind: 'error', text: `${res.status} ${body.error ?? 'request failed'} ${body.details ? JSON.stringify(body.details) : ''}`});
        return null;
      }
      setNotice({kind: 'ok', text: ok});
      await refresh(selectId);
      return res;
    } finally {
      setBusy(false);
    }
  }

  async function uploadPart() {
    const ttl = Number(ttlMs);
    const created = await call(
      () => fetch('/api/parts', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ttlMs: ttl})}),
      'Part created',
    );
    if (!created) return;
    const part = (await created.json()) as Part;
    if (chunkText.length > 0) {
      await call(
        () => fetch(`/api/parts/${part.id}/chunks`, {method: 'POST', body: new Blob([chunkText], {type: 'application/octet-stream'})}),
        'Chunk appended',
      );
    }
    const completed = await call(
      () => fetch(`/api/parts/${part.id}/complete`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}),
      `Part ${short(part.id)} completed`,
    );
    if (completed) setChunkText('');
  }

  function pick(kind: 'part' | 'final', id: string) {
    setPicked((prev) => [...prev, {kind, id}]);
  }

  async function assemble() {
    if (picked.length === 0) {
      setNotice({kind: 'error', text: 'Pick at least one part or nested final'});
      return;
    }
    const res = await call(
      () => fetch('/api/finals', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sources: picked})}),
      'Final published — no bytes were copied',
    );
    if (res) {
      const record = (await res.json()) as Final;
      setPicked([]);
      setSelectedFinal(record);
    }
  }

  async function runCleanup() {
    await call(
      () => fetch('/api/maintenance/cleanup', {method: 'POST'}),
      'Cleanup finished',
    );
  }

  async function readRange(finalId: string, range: string | undefined) {
    const headers = new Headers();
    if (range) headers.set('Range', range);
    const res = await fetch(`/api/finals/${finalId}/content`, {headers});
    const text = await res.text();
    setContent({
      range,
      status: res.status,
      body: text,
      header: res.headers.get('content-range') ?? undefined,
    });
  }

  async function armFault(partId: string, mode: 'assemble' | 'read') {
    await call(
      () => fetch(`/api/parts/${partId}/fault`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({mode})}),
      `${mode} fault armed on ${short(partId)}`,
    );
  }

  const selectedDetail = selectedFinal;

  return (
    <main className="shell">
      <header className="topbar">
        <FileStack size={20} />
        <strong>Resumable Upload Studio</strong>
        <small>Part-concat workbench · manifests pin parts by reference count</small>
        <button className="ghost" onClick={runCleanup} disabled={busy}>
          <Eraser size={14} /> Run cleanup
        </button>
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`}>
          {notice.kind === 'error' ? <AlertTriangle size={14} /> : <Play size={14} />}
          <span>{notice.text}</span>
        </div>
      )}

      <section className="grid">
        <div className="pane">
          <h2><Box size={15} /> Parts</h2>
          <div className="compose">
            <textarea
              aria-label="Part bytes"
              placeholder="part bytes (utf-8)…"
              value={chunkText}
              onChange={(e) => setChunkText(e.target.value)}
            />
            <div className="row">
              <label>
                TTL ms
                <input type="number" value={ttlMs} onChange={(e) => setTtlMs(e.target.value)} />
              </label>
              <button className="primary" onClick={uploadPart} disabled={busy}>
                <UploadCloud size={14} /> Complete part
              </button>
            </div>
          </div>
          <div className="list">
            {parts.length === 0 && <p className="muted">No parts yet.</p>}
            {parts.map((part) => (
              <div key={part.id} className={`card ${part.expired ? 'expired' : ''}`}>
                <div className="card-head">
                  <code>{short(part.id)}</code>
              {part.status === 'open' ? (
                    <span className="tag open">open</span>
                  ) : part.expired ? (
                    <span className="tag expired">expired</span>
                  ) : (
                    <span className="tag ready">completed</span>
                  )}
                </div>
                <div className="meta">
                  <span>{formatBytes(part.size)}</span>
                  <span>refs: {part.refCount}</span>
                  {part.expiresAt && <span title={part.expiresAt}>ttl {part.ttlMs}ms</span>}
                </div>
                {part.digest && <code className="digest" title={part.digest}>sha256:{part.digest.slice(0, 16)}…</code>}
                <div className="row wrap">
                  <button onClick={() => pick('part', part.id)} disabled={part.status !== 'completed' || part.expired}>
                    <Plus size={13} /> Add
                  </button>
                  <button className="ghost" onClick={() => armFault(part.id, 'read')}>read fault</button>
                  <button className="ghost" onClick={() => armFault(part.id, 'assemble')}>assemble fault</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pane">
          <h2><Copy size={15} /> Assembly order</h2>
          <ol className="order">
            {picked.map((item, i) => (
              <li key={`${item.kind}-${item.id}-${i}`}>
                <span className="index">{i + 1}</span>
                <span className={`chip ${item.kind}`}>{item.kind}</span>
                <code>{short(item.id)}</code>
                <button
                  className="ghost small"
                  onClick={() => setPicked((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
            {picked.length === 0 && <p className="muted">Add parts or a nested final. Duplicates are allowed.</p>}
          </ol>
          <button className="primary wide" onClick={assemble} disabled={busy || picked.length === 0}>
            Publish final (atomic)
          </button>

          <h2 className="spaced"><FileStack size={15} /> Finals</h2>
          <div className="list">
            {finals.length === 0 && <p className="muted">No finals published.</p>}
            {finals.map((final) => (
              <div key={final.id} className={`card ${selectedDetail?.id === final.id ? 'active' : ''}`}>
                <button className="select" onClick={() => setSelectedFinal(final as Final)}>
                  <code>{short(final.id)}</code>
                  <span className="meta">{formatBytes(final.totalSize)} · {(final as Final).entries?.length ?? final.entryCount ?? 0} parts</span>
                </button>
                <div className="row">
                  <button onClick={() => pick('final', final.id)}>
                    <Plus size={13} /> Nest
                  </button>
                  <button
                    className="danger"
                    onClick={() =>
                      call(
                        () => fetch(`/api/finals/${final.id}`, {method: 'DELETE'}),
                        `Final ${short(final.id)} deleted; refs released`,
                      )
                    }
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pane">
          <h2>Composed ranges</h2>
          {!selectedDetail && <p className="muted">Select a final to inspect its frozen manifest.</p>}
          {selectedDetail && (
            <>
              <div className="summary">
                <code title={selectedDetail.id}>{selectedDetail.id}</code>
                <span>{formatBytes(selectedDetail.totalSize)} · {selectedDetail.entries.length} leaf references</span>
                <code className="digest" title={selectedDetail.digest}>manifest sha256:{selectedDetail.digest.slice(0, 16)}…</code>
              </div>
              <div className="boundaries">
                <div className="boundary head">
                  <span>#</span><span>part</span><span>byte range</span><span>via</span>
                </div>
                {selectedDetail.entries.map((entry) => (
                  <div key={`${entry.partId}-${entry.index}`} className="boundary">
                    <span>{entry.index + 1}</span>
                    <code title={entry.digest}>{short(entry.partId)}</code>
                    <span className="range-pill">{entry.start}–{entry.end}</span>
                    <span className="via" title={entry.via.join(' → ')}>
                      {entry.via.length > 1 ? entry.via.slice(-1)[0] : 'direct'}
                    </span>
                  </div>
                ))}
              </div>
              <RangeReader onRead={(range) => readRange(selectedDetail.id, range)} totalSize={selectedDetail.totalSize} content={content} />
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function RangeReader({
  onRead,
  totalSize,
  content,
}: {
  onRead: (range: string | undefined) => void;
  totalSize: number;
  content: {range?: string; status: number; body: string; header?: string} | null;
}) {
  const [range, setRange] = useState('');
  return (
    <div className="range-reader">
      <h3>Stream / range</h3>
      <div className="row">
        <input
          placeholder={`bytes=0-${Math.max(totalSize - 1, 0)}`}
          value={range}
          onChange={(e) => setRange(e.target.value)}
        />
        <button onClick={() => onRead(range.trim() || undefined)}>
          <Play size={13} /> Fetch
        </button>
      </div>
      <div className="row wrap gap">
        <button className="ghost small" onClick={() => onRead(`bytes=0-${Math.min(totalSize - 1, 0)}`)}>first byte</button>
        {totalSize > 1 && (
          <button className="ghost small" onClick={() => onRead(`bytes=${Math.floor(totalSize / 2)}-`)}>from middle</button>
        )}
        <button className="ghost small" onClick={() => onRead('bytes=-1')}>last byte</button>
      </div>
      {content && (
        <div className={`response ${content.status >= 400 ? 'bad' : 'good'}`}>
          <span>HTTP {content.status}{content.header ? ` · ${content.header}` : ''}</span>
          <pre>{content.body || '(empty)'}</pre>
        </div>
      )}
    </div>
  );
}
