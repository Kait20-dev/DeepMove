'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyPgn({ pgn }: { pgn: string }) {
  const [copiedPgn, setCopied] = useState<string | null>(null);
  const copied = copiedPgn === pgn;
  const [fallback, setFallback] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(pgn);
      setCopied(pgn);
      setFallback(false);
    } catch {
      setCopied(null);
      setFallback(true);
    }
  }
  return <div className="copy-pgn"><button className="text-button" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'PGN скопирован' : 'Скопировать PGN'}</button>{fallback && <div className="pgn-copy-fallback"><label>Не удалось получить доступ к буферу. Скопируй запись вручную:<textarea aria-label="PGN для ручного копирования" readOnly value={pgn} rows={6} onFocus={event => event.currentTarget.select()} /></label><button className="text-button" onClick={() => setFallback(false)}>Закрыть</button></div>}</div>;
}
