import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type CacheInfo,
  type Meta,
  type ProviderId,
  type SecretName,
  type SecretStatus,
  type Settings,
  type SettingsPatch,
} from '../api';
import { errorMessage, formatBytes, formatTime } from '../format';

const list = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [id, ...rest] = line.split('=');
    const label = rest.join('=').trim();
    if (id?.trim() && label) labels[id.trim()] = label;
  }
  return labels;
}

function KeyStatus({ status }: { status: SecretStatus }) {
  if (!status.configured) return <span className="muted small">not set</span>;
  return (
    <span className="small">
      set{status.hint ? ` (${status.hint})` : ''} ·{' '}
      {status.source === 'settings' ? 'saved here' : 'from .env'}
    </span>
  );
}

/** A write-only secret: the value is never shown, only whether it is set. */
function SecretField({
  name,
  label,
  status,
  value,
  onChange,
  onRemove,
}: {
  name: SecretName;
  label: string;
  status: SecretStatus;
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <label>
      {label} <KeyStatus status={status} />
      <span className="row tight">
        <input
          type="password"
          autoComplete="off"
          value={value}
          data-testid={`secret-${name}`}
          placeholder={status.configured ? 'enter a new value to replace' : 'not set'}
          onChange={(e) => onChange(e.target.value)}
        />
        {status.source === 'settings' && (
          <button type="button" className="link" onClick={onRemove}>
            Remove
          </button>
        )}
      </span>
    </label>
  );
}

interface Form {
  provider: ProviderId;
  model: string;
  fallbackProvider: ProviderId | '';
  fallbackModel: string;
  effort: string;
  temperature: string;
  maxSegmentEntries: string;
  translationProfile: string;
  sourceLanguages: string;
  openSubtitlesUsername: string;
  maxAgeDays: string;
  maxSizeMb: string;
  stremioLanguages: string;
  dailyJobLimit: string;
  stremioProfile: string;
  languageLabels: string;
  targetLanguage: string;
  customInstructions: string;
}

function toForm(s: Settings): Form {
  return {
    provider: s.ai.provider,
    model: s.ai.model ?? '',
    fallbackProvider: s.ai.fallbackProvider ?? '',
    fallbackModel: s.ai.fallbackModel ?? '',
    effort: s.ai.effort,
    temperature: s.ai.temperature === null ? '' : String(s.ai.temperature),
    maxSegmentEntries: String(s.ai.maxSegmentEntries),
    translationProfile: s.ai.translationProfile,
    sourceLanguages: s.sources.languages.join(', '),
    openSubtitlesUsername: s.sources.openSubtitles.username ?? '',
    maxAgeDays: String(s.cache.maxAgeDays),
    maxSizeMb: String(s.cache.maxSizeMb),
    stremioLanguages: s.stremio.targetLanguages.join(', '),
    dailyJobLimit: String(s.stremio.dailyJobLimit),
    stremioProfile: s.stremio.profile,
    languageLabels: Object.entries(s.stremio.languageLabels)
      .map(([id, label]) => `${id}=${label}`)
      .join('\n'),
    targetLanguage: s.defaults.targetLanguage,
    customInstructions: s.defaults.customInstructions,
  };
}

function toPatch(f: Form, secrets: Partial<Record<SecretName, string | null>>): SettingsPatch {
  const patch: SettingsPatch = {
    ai: {
      provider: f.provider,
      model: f.model.trim() || null,
      fallbackProvider: f.fallbackProvider || null,
      fallbackModel: f.fallbackProvider ? f.fallbackModel.trim() || null : null,
      effort: f.effort,
      temperature: f.temperature.trim() === '' ? null : Number(f.temperature),
      maxSegmentEntries: Number(f.maxSegmentEntries),
      translationProfile: f.translationProfile,
    },
    sources: {
      languages: list(f.sourceLanguages),
      openSubtitlesUsername: f.openSubtitlesUsername.trim() || null,
    },
    cache: { maxAgeDays: Number(f.maxAgeDays), maxSizeMb: Number(f.maxSizeMb) },
    stremio: {
      targetLanguages: list(f.stremioLanguages),
      dailyJobLimit: Number(f.dailyJobLimit),
      profile: f.stremioProfile,
      languageLabels: parseLabels(f.languageLabels),
    },
    defaults: {
      targetLanguage: f.targetLanguage,
      customInstructions: f.customInstructions.trim(),
    },
  };
  const filled = Object.entries(secrets).filter(([, v]) => v === null || (v ?? '').trim() !== '');
  if (filled.length > 0) {
    patch.secrets = Object.fromEntries(
      filled.map(([k, v]) => [k, v === null ? null : (v ?? '').trim()]),
    );
  }
  return patch;
}

