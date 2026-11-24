import { Activity, Check, CircleAlert, Clock, Info, Square } from 'lucide-react';
import {
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle,
} from '@/src/components/ui/trace';
import type { ActivityStatus, ActivityStep } from '../../src/learning/activity.ts';

const statusLabel: Record<ActivityStatus, string> = {
  running: 'Running', done: 'Done', stopped: 'Stopped', error: 'Failed', fallback: 'Fallback used',
};

const statusIcon = { running: Clock, done: Check, stopped: Square, error: CircleAlert, fallback: Info };

export function ReaderActivity({ steps }: { steps?: ActivityStep[] }) {
  if (!steps?.length) return null;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon><Activity /></TraceIcon>
            <TraceTitle>Activity</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <ol className="grid gap-2">
            {steps.map(({ label, detail, files, status }, index) => {
              const Icon = statusIcon[status];
              return (
                <li key={index}>
                  <TraceLine status={status === 'running' || status === 'error' ? status : undefined}>
                    <TraceIcon><Icon /></TraceIcon>
                    <TraceTitle className="whitespace-normal wrap-break-word">{label}</TraceTitle>
                  </TraceLine>
                  <p className="ml-6 text-xs wrap-anywhere">
                    {statusLabel[status]}{detail && ` · ${detail}`}
                  </p>
                  {!!files?.length && (
                    <ul className="ml-6 text-xs wrap-anywhere">
                      {files.map(({ path, url }) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{path}</a></li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
