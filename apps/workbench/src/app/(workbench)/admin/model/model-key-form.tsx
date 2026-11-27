'use client';

import { useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import type { ModelConnectionTest } from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Textarea } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';
import { idle, type ActionState } from '@/lib/actions';
import { saveModelKey, testModelKey } from './actions';

/**
 * Enter, test and save the model API key. The fields are held here, not reset after a test, so the same key can be
 * tested and then saved; they are cleared once it is saved.
 */
export function ModelKeyForm({ hasSavedKey }: { hasSavedKey: boolean }) {
  const [apiKey, setApiKey] = useState('');
  const [reason, setReason] = useState('');
  const [state, setState] = useState<ActionState>(idle);
  const [test, setTest] = useState<ModelConnectionTest | null>(null);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const busy = saving || testing;
  const typed = apiKey.trim();

  const runTest = () =>
    startTest(async () => {
      setState(idle);
      setTest(null);
      const result = await testModelKey(typed);
      if ('test' in result) setTest(result.test);
      else setState(result.error);
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        startSave(async () => {
          setTest(null);
          const result = await saveModelKey(typed, reason.trim());
          setState(result);
          if (result.status === 'success') {
            setApiKey('');
            setReason('');
          }
        });
      }}
    >
      <Field
        label="API key"
        hint="An Anthropic API key. It is stored encrypted and is never shown again."
        error={errors.apiKey}
      >
        {(f) => (
          <Input
            id={f.id}
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setTest(null);
            }}
            required
            minLength={20}
            maxLength={500}
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        )}
      </Field>
      <Field
        label="Reason for saving"
        hint="Needed to save, not to test. Recorded in the audit trail."
        error={errors.reason}
      >
        {(f) => (
          <Textarea
            id={f.id}
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            maxLength={500}
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        )}
      </Field>

      <FormMessage state={state} />
      {test ? (
        <Notice
          tone={test.ok ? 'success' : 'danger'}
          title={test.ok ? 'Test passed' : 'Test failed'}
        >
          <p>{test.message}</p>
          <p className="mt-1 text-xs">
            Tested the {test.source === 'entered' ? 'key entered above (not saved)' : 'saved key'}{' '}
            in {(test.latencyMs / 1000).toFixed(1)} seconds.
          </p>
        </Notice>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={runTest} disabled={busy || (!typed && !hasSavedKey)}>
          {testing ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <Button type="submit" disabled={busy}>
          {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save key'}
        </Button>
      </div>
      <p className="text-right text-xs text-muted">
        Test connection uses the key entered above, or the saved key when the field is empty.
      </p>
    </form>
  );
}
