'use client';

import { createElement, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The widget as a booking page would show it. Its script is added once the page has loaded here,
 * because the widget changes its own element as soon as it runs.
 */
export function WidgetFrame({
  scriptUrl,
  api,
  quoteId,
  token,
}: {
  scriptUrl: string;
  api: string;
  quoteId: string;
  token: string;
}) {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    document.body.appendChild(script);
    return () => script.remove();
  }, [scriptUrl]);

  return (
    // The partner's page is white, whatever theme the person uses here.
    <div className="bg-white p-5 text-[#1a1a1a]" style={{ colorScheme: 'light' }}>
      <div className="mx-auto max-w-xl">
        {createElement('astra-cover-offer', { api, quote: quoteId, token })}
      </div>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? (
        <Check aria-hidden className="size-4 text-success" />
      ) : (
        <Copy aria-hidden className="size-4" />
      )}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  );
}
