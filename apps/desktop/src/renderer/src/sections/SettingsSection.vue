<script setup lang="ts">
import {
  ClassifyTimeoutMsSchema,
  ConnectTimeoutMsSchema,
  MinConfidenceSchema,
  OllamaBaseUrlSchema,
  OllamaModelNameSchema,
  SETTING_KEYS,
  type ConnectionTestResult,
  type DesktopSettingsView,
  type ModelList,
  type SettingKey,
  type SettingsPatch,
  type SettingsValues,
  type StorageInfo,
} from '@ticket/shared';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { errorMessage } from '../screen.js';
import {
  fallbackModelOptions,
  fallbackModelProblem,
  fieldState,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_DESCRIPTIONS,
  SETTINGS_CATEGORY_LABELS,
  type SettingsCategory,
} from '../settings-fields.js';
import { browserStorage, readTheme, setTheme, type Theme } from '../theme.js';

/**
 * Settings: one section, categories in a side list. Non-secret values are saved by
 * the agent and apply to the next classify. The access token is write-only here:
 * the renderer sends it once and only ever learns whether one is set.
 */
const category = ref<SettingsCategory>('ollama');
const view = ref<DesktopSettingsView | null>(null);
const loadError = ref('');
const saving = ref(false);
const notice = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

const draft = reactive<SettingsValues>({
  ollamaBaseUrl: '',
  connectTimeoutMs: 0,
  model: '',
  classifyTimeoutMs: 0,
  minConfidence: 0,
  fallbackModel: null,
});
const errors = reactive<Partial<Record<SettingKey, string>>>({});

const SCHEMAS = {
  ollamaBaseUrl: OllamaBaseUrlSchema,
  connectTimeoutMs: ConnectTimeoutMsSchema,
  model: OllamaModelNameSchema,
  classifyTimeoutMs: ClassifyTimeoutMsSchema,
  minConfidence: MinConfidenceSchema,
  fallbackModel: OllamaModelNameSchema.nullable(),
} as const;

const theme = ref<Theme>(readTheme(browserStorage()));
watch(theme, (next) => setTheme(next, { storage: browserStorage(), root: document.documentElement }));

const state = (key: SettingKey) => (view.value ? fieldState(view.value.fields[key]) : null);

function sync(next: DesktopSettingsView): void {
  view.value = next;
  for (const key of SETTING_KEYS) {
    (draft as Record<SettingKey, unknown>)[key] = next.fields[key].value;
    errors[key] = undefined;
  }
}

async function load(): Promise<void> {
  loadError.value = '';
  try {
    sync(await window.api.getSettings());
  } catch (error) {
    loadError.value = errorMessage(error);
  }
}

function validate(key: SettingKey): boolean {
  const parsed = SCHEMAS[key].safeParse(draft[key]);
  errors[key] = parsed.success ? undefined : (parsed.error.issues[0]?.message ?? 'Invalid value.');
  return parsed.success;
}

/** Saves the changed, editable fields among `keys`. Invalid values are not sent. */
async function save(keys: readonly SettingKey[]): Promise<void> {
  if (!view.value || saving.value) return;
  notice.value = null;
  const editable = keys.filter((key) => !state(key)?.readOnly);
  const valid = editable.map(validate).every(Boolean);
  const pairProblem = keys.includes('fallbackModel') ? fallbackModelProblem(draft.model, draft.fallbackModel) : null;
  if (pairProblem) errors.fallbackModel = pairProblem;
  if (!valid || pairProblem) {
    notice.value = { tone: 'error', text: 'Fix the highlighted fields. Nothing was saved.' };
    return;
  }
  const patch: Record<string, unknown> = {};
  for (const key of editable) {
    if (draft[key] !== view.value.fields[key].value || view.value.fields[key].source === 'default') {
      patch[key] = draft[key];
    }
  }
  if (Object.keys(patch).length === 0) {
    notice.value = { tone: 'ok', text: 'Nothing to save.' };
    return;
  }
  saving.value = true;
  try {
    sync(await window.api.updateSettings(patch as SettingsPatch));
    notice.value = { tone: 'ok', text: 'Saved. The next classify uses the new values.' };
  } catch (error) {
    notice.value = { tone: 'error', text: errorMessage(error) };
  } finally {
    saving.value = false;
  }
}

