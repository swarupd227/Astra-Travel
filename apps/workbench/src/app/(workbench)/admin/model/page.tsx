import type { ModelConnection } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, DescriptionList, PageHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { ModelKeyForm } from './model-key-form';
import { RemoveKeyDialog } from './remove-key-dialog';

export const metadata = { title: 'AI model connection' };

export default async function ModelConnectionPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('settings:manage')) {
    return <AccessDenied permission="settings:manage" />;
  }
  const connection = await load(() => api<ModelConnection>('/v1/settings/model-connection'));
  if (connection.error) return <ErrorPanel error={connection.error} />;
  const { savedKey, lastTest, models } = connection.data;

  return (
    <>
      <PageHeader
        title="AI model connection"
        description="The key the AI agents use to call the model. Only platform administrators can change it."
      />
      <div className="max-w-3xl space-y-4">
        <Card aria-labelledby="saved-key">
          <CardHeader
            titleId="saved-key"
            title="Saved key"
            description="Anthropic API"
            actions={
              <>
                <Badge tone={savedKey ? 'success' : 'warning'}>
                  {savedKey ? 'Saved' : 'Not saved'}
                </Badge>
                {savedKey ? <RemoveKeyDialog endsWith={savedKey.endsWith} /> : null}
              </>
            }
          />
          <div className="px-5 py-4">
            {savedKey ? (
              <DescriptionList
                items={[
                  {
                    term: 'Key',
                    value: <span className="font-mono">••••{savedKey.endsWith}</span>,
                  },
                  {
                    term: 'Saved',
                    value: (
                      <>
                        <LocalTime iso={savedKey.savedAt} /> by {savedKey.savedBy}
                      </>
                    ),
                  },
                  { term: 'Reason', value: savedKey.reason },
                  {
                    term: 'Last test',
                    value: lastTest ? (
                      <>
                        <Badge tone={lastTest.ok ? 'success' : 'danger'}>
                          {lastTest.ok ? 'Passed' : 'Failed'}
                        </Badge>{' '}
                        <LocalTime iso={lastTest.testedAt} /> by {lastTest.testedBy}
                        <span className="mt-1 block text-muted">{lastTest.message}</span>
                      </>
                    ) : (
                      'Not tested since it was saved.'
                    ),
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-muted">
                No key is saved. Agents can call the model only once a key is saved here, or if the
                platform operator has given the worker one in its environment.
              </p>
            )}
          </div>
        </Card>

        <Card aria-labelledby="set-key">
          <CardHeader
            titleId="set-key"
            title={savedKey ? 'Replace or test the key' : 'Add a key'}
            description={`A test sends one very small request to ${models.join(', ')}.`}
          />
          <div className="px-5 py-4">
            <ModelKeyForm hasSavedKey={!!savedKey} />
          </div>
        </Card>
      </div>
    </>
  );
}
