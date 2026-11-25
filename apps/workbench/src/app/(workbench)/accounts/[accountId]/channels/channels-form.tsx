'use client';

import { useActionState } from 'react';
import type { ChannelSettings } from '@astra/contracts';
import { Field, FormMessage, Input, SubmitButton } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { saveChannels } from './actions';

export function ChannelsForm({ accountId, settings }: { accountId: string; settings: ChannelSettings }) {
  const [state, action] = useActionState(saveChannels, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const b = settings.branding;
  const keep = (name: string, fallback: string) => previous(state, name) ?? fallback;
  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="accountId" value={accountId} />
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-fg">Branding</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name shown to travellers" error={errors['branding.displayName']}>{(f) => <Input id={f.id} name="displayName" defaultValue={keep('displayName', b?.displayName ?? '')} aria-describedby={f.describedBy} />}</Field>
          <Field label="Logo address" hint="An https image address; optional." error={errors['branding.logoUrl']}>{(f) => <Input id={f.id} name="logoUrl" defaultValue={keep('logoUrl', b?.logoUrl ?? '')} aria-describedby={f.describedBy} />}</Field>
          <Field label="Primary colour" hint="Buttons and focus. Checked for WCAG 2.2 AA contrast when saved." error={errors['branding.primaryColor']}>{(f) => <Input id={f.id} name="primaryColor" defaultValue={keep('primaryColor', b?.primaryColor ?? '#0b5cad')} aria-describedby={f.describedBy} />}</Field>
          <Field label="Text on the primary colour" error={errors['branding.textOnPrimary']}>{(f) => <Input id={f.id} name="textOnPrimary" defaultValue={keep('textOnPrimary', b?.textOnPrimary ?? '#ffffff')} aria-describedby={f.describedBy} />}</Field>
        </div>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-fg">Widget</legend>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" name="widgetEnabled" defaultChecked={settings.widget.enabled} className="size-4" /> Switch the widget on
        </label>
        <Field label="Sites that may show it" hint="Origins such as https://book.example.com, separated by commas or spaces." error={errors['widget.allowedOrigins']}>{(f) => <Input id={f.id} name="origins" defaultValue={keep('origins', settings.widget.allowedOrigins.join(', '))} aria-describedby={f.describedBy} />}</Field>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-fg">Hosted purchase journey</legend>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" name="journeyEnabled" defaultChecked={settings.journey.enabled} className="size-4" /> Switch the journey on
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Address" hint="The journey is at /j/<address>." error={errors['journey.slug']}>{(f) => <Input id={f.id} name="slug" defaultValue={keep('slug', settings.journey.slug ?? '')} aria-describedby={f.describedBy} />}</Field>
          <Field label="Plans it sells" hint="Plan codes, separated by commas." error={errors['journey.planCodes']}>{(f) => <Input id={f.id} name="planCodes" defaultValue={keep('planCodes', settings.journey.planCodes.join(', '))} aria-describedby={f.describedBy} />}</Field>
          <Field label="Headline" error={errors['journey.headline']}>{(f) => <Input id={f.id} name="headline" defaultValue={keep('headline', settings.journey.headline)} aria-describedby={f.describedBy} />}</Field>
        </div>
      </fieldset>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save the channel settings</SubmitButton>
    </form>
  );
}