// --- Ollama Connection -----------------------------------------------------

const testing = ref(false);
const testResult = ref<ConnectionTestResult | null>(null);
const testError = ref('');

async function testConnection(): Promise<void> {
  testResult.value = null;
  testError.value = '';
  if (!validate('ollamaBaseUrl') || !validate('connectTimeoutMs')) return;
  testing.value = true;
  try {
    // The URL in the form; nothing is saved.
    testResult.value = await window.api.testConnection({
      baseUrl: draft.ollamaBaseUrl,
      timeoutMs: draft.connectTimeoutMs,
    });
  } catch (error) {
    testError.value = errorMessage(error);
  } finally {
    testing.value = false;
  }
}

const tokenInput = ref('');
const tokenBusy = ref(false);
const tokenMessage = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

async function saveToken(): Promise<void> {
  if (!view.value || tokenBusy.value) return;
  tokenBusy.value = true;
  tokenMessage.value = null;
  try {
    const result = await window.api.saveOllamaToken(tokenInput.value);
    view.value = { ...view.value, tokenSet: result.tokenSet };
    tokenMessage.value = { tone: 'ok', text: 'Token saved, encrypted on this computer.' };
  } catch (error) {
    tokenMessage.value = { tone: 'error', text: errorMessage(error) };
  } finally {
    // Never keep the token in the page longer than needed.
    tokenInput.value = '';
    tokenBusy.value = false;
  }
}

async function clearToken(): Promise<void> {
  if (!view.value || tokenBusy.value) return;
  tokenBusy.value = true;
  tokenMessage.value = null;
  try {
    const result = await window.api.clearOllamaToken();
    view.value = { ...view.value, tokenSet: result.tokenSet };
    tokenMessage.value = {
      tone: 'ok',
      text: result.tokenSet ? 'Removed. The agent still has OLLAMA_TOKEN from its environment.' : 'Token removed.',
    };
  } catch (error) {
    tokenMessage.value = { tone: 'error', text: errorMessage(error) };
  } finally {
    tokenBusy.value = false;
  }
}

// --- AI Models ---------------------------------------------------------------

const models = ref<ModelList | null>(null);
const modelsLoading = ref(false);
const modelsError = ref('');
const modelOptions = computed(() => {
  const names = models.value?.models.map((m) => m.name) ?? [];
  return draft.model && !names.includes(draft.model) ? [draft.model, ...names] : names;
});

const fallbackOptions = computed(() =>
  fallbackModelOptions(models.value?.models.map((m) => m.name) ?? [], draft.model, draft.fallbackModel),
);

async function loadModels(): Promise<void> {
  modelsLoading.value = true;
  modelsError.value = '';
  try {
    models.value = await window.api.listModels();
  } catch (error) {
    modelsError.value = errorMessage(error);
  } finally {
    modelsLoading.value = false;
  }
}

