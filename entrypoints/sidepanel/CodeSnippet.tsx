import { useState } from 'react';
import { WrapText } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import {
  CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle,
} from '@/src/components/ui/code-block';
import { useHighlightedCode } from '@/src/hooks/use-highlighted-code';

export function CodeSnippet({ code, language }: { code: string; language: string }) {
  const [wrap, setWrap] = useState(false);
  const lines = useHighlightedCode(code, code.length <= 16_000 ? language : '');

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{language || 'Code'}</CodeBlockTitle>
        <CodeBlockActions>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Wrap code lines" title="Wrap code lines" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText aria-hidden="true" />
          </Button>
          <CodeBlockCopyButton type="button" value={code.replace(/\n$/, '')} title="Copy code" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap} lineNumbers className="max-h-[28rem] whitespace-pre focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {lines.map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)}
      </CodeBlockContent>
    </CodeBlock>
  );
}
