import { useState, type ReactNode } from 'react';
import { Check, Copy, Download, FileText } from 'lucide-react';
import { resultsApi, type ResultRecord } from '../api';

// A small, safe Markdown renderer: it only ever builds React elements, so model text can never
// inject HTML (no dangerouslySetInnerHTML anywhere). Links are limited to http(s).

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked: nothing to do */
        }
      }}
      aria-label={label}
      data-testid="copy-btn"
    >
      {done ? <Check size={11} /> : <Copy size={11} />} {done ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="my-1 overflow-hidden rounded border border-ink/20 bg-ink text-[11px] text-lime-100">
      <div className="flex items-center justify-between bg-ink/80 px-2 py-0.5 text-[10px] text-stone-300">
        <span className="font-pixel">{lang || 'code'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="scroll-thin overflow-x-auto p-2 leading-4">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);

/** Inline: `code`, **bold**, *italic* / _italic_, [text](https://…). */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = key;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1])
      out.push(
        <code key={k++} className="rounded bg-paper px-1 font-pixel text-[10px]">
          {t.slice(1, -1)}
        </code>,
      );
    else if (m[2]) out.push(<b key={k++}>{inline(t.slice(2, -2), k * 100)}</b>);
    else if (m[3]) out.push(<i key={k++}>{inline(t.slice(1, -1), k * 100)}</i>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      const href = safeHref(url);
      out.push(
        href ? (
          <a
            key={k++}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline"
          >
            {label}
          </a>
        ) : (
          label
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={k++} code={code.join('\n')} lang={fence[1]} />);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const size = ['text-sm', 'text-sm', 'text-xs', 'text-xs', 'text-xs', 'text-xs'][
        h[1].length - 1
      ];
      blocks.push(
        <div
          key={k++}
          className={`${size} mb-1 mt-2 font-extrabold first:mt-0`}
          role="heading"
          aria-level={h[1].length}
        >
          {inline(h[2])}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push(<hr key={k++} className="my-2 border-ink/20" />);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List
          key={k++}
          className={`my-1 space-y-0.5 pl-4 ${ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={k++} className="my-1 border-l-4 border-amber-300 pl-2 text-stone-600">
          {inline(q.join(' '))}
        </blockquote>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i])
    )
      para.push(lines[i++]);
    blocks.push(
      <p key={k++} className="my-1 whitespace-pre-wrap">
        {inline(para.join('\n'))}
      </p>,
    );
  }
  return <div className="break-words text-xs leading-5">{blocks}</div>;
}

/** Renders a saved result by its type, plus any attached files. */
export function ResultOutput({ rec }: { rec: ResultRecord }) {
  const images = rec.files.filter((f) => f.type.startsWith('image/'));
  const others = rec.files.filter((f) => !f.type.startsWith('image/'));
  return (
    <div data-testid="result-output">
      {rec.status !== 'done' ? (
        <p className="rounded bg-rose-50 p-2 text-xs font-bold text-rose-800" role="alert">
          {rec.error ?? rec.output}
        </p>
      ) : rec.output_type === 'code' ? (
        <CodeBlock code={rec.output} lang={rec.language} />
      ) : rec.output_type === 'markdown' ? (
        <Markdown text={rec.output} />
      ) : rec.output_type === 'image' ? (
        <div className="space-y-1">
          {images.length === 0 && (
            <p className="text-[11px] text-stone-500">
              No image file was generated; the image prompt is saved below.
            </p>
          )}
          <p className="text-[11px] text-stone-600">
            <b>Image prompt:</b> {rec.output}
          </p>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-words text-xs">{rec.output}</p>
      )}
      {images.map((f) => (
        <img
          key={f.name}
          src={resultsApi.fileUrl(rec.task_id, f.name)}
          alt={`${rec.title}: ${f.name}`}
          className="pixelated mt-1 max-h-72 w-full rounded border border-ink/20 bg-white object-contain"
          style={{ imageRendering: 'pixelated' }}
        />
      ))}
      {others.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {others.map((f) => (
            <li key={f.name} className="flex items-center gap-1 text-[11px]">
              <FileText size={12} />
              <span className="truncate">{f.name}</span>
              <span className="text-stone-500">{(f.size / 1024).toFixed(1)} KB</span>
              <a
                className="btn !min-h-0 !px-1 !py-0 !text-[10px]"
                href={resultsApi.fileUrl(rec.task_id, f.name, true)}
              >
                <Download size={10} /> Save
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