const formatSize = (bytes: number | null) => (bytes === null ? '' : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

// --- Storage -----------------------------------------------------------------

const storage = ref<StorageInfo | null>(null);
const storageError = ref('');

async function loadStorage(): Promise<void> {
  storageError.value = '';
  try {
    storage.value = await window.api.getStorageInfo();
  } catch (error) {
    storageError.value = errorMessage(error);
  }
}

watch(category, (next) => {
  notice.value = null;
  if (next === 'models' && !models.value) void loadModels();
  if (next === 'storage') void loadStorage();
});

onMounted(load);
</script>

<template>
  <section class="section" aria-labelledby="settings-title" data-testid="settings-section">
    <header class="head">
      <div>
        <h1 id="settings-title">Settings</h1>
        <p class="muted">Saved settings apply to the next classify; no restart is needed.</p>
      </div>
      <fieldset class="theme">
        <legend>Theme</legend>
        <label><input v-model="theme" type="radio" name="theme" value="dark" data-testid="theme-dark" /> Dark</label>
        <label><input v-model="theme" type="radio" name="theme" value="light" data-testid="theme-light" /> Light</label>
      </fieldset>
    </header>

    <p v-if="notice" class="notice" :data-tone="notice.tone" :role="notice.tone === 'error' ? 'alert' : 'status'">
      {{ notice.text }}
    </p>

    <p v-if="loadError" class="notice" data-tone="error" role="alert">
      {{ loadError }} <button type="button" class="link" @click="load">Retry</button>
    </p>
    <p v-else-if="!view" class="muted" role="status">Loading settings…</p>

    <div v-else class="layout">
      <nav class="categories" aria-label="Settings categories">
        <button
          v-for="c in SETTINGS_CATEGORIES"
          :key="c"
          type="button"
          :aria-current="category === c ? 'page' : undefined"
          :data-testid="`settings-cat-${c}`"
          @click="category = c"
        >
          <span>{{ SETTINGS_CATEGORY_LABELS[c] }}</span>
          <small>{{ SETTINGS_CATEGORY_DESCRIPTIONS[c] }}</small>
        </button>
      </nav>

      <div class="panel card">
        <h2>{{ SETTINGS_CATEGORY_LABELS[category] }}</h2>

        <!-- Ollama Connection -->
        <form v-if="category === 'ollama'" class="stack" @submit.prevent="save(['ollamaBaseUrl', 'connectTimeoutMs'])">
          <label class="field">
            <span>
              Server URL
              <span class="badge" :data-tone="state('ollamaBaseUrl')?.readOnly ? 'accent' : undefined">
                {{ state('ollamaBaseUrl')?.sourceLabel }}
              </span>
            </span>
            <input
              v-model.trim="draft.ollamaBaseUrl"
              :readonly="state('ollamaBaseUrl')?.readOnly"
              :aria-invalid="!!errors.ollamaBaseUrl"
              autocomplete="off"
              spellcheck="false"
              data-testid="setting-ollamaBaseUrl"
              @blur="!state('ollamaBaseUrl')?.readOnly && validate('ollamaBaseUrl')"
            />
            <small v-if="state('ollamaBaseUrl')?.readOnly">
              Set by OLLAMA_HOST. Remove the variable and restart the agent to change it here.
            </small>
            <small v-else>http:// or https://, without a user name, query, or fragment. Redirects are not followed.</small>
            <small v-if="errors.ollamaBaseUrl" class="error" role="alert">{{ errors.ollamaBaseUrl }}</small>
            <small v-if="state('ollamaBaseUrl')?.envError" class="error" role="alert">
              {{ state('ollamaBaseUrl')?.envError }}
            </small>
          </label>

          <label class="field narrow">
            <span>Connection timeout (ms) <span class="badge">{{ state('connectTimeoutMs')?.sourceLabel }}</span></span>
            <input
              v-model.number="draft.connectTimeoutMs"
              type="number"
              min="500"
              max="600000"
              step="500"
              :aria-invalid="!!errors.connectTimeoutMs"
              @blur="validate('connectTimeoutMs')"
            />
            <small>500 – 600,000. Used for reachability checks and the model list.</small>
            <small v-if="errors.connectTimeoutMs" class="error" role="alert">{{ errors.connectTimeoutMs }}</small>
          </label>

          <div class="actions">
            <button type="submit" class="primary" :disabled="saving">Save</button>
            <button type="button" :disabled="testing" data-testid="test-connection" @click="testConnection">
              {{ testing ? 'Testing…' : 'Test connection' }}
            </button>
            <span class="muted">Tests the URL in the form without saving it.</span>
          </div>
          <p v-if="testResult" class="notice" :data-tone="testResult.ok ? 'ok' : 'error'" role="status">
            {{ testResult.message }}
            <template v-if="view.tokenSet">
              {{ testResult.tokenSent ? 'The access token was sent.' : 'The access token was not sent (only over https or to this computer).' }}
            </template>
          </p>
          <p v-if="testError" class="notice" data-tone="error" role="alert">{{ testError }}</p>
        </form>

        <section v-if="category === 'ollama'" class="stack token" aria-labelledby="token-title">
          <h3 id="token-title">
            Access token
            <span class="badge" :data-tone="view.tokenSet ? 'ok' : undefined" data-testid="token-state">
              {{ view.tokenSet ? 'Set' : 'Not set' }}
            </span>
          </h3>
          <p class="muted">
            Encrypted on this computer with the operating system's protection and handed to the agent, which keeps
            it in memory. It is never shown again, never stored in the database, and sent only over https or to this
            computer.
          </p>
          <p v-if="!view.tokenEncryptionAvailable" class="notice" data-tone="error" role="alert">
            This computer cannot encrypt secrets (safeStorage is unavailable), so a token cannot be saved.
          </p>
          <form class="actions" @submit.prevent="saveToken">
            <label class="visually-hidden" for="ollama-token">New access token</label>
            <input
              id="ollama-token"
              v-model="tokenInput"
              class="token-input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste a new token"
              :disabled="!view.tokenEncryptionAvailable || tokenBusy"
            />
            <button
              type="submit"
              class="primary"
              :disabled="!view.tokenEncryptionAvailable || tokenBusy || !tokenInput.trim()"
            >
              Save token
            </button>
            <button type="button" :disabled="tokenBusy || !view.tokenSet" @click="clearToken">Remove token</button>
          </form>
          <p v-if="tokenMessage" class="notice" :data-tone="tokenMessage.tone" role="status">{{ tokenMessage.text }}</p>
        </section>

        <!-- AI Models -->
        <form v-if="category === 'models'" class="stack" @submit.prevent="save(['model', 'fallbackModel', 'classifyTimeoutMs'])">
          <div class="models">
            <div class="actions">
              <h3>Models on {{ models?.server ?? 'the server' }}</h3>
              <button type="button" :disabled="modelsLoading" @click="loadModels">
                {{ modelsLoading ? 'Loading…' : 'Refresh' }}
              </button>
            </div>
            <p v-if="modelsError" class="error" role="alert">{{ modelsError }}</p>
            <p v-else-if="models && !models.reachable" class="error" role="alert">{{ models.message }}</p>
            <p v-else-if="models && models.models.length === 0" class="muted">The server reports no models.</p>
            <ul v-else-if="models" class="model-list">
              <li v-for="m in models.models" :key="m.name">
                <code>{{ m.name }}</code> <span class="muted">{{ formatSize(m.size) }}</span>
                <span v-if="m.name === view.fields.model.value" class="badge" data-tone="ok">active</span>
              </li>
            </ul>
          </div>

          <label class="field">
            <span>
              Active model
              <span class="badge" :data-tone="state('model')?.readOnly ? 'accent' : undefined">
                {{ state('model')?.sourceLabel }}
              </span>
            </span>
            <input v-if="state('model')?.readOnly" :value="draft.model" readonly />
            <select v-else v-model="draft.model" @change="validate('model')">
              <option v-for="name in modelOptions" :key="name" :value="name">{{ name }}</option>
            </select>
            <small v-if="state('model')?.readOnly">Set by OLLAMA_MODEL.</small>
            <small v-if="errors.model" class="error" role="alert">{{ errors.model }}</small>
            <small v-if="state('model')?.envError" class="error" role="alert">{{ state('model')?.envError }}</small>
          </label>

          <label class="field">
            <span>
              Fallback model
              <span class="badge" :data-tone="state('fallbackModel')?.readOnly ? 'accent' : undefined">
                {{ state('fallbackModel')?.sourceLabel }}
              </span>
            </span>
            <input v-if="state('fallbackModel')?.readOnly" :value="draft.fallbackModel ?? 'Disabled'" readonly />
            <select v-else v-model="draft.fallbackModel" data-testid="fallback-model" @change="validate('fallbackModel')">
              <option :value="null">Disabled</option>
              <option v-for="name in fallbackOptions" :key="name" :value="name">{{ name }}</option>
            </select>
            <small>
              Tried once, within the same classify timeout, only when the active model fails in a retryable way
              (unreachable, HTTP 500/502/503/504, an empty or malformed answer). Never after a timeout or a cancel.
            </small>
            <small v-if="state('fallbackModel')?.readOnly">Set by OLLAMA_FALLBACK_MODEL.</small>
            <small v-if="errors.fallbackModel" class="error" role="alert">{{ errors.fallbackModel }}</small>
            <small v-if="state('fallbackModel')?.envError" class="error" role="alert">{{ state('fallbackModel')?.envError }}</small>
          </label>

          <label class="field narrow">
            <span>Classify request timeout (ms) <span class="badge">{{ state('classifyTimeoutMs')?.sourceLabel }}</span></span>
            <input
              v-model.number="draft.classifyTimeoutMs"
              type="number"
              min="1000"
              max="3600000"
              step="1000"
              :aria-invalid="!!errors.classifyTimeoutMs"
              @blur="validate('classifyTimeoutMs')"
            />
            <small>1,000 – 3,600,000. One classify call to the model.</small>
            <small v-if="errors.classifyTimeoutMs" class="error" role="alert">{{ errors.classifyTimeoutMs }}</small>
          </label>
          <div class="actions">
            <button type="submit" class="primary" :disabled="saving">Save</button>
          </div>
        </form>

        <!-- Classification -->
        <form v-if="category === 'classification'" class="stack" @submit.prevent="save(['minConfidence'])">
          <label class="field narrow">
            <span>
              Minimum confidence
              <span class="badge" :data-tone="state('minConfidence')?.readOnly ? 'accent' : undefined">
                {{ state('minConfidence')?.sourceLabel }}
              </span>
            </span>
            <input
              v-model.number="draft.minConfidence"
              type="number"
              min="0"
              max="1"
              step="0.05"
              :readonly="state('minConfidence')?.readOnly"
              :aria-invalid="!!errors.minConfidence"
              @blur="!state('minConfidence')?.readOnly && validate('minConfidence')"
            />
            <small>
              0 – 1, default 0.7. Below it, or for an unknown department, a ticket becomes “Needs review” with no
              department applied.
            </small>
            <small v-if="state('minConfidence')?.readOnly">Set by CLASSIFY_MIN_CONFIDENCE.</small>
            <small v-if="errors.minConfidence" class="error" role="alert">{{ errors.minConfidence }}</small>
            <small v-if="state('minConfidence')?.envError" class="error" role="alert">
              {{ state('minConfidence')?.envError }}
            </small>
          </label>
          <div class="actions">
            <button type="submit" class="primary" :disabled="saving || state('minConfidence')?.readOnly">Save</button>
          </div>
        </form>

        <!-- Storage -->
        <div v-if="category === 'storage'" class="stack">
          <p v-if="storageError" class="error" role="alert">{{ storageError }}</p>
          <dl v-else-if="storage">
            <dt>Database</dt>
            <dd class="plain"><code>{{ storage.databasePath || '(unknown)' }}</code></dd>
            <dt>Departments</dt>
            <dd>{{ storage.departmentCount }}</dd>
            <dt>Tickets</dt>
            <dd>{{ storage.ticketCount }}</dd>
          </dl>
          <p v-else class="muted" role="status">Loading…</p>
          <p class="muted">Read only. Only the agent opens this file.</p>
          <div class="actions"><button type="button" @click="loadStorage">Refresh</button></div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.section {
  display: grid;
  gap: 16px;
  align-content: start;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.head p {
  margin: 4px 0 0;
}
.theme {
  display: flex;
  gap: 12px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 12px;
  margin: 0;
}
.theme legend {
  padding: 0 4px;
  color: var(--muted);
  font-size: 12px;
}
.theme label {
  display: flex;
  gap: 6px;
  align-items: center;
}
.layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.categories {
  display: grid;
  gap: 4px;
  position: sticky;
  top: 0;
}
.categories button {
  display: grid;
  text-align: left;
  border: none;
  background: none;
  padding: 8px 10px;
  border-radius: 8px;
}
.categories button:hover {
  background: var(--surface-2);
}
.categories button[aria-current='page'] {
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}
.categories small {
  color: var(--muted);
  font-weight: 400;
}
.panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.stack {
  display: grid;
  gap: 14px;
}
.narrow {
  max-width: 280px;
}
.token {
  border-top: 1px solid var(--border);
  padding-top: 16px;
}
.token h3 {
  display: flex;
  gap: 8px;
  align-items: center;
}
.token p {
  margin: 0;
}
.token-input {
  flex: 1 1 260px;
  width: auto;
}
.models h3 {
  margin-right: auto;
}
.model-list {
  margin: 8px 0 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
}
input[aria-invalid='true'] {
  border-color: var(--danger);
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
}
code {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .categories {
    position: static;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }
  .categories small {
    display: none;
  }
}
</style>
