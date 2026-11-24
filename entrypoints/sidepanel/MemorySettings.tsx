import { useEffect, useState, type FormEvent } from 'react';
import { liveQuery } from 'dexie';
import { Alert, AlertDescription } from '@/src/components/ui/alert';
import { Button } from '@/src/components/ui/button';
import { Card } from '@/src/components/ui/card';
import { Checkbox } from '@/src/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/src/components/ui/collapsible';
import { Label } from '@/src/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/src/components/ui/native-select';
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

  return <Card role="region" className="control-panel" aria-labelledby="memory-heading">
    <h2 id="memory-heading">Learning memory</h2>
    <p className="muted">Memory is stored in this browser. Relevant preferences and interests can be included in requests to your chosen model.</p>
    <div className="checkbox-row">
      <Checkbox id="learning-memory" checked={enabled ?? false} disabled={enabled === undefined || busy} onCheckedChange={(checked) => {
        void change(() => memory.setEnabled(checked), checked ? 'Memory is on.' : 'Memory is paused.');
      }} />
      <Label htmlFor="learning-memory">Use learning memory</Label>
    </div>
    {enabled === false && <p className="muted">Paused. The sidebar skips recall and stops learning new preferences.</p>}
    {records.length === 0 ? <p className="muted">No saved preferences yet. Add one here or tell the sidebar how you like to learn.</p> :
      <ul className="memory-records">{records.map((record) => <li key={record.id}>
        <strong>{choiceLabel(record.kind, record.value)}</strong>
        <small>{record.scope === 'global' ? 'All topics' : record.scope} · {record.explicit ? 'Explicit' : 'Learned across sessions'}</small>
        {record.evidence.length > 0 ? <Collapsible>
          <CollapsibleTrigger render={<Button variant="link" size="sm" className="px-0" />}>Why this was saved</CollapsibleTrigger>
          <CollapsibleContent>
            {record.evidence.map(({ sessionId, turnId, text }) => <blockquote key={`${sessionId}/${turnId}`}>{text}</blockquote>)}
          </CollapsibleContent>
        </Collapsible> : <small>Set in memory settings</small>}
        <div className="button-row">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => edit(record)}>Edit</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void change(async () => {
            await memory.remove(record.id);
            if (editing?.id === record.id) edit();
          }, 'Memory deleted.')}>Delete</Button>
        </div>
      </li>)}</ul>}
    <form className="form-grid memory-form" onSubmit={save}>
      <h3>{editing ? 'Edit memory' : 'Add a preference'}</h3>
      <div className="field">
        <Label htmlFor="preference-type">Preference type</Label>
        <NativeSelect id="preference-type" value={kind} disabled={Boolean(editing)} onChange={(event) => {
          const next = event.target.value as Choice['kind'];
          setKind(next);
          setValue(options[next][0]);
        }}>
          {Object.entries(kinds).map(([id, label]) => <NativeSelectOption value={id} key={id}>{label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <div className="field">
        <Label htmlFor="preference">Preference</Label>
        <NativeSelect id="preference" value={value} onChange={(event) => setValue(event.target.value)}>
          {options[kind].map((option) => <NativeSelectOption value={option} key={option}>{choiceLabel(kind, option)}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <div className="button-row">
        <Button type="submit" disabled={busy}>Save preference</Button>
        {editing && <Button type="button" variant="ghost" onClick={() => edit()}>Cancel edit</Button>}
      </div>
    </form>
    {confirmClear ? <Alert>
      <AlertDescription>Clear all saved preferences, questions, and supporting evidence?</AlertDescription>
      <div className="button-row">
        <Button disabled={busy} variant="destructive" onClick={() => void change(async () => {
          await memory.clear();
          edit();
        }, 'Memory cleared.')}>Clear all</Button>
        <Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
      </div>
    </Alert> : <Button className="justify-self-start" variant="ghost" disabled={busy} onClick={() => setConfirmClear(true)}>Clear memory</Button>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert>}
  </Card>;
}
