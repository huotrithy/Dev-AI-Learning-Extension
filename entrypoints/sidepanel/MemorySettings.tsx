import { useEffect, useState, type FormEvent } from 'react';
import { liveQuery } from 'dexie';
import { choiceLabel } from '../../src/memory/policy.ts';
import { choiceSchema, options, type Choice, type MemoryRecord } from '../../src/memory/types.ts';
import { invalidateMemoryWork, memory } from './reader.ts';

const kinds: Record<Choice['kind'], string> = {
  'example-language': 'Example language', 'example-placement': 'Example placement',
  depth: 'Amount of detail', intent: 'Follow-up interest',
};

export function MemorySettings() {
  const [enabled, setEnabled] = useState<boolean>();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [kind, setKind] = useState<Choice['kind']>('example-language');
  const [value, setValue] = useState<string>('typescript');
  const [editing, setEditing] = useState<MemoryRecord>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [status, items] = await Promise.all([memory.status(), memory.list()]);
    setEnabled(status.enabled);
    setRecords(items);
  }

  useEffect(() => {
    const subscription = liveQuery(() => Promise.all([memory.status(), memory.list()])).subscribe({
      next: ([status, items]) => { setEnabled(status.enabled); setRecords(items); },
      error: () => setError('Could not open local memory.'),
    });
    return () => subscription.unsubscribe();
  }, []);

  async function change(operation: () => Promise<void>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    invalidateMemoryWork();
    try {
      await operation();
      await refresh();
      setNotice(message);
      setConfirmClear(false);
    } catch {
      setError('Could not update local memory.');
    } finally {
      setBusy(false);
    }
  }

  function edit(record?: MemoryRecord) {
    setEditing(record);
    setKind(record?.kind ?? 'example-language');
    setValue(record?.value ?? 'typescript');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const choice = choiceSchema.safeParse({ kind, value });
    if (!choice.success) return;
    void change(async () => {
      await memory.update({ ...choice.data, scope: editing?.scope ?? 'global' }, editing?.id);
      edit();
    }, 'Preference saved.');
  }

  return <section className="control-panel" aria-labelledby="memory-heading">
    <h2 id="memory-heading">Learning memory</h2>
    <p className="muted">Memory is stored in this browser. Relevant preferences and interests can be included in requests to your chosen model.</p>
    <label className="checkbox"><input type="checkbox" checked={enabled ?? false} disabled={enabled === undefined || busy} onChange={(event) => {
      const enabled = event.target.checked;
      void change(() => memory.setEnabled(enabled), enabled ? 'Memory is on.' : 'Memory is paused.');
    }} /> Use learning memory</label>
    {enabled === false && <p className="muted">Paused. The sidebar skips recall and stops learning new preferences.</p>}
    {records.length === 0 ? <p className="muted">No saved preferences yet. Add one here or tell the sidebar how you like to learn.</p> :
      <ul className="memory-records">{records.map((record) => <li key={record.id}>
        <strong>{choiceLabel(record.kind, record.value)}</strong>
        <small>{record.scope === 'global' ? 'All topics' : record.scope} · {record.explicit ? 'Explicit' : 'Learned across sessions'}</small>
        {record.evidence.length > 0 ? <details>
          <summary>Why this was saved</summary>
          {record.evidence.map(({ sessionId, turnId, text }) => <blockquote key={`${sessionId}/${turnId}`}>{text}</blockquote>)}
        </details> : <small>Set in memory settings</small>}
        <div className="button-row">
          <button className="text-button" disabled={busy} onClick={() => edit(record)}>Edit</button>
          <button className="text-button" disabled={busy} onClick={() => void change(async () => {
            await memory.remove(record.id);
            if (editing?.id === record.id) edit();
          }, 'Memory deleted.')}>Delete</button>
        </div>
      </li>)}</ul>}
    <form className="form-grid memory-form" onSubmit={save}>
      <h3>{editing ? 'Edit memory' : 'Add a preference'}</h3>
      <label>Preference type<select value={kind} disabled={Boolean(editing)} onChange={(event) => {
        const next = event.target.value as Choice['kind'];
        setKind(next);
        setValue(options[next][0]);
      }}>
        {Object.entries(kinds).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
      </select></label>
      <label>Preference<select value={value} onChange={(event) => setValue(event.target.value)}>
        {options[kind].map((option) => <option value={option} key={option}>{choiceLabel(kind, option)}</option>)}
      </select></label>
      <div className="button-row">
        <button className="primary" type="submit" disabled={busy}>Save preference</button>
        {editing && <button type="button" className="text-button" onClick={() => edit()}>Cancel edit</button>}
      </div>
    </form>
    {confirmClear ? <div className="status">
      <p>Clear all saved preferences, questions, and supporting evidence?</p>
      <div className="button-row">
        <button disabled={busy} className="danger" onClick={() => void change(async () => {
          await memory.clear();
          edit();
        }, 'Memory cleared.')}>Clear all</button>
        <button className="text-button" onClick={() => setConfirmClear(false)}>Cancel</button>
      </div>
    </div> : <button className="text-button" disabled={busy} onClick={() => setConfirmClear(true)}>Clear memory</button>}
    {error && <p role="alert" className="status error">{error}</p>}
    {notice && <p role="status" className="status">{notice}</p>}
  </section>;
}