function CacheCard({ onMessage }: { onMessage: (m: string) => void }) {
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    api
      .cache()
      .then(setInfo)
      .catch(() => undefined);
  };
  useEffect(load, []);
  if (!info) return null;
  return (
    <section className="card" data-testid="cache">
      <h2>Cache</h2>
      <p>
        {info.translations} translations ({formatBytes(info.translationBytes)}) · {info.sources}{' '}
        source subtitles ({formatBytes(info.sourceBytes)}) · least recently used:{' '}
        {formatTime(info.oldestUse)}
      </p>
      <p className="muted small">
        Cleanup removes translations unused for {info.limits.maxAgeDays || '∞'} days and the least
        recently used ones above {info.limits.maxSizeMb || '∞'} MB (0 = no limit). Jobs in progress
        are never touched.
      </p>
      <div className="actions">
        <button
          disabled={busy}
          data-testid="cache-cleanup"
          onClick={() => {
            setBusy(true);
            api
              .cleanupCache()
              .then((r) => {
                onMessage(
                  `Cache cleaned: ${r.translationsRemoved} translations and ${r.sourcesRemoved} sources removed, ${formatBytes(r.bytesFreed)} freed.`,
                );
                load();
              })
              .catch((err: unknown) => onMessage(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          Clean up now
        </button>
      </div>
    </section>
  );
}

export function SettingsPage({
  meta,
  onSaved,
  onMessage,
}: {
  meta: Meta | null;
  onSaved: (s: Settings) => void;
  onMessage: (m: string) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [secrets, setSecrets] = useState<Partial<Record<SecretName, string | null>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setForm(toForm(s));
      })
      .catch((err: unknown) => setError(errorMessage(err, 'Could not load settings.')));
  }, []);

  if (error && !form) return <p className="error">{error}</p>;
  if (!settings || !form || !meta) return <p className="muted">Loading…</p>;

  const set = (key: keyof Form) => (value: string) => setForm({ ...form, [key]: value });
  const secret = (name: SecretName) => ({
    name,
    value: secrets[name] ?? '',
    onChange: (v: string) => setSecrets({ ...secrets, [name]: v }),
    onRemove: () => void save({ [name]: null }),
  });

  async function save(extraSecrets: Partial<Record<SecretName, string | null>> = {}) {
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.saveSettings(toPatch(form, { ...secrets, ...extraSecrets }));
      setSettings(saved);
      setForm(toForm(saved));
      setSecrets({});
      onSaved(saved);
      onMessage('Settings saved. They apply to new translations right away.');
    } catch (err) {
      setError(errorMessage(err, 'Could not save the settings.'));
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };
  const providers = meta.providers;
  const select = (key: keyof Form, options: { id: string; name: string }[], testId?: string) => (
    <select value={form[key]} onChange={(e) => set(key)(e.target.value)} data-testid={testId}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <form className="card form" onSubmit={submit} data-testid="settings">
        <h2>Settings</h2>
        <p className="muted small">
          Values saved here override the server's .env and apply without a restart. API keys are
          stored encrypted and are never shown again — only whether one is set.
        </p>
        {settings.mockAi && (
          <p className="detail">
            Mock mode (MOCK_AI) is on: translations are simulated whatever is chosen here.
          </p>
        )}

        <h3>AI translation</h3>
        <div className="row">
          <label>
            Provider
            {select('provider', providers, 'setting-provider')}
          </label>
          <label>
            Model
            <input
              value={form.model}
              list="models"
              data-testid="setting-model"
              placeholder={providers.find((p) => p.id === form.provider)?.defaultModel ?? ''}
              onChange={(e) => set('model')(e.target.value)}
            />
            <datalist id="models">
              {providers
                .find((p) => p.id === form.provider)
                ?.suggestedModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.note}
                  </option>
                ))}
            </datalist>
          </label>
          <label>
            Effort
            {select('effort', [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
            ])}
          </label>
        </div>
        <div className="row">
          <label>
            Fallback provider
            {select('fallbackProvider', [{ id: '', name: 'None' }, ...providers])}
          </label>
          <label>
            Fallback model
            <input
              value={form.fallbackModel}
              disabled={!form.fallbackProvider}
              placeholder="provider default"
              onChange={(e) => set('fallbackModel')(e.target.value)}
            />
          </label>
          <label>
            Temperature
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              placeholder="provider default"
              onChange={(e) => set('temperature')(e.target.value)}
            />
          </label>
        </div>
        <div className="row">
          <label>
            Subtitles per request
            <input
              type="number"
              min={5}
              max={200}
              value={form.maxSegmentEntries}
              onChange={(e) => set('maxSegmentEntries')(e.target.value)}
            />
          </label>
          <label>
            Default profile
            {select('translationProfile', meta.profiles)}
          </label>
          <label>
            Default target language
            {select('targetLanguage', meta.targetLanguages)}
          </label>
        </div>
        <label>
          Style instructions (used by the custom profile)
          <textarea
            rows={2}
            value={form.customInstructions}
            onChange={(e) => set('customInstructions')(e.target.value)}
          />
        </label>

        <h3>API keys</h3>
        <div className="row">
          {providers.map((p) => (
            <SecretField
              key={p.id}
              label={p.name}
              status={settings.apiKeys[p.id as ProviderId]}
              {...secret(p.id as ProviderId)}
            />
          ))}
        </div>

        <h3>Subtitle sources</h3>
        <div className="row">
          <label>
            Source languages, in order of preference
            <input
              value={form.sourceLanguages}
              placeholder="en, hr"
              onChange={(e) => set('sourceLanguages')(e.target.value)}
            />
          </label>
          <SecretField
            label="OpenSubtitles API key"
            status={settings.sources.openSubtitles.apiKey}
            {...secret('opensubtitles')}
          />
        </div>
        <div className="row">
          <label>
            OpenSubtitles username (optional)
            <input
              value={form.openSubtitlesUsername}
              autoComplete="off"
              onChange={(e) => set('openSubtitlesUsername')(e.target.value)}
            />
          </label>
          <SecretField
            label="OpenSubtitles password"
            status={settings.sources.openSubtitles.password}
            {...secret('opensubtitlesPassword')}
          />
        </div>

        <h3>Stremio</h3>
        <div className="row">
          <label>
            Languages offered in the subtitle menu
            <input
              value={form.stremioLanguages}
              data-testid="setting-stremio-languages"
              placeholder="sr-Latn, sr-Cyrl"
              onChange={(e) => set('stremioLanguages')(e.target.value)}
            />
          </label>
          <label>
            Translations per 24 h (0 = no limit)
            <input
              type="number"
              min={0}
              value={form.dailyJobLimit}
              onChange={(e) => set('dailyJobLimit')(e.target.value)}
            />
          </label>
          <label>
            Profile
            {select('stremioProfile', meta.profiles)}
          </label>
        </div>
        <label>
          Language labels in Stremio, one per line (e.g. sr-Latn=Srpski)
          <textarea
            rows={2}
            value={form.languageLabels}
            onChange={(e) => set('languageLabels')(e.target.value)}
          />
        </label>
        <p className="muted small">Available: {meta.targetLanguages.map((l) => l.id).join(', ')}</p>

        <h3>Cache limits</h3>
        <div className="row">
          <label>
            Remove translations unused for (days, 0 = never)
            <input
              type="number"
              min={0}
              value={form.maxAgeDays}
              onChange={(e) => set('maxAgeDays')(e.target.value)}
            />
          </label>
          <label>
            Maximum cache size (MB, 0 = no limit)
            <input
              type="number"
              min={0}
              value={form.maxSizeMb}
              onChange={(e) => set('maxSizeMb')(e.target.value)}
            />
          </label>
        </div>

        {error && (
          <p className="error" data-testid="settings-error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy} data-testid="save-settings">
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
      <CacheCard onMessage={onMessage} />
    </>
  );
}
