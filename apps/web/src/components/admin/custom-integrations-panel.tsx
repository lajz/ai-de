'use client';

import { useState } from 'react';

import {
  createCustomIntegration,
  deleteCustomIntegration,
  rotateCustomIntegrationSecret,
  testCustomIntegrationMapping,
  updateCustomIntegration,
} from '../../lib/admin-client';
import { relativeTime } from '../../lib/relative-time';
import {
  CUSTOM_ENTITY_TYPES,
  CUSTOM_PREDICATES,
  CUSTOM_SOURCE_KINDS,
  type CustomIntegration,
  type CustomMappingTestResult,
} from '../../lib/types';
import {
  draftFromMapping,
  emptyDraft,
  mappingFromDraft,
  type MappingDraft,
} from './custom-mapping-form';

interface Reveal {
  name: string;
  secret: string;
  ingestUrl: string;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — the value is selectable in the code block */
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Shown once after create / rotate; the secret is never retrievable again. */
function SecretReveal({ reveal, onDismiss }: { reveal: Reveal; onDismiss: () => void }) {
  return (
    <div className="integration-reveal" role="status">
      <p className="integration-reveal-title">
        Secret for “{reveal.name}” — copy it now. It cannot be shown again.
      </p>
      <div className="integration-reveal-row">
        <code>{reveal.secret}</code>
        <CopyButton value={reveal.secret} label="Copy secret" />
      </div>
      <div className="integration-reveal-row">
        <code>{reveal.ingestUrl}</code>
        <CopyButton value={reveal.ingestUrl} label="Copy ingest URL" />
      </div>
      <p className="connector-notice">
        POST JSON to the URL with <code>Authorization: Bearer &lt;secret&gt;</code>.
      </p>
      <button type="button" className="btn" onClick={onDismiss}>
        I’ve saved it
      </button>
    </div>
  );
}

function PathInput({
  label,
  value,
  onChange,
  required,
  placeholder = 'a.b[0].c',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="field-label">
      {label}
      <input
        className="field-input"
        value={value}
        required={required}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function MappingBuilder({
  engagementId,
  initialName,
  initialDraft,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  engagementId: string;
  initialName: string;
  initialDraft: MappingDraft;
  submitLabel: string;
  onSubmit: (name: string, draft: MappingDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initialDraft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState('{\n  \n}');
  const [testResult, setTestResult] = useState<CustomMappingTestResult | null>(null);

  const keys = draft.entities.map((e) => e.key).filter(Boolean);

  const setArtifact = (patch: Partial<MappingDraft['artifact']>) =>
    setDraft((d) => ({ ...d, artifact: { ...d.artifact, ...patch } }));
  const setEntity = (i: number, patch: Partial<MappingDraft['entities'][number]>) =>
    setDraft((d) => ({
      ...d,
      entities: d.entities.map((e, j) => (j === i ? { ...e, ...patch } : e)),
    }));
  const setRel = (i: number, patch: Partial<MappingDraft['relationships'][number]>) =>
    setDraft((d) => ({
      ...d,
      relationships: d.relationships.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await onSubmit(name, draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
      setPending(false);
    }
  }

  async function runTest() {
    setPending(true);
    setError(null);
    setTestResult(null);
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(sample);
      } catch {
        throw new Error('sample payload is not valid JSON');
      }
      setTestResult(
        await testCustomIntegrationMapping(engagementId, mappingFromDraft(draft), payload),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'test failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="integration-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field-label">
        Name
        <input
          className="field-input"
          value={name}
          required
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <fieldset className="integration-fieldset">
        <legend>Push event (dedupe key)</legend>
        <PathInput
          label="External id path"
          required
          value={draft.artifact.externalIdPath}
          onChange={(v) => setArtifact({ externalIdPath: v })}
        />
        <label className="field-label">
          Kind
          <select
            className="field-input"
            value={draft.artifact.kind}
            onChange={(e) =>
              setArtifact({ kind: e.target.value as MappingDraft['artifact']['kind'] })
            }
          >
            {CUSTOM_SOURCE_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <PathInput
          label="Occurred-at path (ISO-8601)"
          required
          value={draft.artifact.occurredAtPath}
          onChange={(v) => setArtifact({ occurredAtPath: v })}
        />
        <PathInput
          label="Permalink path (optional)"
          value={draft.artifact.urlPermalinkPath}
          onChange={(v) => setArtifact({ urlPermalinkPath: v })}
        />
      </fieldset>

      {draft.entities.map((e, i) => (
        <fieldset className="integration-fieldset" key={i}>
          <legend>Entity {i + 1}</legend>
          <label className="field-label">
            Key
            <input
              className="field-input"
              value={e.key}
              required
              onChange={(ev) => setEntity(i, { key: ev.target.value })}
            />
          </label>
          <label className="field-label">
            Type
            <select
              className="field-input"
              value={e.type}
              onChange={(ev) => setEntity(i, { type: ev.target.value as typeof e.type })}
            >
              {CUSTOM_ENTITY_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <PathInput
            label="External id path"
            required
            value={e.externalIdPath}
            onChange={(v) => setEntity(i, { externalIdPath: v })}
          />
          <PathInput
            label="Display name path"
            required
            value={e.displayNamePath}
            onChange={(v) => setEntity(i, { displayNamePath: v })}
          />
          <PathInput
            label="Body path (optional)"
            value={e.bodyPath}
            onChange={(v) => setEntity(i, { bodyPath: v })}
          />
          {e.attributes.map((a, k) => (
            <div className="connector-row" key={k}>
              <label className="field-label">
                Attribute name
                <input
                  className="field-input"
                  value={a.name}
                  onChange={(ev) =>
                    setEntity(i, {
                      attributes: e.attributes.map((x, y) =>
                        y === k ? { ...x, name: ev.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <PathInput
                label="Path"
                value={a.path}
                onChange={(v) =>
                  setEntity(i, {
                    attributes: e.attributes.map((x, y) => (y === k ? { ...x, path: v } : x)),
                  })
                }
              />
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setEntity(i, { attributes: e.attributes.filter((_, y) => y !== k) })}
              >
                Remove attribute
              </button>
            </div>
          ))}
          <div className="connector-row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                setEntity(i, { attributes: [...e.attributes, { name: '', path: '' }] })
              }
            >
              Add attribute
            </button>
            {draft.entities.length > 1 && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    entities: d.entities.filter((_, j) => j !== i),
                    relationships: d.relationships.filter(
                      (r) => r.from !== e.key && r.to !== e.key,
                    ),
                  }))
                }
              >
                Remove entity
              </button>
            )}
          </div>
        </fieldset>
      ))}
      <div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              entities: [
                ...d.entities,
                {
                  key: `entity${d.entities.length + 1}`,
                  type: 'person',
                  externalIdPath: '',
                  displayNamePath: '',
                  bodyPath: '',
                  attributes: [],
                },
              ],
            }))
          }
        >
          Add entity
        </button>
      </div>

      {draft.relationships.map((r, i) => (
        <fieldset className="integration-fieldset" key={i}>
          <legend>Relationship {i + 1}</legend>
          <label className="field-label">
            From
            <select
              className="field-input"
              value={r.from}
              onChange={(e) => setRel(i, { from: e.target.value })}
            >
              {keys.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Predicate
            <select
              className="field-input"
              value={r.predicate}
              onChange={(e) => setRel(i, { predicate: e.target.value as typeof r.predicate })}
            >
              {CUSTOM_PREDICATES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="field-label">
            To
            <select
              className="field-input"
              value={r.to}
              onChange={(e) => setRel(i, { to: e.target.value })}
            >
              {keys.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() =>
              setDraft((d) => ({ ...d, relationships: d.relationships.filter((_, j) => j !== i) }))
            }
          >
            Remove relationship
          </button>
        </fieldset>
      ))}
      <div>
        <button
          type="button"
          className="btn"
          disabled={keys.length === 0}
          onClick={() =>
            setDraft((d) => ({
              ...d,
              relationships: [
                ...d.relationships,
                { from: keys[0]!, predicate: 'relates_to', to: keys[keys.length - 1]! },
              ],
            }))
          }
        >
          Add relationship
        </button>
      </div>

      <fieldset className="integration-fieldset">
        <legend>Send test payload (dry run — nothing is stored)</legend>
        <textarea
          className="field-input integration-sample"
          aria-label="Sample payload"
          rows={8}
          spellCheck={false}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
        />
        <div>
          <button type="button" className="btn" disabled={pending} onClick={() => void runTest()}>
            Send test payload
          </button>
        </div>
        {testResult && (
          <pre className="integration-test-result">{JSON.stringify(testResult, null, 2)}</pre>
        )}
      </fieldset>

      {error && (
        <p className="connector-error" role="alert">
          {error}
        </p>
      )}
      <div className="connector-row">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-quiet" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function IntegrationCard({
  engagementId,
  integration,
  onChange,
  onRemove,
  onReveal,
}: {
  engagementId: string;
  integration: CustomIntegration;
  onChange: (i: CustomIntegration) => void;
  onRemove: () => void;
  onReveal: (r: Reveal) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <li className="connector-card">
        <MappingBuilder
          engagementId={engagementId}
          initialName={integration.name}
          initialDraft={draftFromMapping(integration.mapping)}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (name, draft) => {
            onChange(
              await updateCustomIntegration(engagementId, integration.id, {
                name,
                mapping: mappingFromDraft(draft),
              }),
            );
            setEditing(false);
          }}
        />
      </li>
    );
  }

  const last = relativeTime(integration.lastIngestedAt);
  return (
    <li className="connector-card">
      <div className="connector-head">
        <span className="connector-name">{integration.name}</span>
        <span className="connector-authkind">{integration.secretPrefix}…</span>
        <label className="connector-toggle">
          <input
            type="checkbox"
            checked={integration.enabled}
            disabled={pending}
            onChange={(e) =>
              void act(async () =>
                onChange(
                  await updateCustomIntegration(engagementId, integration.id, {
                    enabled: e.target.checked,
                  }),
                ),
              )
            }
          />
          enabled
        </label>
      </div>
      <div className="connector-row">
        <code className="integration-url">{integration.ingestUrl}</code>
        <CopyButton value={integration.ingestUrl} label="Copy ingest URL" />
      </div>
      <div className="connector-row">
        <span className="sync-meta">{last ? `last ingested ${last}` : 'never ingested'}</span>
        <button type="button" className="btn" disabled={pending} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => {
            if (!window.confirm('Rotate the secret? The current secret stops working immediately.'))
              return;
            void act(async () => {
              const res = await rotateCustomIntegrationSecret(engagementId, integration.id);
              onChange(res);
              onReveal({ name: res.name, secret: res.secret, ingestUrl: res.ingestUrl });
            });
          }}
        >
          Rotate secret
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={pending}
          onClick={() => {
            if (
              !window.confirm(`Delete “${integration.name}”? Pushes to its URL will start failing.`)
            )
              return;
            void act(async () => {
              await deleteCustomIntegration(engagementId, integration.id);
              onRemove();
            });
          }}
        >
          Delete
        </button>
      </div>
      {error && (
        <p className="connector-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function CustomIntegrationsPanel({
  engagementId,
  initialIntegrations,
}: {
  engagementId: string;
  initialIntegrations: CustomIntegration[];
}) {
  const [items, setItems] = useState(initialIntegrations);
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  return (
    <div className="integration-panel">
      <p className="connector-notice">
        Push JSON from your own system into the graph: describe where each value lives in your
        payload, then POST to the generated URL with its secret.
      </p>

      {reveal && <SecretReveal reveal={reveal} onDismiss={() => setReveal(null)} />}

      {items.length === 0 && !creating ? (
        <p className="empty-state">No custom integrations yet.</p>
      ) : (
        <ul className="connector-list">
          {items.map((i) => (
            <IntegrationCard
              key={i.id}
              engagementId={engagementId}
              integration={i}
              onChange={(next) => setItems((xs) => xs.map((x) => (x.id === next.id ? next : x)))}
              onRemove={() => setItems((xs) => xs.filter((x) => x.id !== i.id))}
              onReveal={setReveal}
            />
          ))}
        </ul>
      )}

      {creating ? (
        <MappingBuilder
          engagementId={engagementId}
          initialName=""
          initialDraft={emptyDraft()}
          submitLabel="Create integration"
          onCancel={() => setCreating(false)}
          onSubmit={async (name, draft) => {
            const res = await createCustomIntegration(engagementId, name, mappingFromDraft(draft));
            setItems((xs) => [...xs, res]);
            setReveal({ name: res.name, secret: res.secret, ingestUrl: res.ingestUrl });
            setCreating(false);
          }}
        />
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          New custom integration
        </button>
      )}
    </div>
  );
}
