<script setup lang="ts">
import { SenderEmailSchema, type Department, type TicketContext, type TicketView } from '@ticket/shared';
import { computed, onMounted, ref } from 'vue';
import {
  errorMessage,
  formatConfidence,
  priorTicketLine,
  senderLabel,
  STATUS_TONES,
  ticketFields,
  ticketRow,
} from '../screen.js';

/** Tickets: the 50 most recent as the main view, a detail panel, submit, and override. */
const tickets = ref<TicketView[]>([]);
const departments = ref<Department[]>([]);
const loading = ref(true);
const loadError = ref('');
const selectedId = ref<string | null>(null);

const showForm = ref(false);
const submitting = ref(false);
const submitError = ref('');
const submitNotice = ref('');
/** The externalId being classified, so Cancel can stop exactly that submit. */
const inFlightExternalId = ref<string | null>(null);
const cancelling = ref(false);
const form = ref({ externalId: '', subject: '', body: '', channel: 'email', email: '' });

/** The selected ticket's sender and earlier tickets (what the classifier saw). */
const context = ref<TicketContext | null>(null);
const contextError = ref('');
const mergeOpen = ref(false);
const mergeInto = ref('');
const merging = ref(false);
const mergeMessage = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

const overriding = ref(false);
const overrideError = ref('');
const overrideDepartmentId = ref('');

const activeDepartments = computed(() => departments.value.filter((department) => department.active));
const rows = computed(() => tickets.value.map((ticket) => ticketRow(ticket, departments.value)));
const selected = computed(() => tickets.value.find((ticket) => ticket.id === selectedId.value) ?? null);
const selectedFields = computed(() => (selected.value ? ticketFields(selected.value) : null));
const selectedRow = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? null);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [ticketList, departmentList] = await Promise.all([
      window.api.listTickets(),
      window.api.listDepartments(),
    ]);
    tickets.value = [...ticketList];
    departments.value = [...departmentList];
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

function select(id: string): void {
  selectedId.value = id;
  overrideDepartmentId.value = '';
  overrideError.value = '';
  mergeOpen.value = false;
  mergeInto.value = '';
  mergeMessage.value = null;
  void loadContext(id);
}

async function loadContext(id: string): Promise<void> {
  context.value = null;
  contextError.value = '';
  try {
    const result = await window.api.ticketContext(id);
    if (selectedId.value === id) context.value = result;
  } catch (error) {
    if (selectedId.value === id) contextError.value = errorMessage(error);
  }
}

/** Operator merge: this ticket's sender into another address. Decisions are not changed. */
async function merge(): Promise<void> {
  const from = context.value?.email;
  if (!from || merging.value) return;
  const into = SenderEmailSchema.safeParse(mergeInto.value);
  if (!into.success) {
    mergeMessage.value = { tone: 'error', text: into.error.issues[0]?.message ?? 'Enter one email address.' };
    return;
  }
  if (into.data === from) {
    mergeMessage.value = { tone: 'error', text: 'That is already this sender.' };
    return;
  }
  if (!window.confirm(`Merge every ticket of ${from} into ${into.data}? Decisions stay as they are.`)) return;
  merging.value = true;
  mergeMessage.value = null;
  try {
    const result = await window.api.mergeSender({ from, into: into.data });
    const id = selectedId.value;
    await load();
    if (id) {
      select(id);
      mergeMessage.value = {
        tone: 'ok',
        text: `Merged: ${result.movedTickets} ticket${result.movedTickets === 1 ? '' : 's'} now belong to ${result.email}.`,
      };
    }
  } catch (error) {
    mergeMessage.value = { tone: 'error', text: errorMessage(error) };
  } finally {
    merging.value = false;
  }
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  submitError.value = '';
  submitNotice.value = '';
  // The email is optional. Blank means an unknown sender (no memory).
  const rawEmail = form.value.email.trim();
  const email = rawEmail ? SenderEmailSchema.safeParse(rawEmail) : null;
  if (email && !email.success) {
    submitError.value = `Email: ${email.error.issues[0]?.message ?? 'enter one email address.'}`;
    submitting.value = false;
    return;
  }
  inFlightExternalId.value = form.value.externalId.trim();
  try {
    const { email: _typed, ...ticket } = form.value;
    const created = await window.api.classifyTicket({ ...ticket, ...(email && { email: email.data }) });
    form.value = { externalId: '', subject: '', body: '', channel: form.value.channel, email: '' };
    showForm.value = false;
    await load();
    select(created.id);
  } catch (error) {
    const text = errorMessage(error);
    // A cancel keeps the form filled in, so the same ticket can be submitted again.
    if (cancelling.value || /^Cancelled/.test(text)) submitNotice.value = 'Cancelled. Nothing was stored; you can submit it again.';
    else submitError.value = text;
  } finally {
    submitting.value = false;
    cancelling.value = false;
    inFlightExternalId.value = null;
  }
}

/** Stops the in-flight submit: the Ollama request is aborted and no decision is stored. */
async function cancelSubmit(): Promise<void> {
  const externalId = inFlightExternalId.value;
  if (!externalId || cancelling.value) return;
  cancelling.value = true;
  try {
    await window.api.cancelClassify({ externalId });
  } catch (error) {
    cancelling.value = false;
    submitError.value = errorMessage(error);
  }
}

async function override(): Promise<void> {
  if (!selected.value || overriding.value) return;
  overriding.value = true;
  overrideError.value = '';
  try {
    const updated = await window.api.overrideTicket({
      id: selected.value.id,
      departmentId: overrideDepartmentId.value,
    });
    tickets.value = tickets.value.map((ticket) => (ticket.id === updated.id ? updated : ticket));
    overrideDepartmentId.value = '';
  } catch (error) {
    overrideError.value = errorMessage(error);
  } finally {
    overriding.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="section" aria-labelledby="tickets-title" data-testid="tickets-section">
    <header class="head">
      <div>
        <h1 id="tickets-title">Tickets</h1>
        <p class="muted">The 50 most recent tickets. Select one to see its body, rationale, and override.</p>
      </div>
      <div class="actions">
        <button type="button" :disabled="loading" @click="load">Refresh</button>
        <button
          type="button"
          class="primary"
          :aria-expanded="showForm"
          aria-controls="new-ticket"
          @click="showForm = !showForm"
        >
          {{ showForm ? 'Close' : 'New ticket' }}
        </button>
      </div>
    </header>

    <form v-if="showForm" id="new-ticket" class="card new-ticket" @submit.prevent="submit">
      <h2>New ticket</h2>
      <div class="grid">
        <label class="field">
          <span>External id</span>
          <input v-model="form.externalId" required maxlength="200" autocomplete="off" />
        </label>
        <label class="field">
          <span>Channel</span>
          <input v-model="form.channel" required maxlength="64" autocomplete="off" />
        </label>
        <label class="field wide">
          <span>Email <small>optional — the sender's address; blank means an unknown sender</small></span>
          <input
            v-model="form.email"
            type="email"
            maxlength="254"
            autocomplete="off"
            spellcheck="false"
            placeholder="name@example.com"
            data-testid="ticket-email"
          />
        </label>
        <label class="field wide">
          <span>Subject</span>
          <input v-model="form.subject" required maxlength="300" autocomplete="off" />
        </label>
        <label class="field wide">
          <span>Body</span>
          <textarea v-model="form.body" rows="5" maxlength="20000"></textarea>
        </label>
      </div>
      <p v-if="submitError" class="error" role="alert">{{ submitError }}</p>
      <p v-if="submitNotice" class="notice" role="status">{{ submitNotice }}</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="submitting" data-testid="submit-ticket">
          {{ submitting ? 'Classifying…' : 'Submit ticket' }}
        </button>
        <button
          v-if="submitting"
          type="button"
          class="danger"
          :disabled="cancelling"
          data-testid="cancel-ticket"
          @click="cancelSubmit"
        >
          {{ cancelling ? 'Cancelling…' : 'Cancel' }}
        </button>
        <span v-if="submitting" class="muted" role="status">Waiting for the classifier…</span>
      </div>
    </form>

    <p v-if="loadError" class="notice" data-tone="error" role="alert">
      {{ loadError }} <button type="button" class="link" @click="load">Retry</button>
    </p>

    <div class="layout" :data-detail="selected ? 'open' : 'closed'">
      <div class="card list">
        <p v-if="loading && tickets.length === 0" class="muted" role="status">Loading tickets…</p>
        <p v-else-if="tickets.length === 0" class="muted">No tickets yet. Use “New ticket” to submit one.</p>
        <table v-else>
          <thead>
            <tr>
              <th scope="col">Subject</th>
              <th scope="col">Status</th>
              <th scope="col">Department</th>
              <th scope="col">Confidence</th>
              <th scope="col">Channel</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.id"
              :aria-selected="row.id === selectedId"
              class="row"
              @click="select(row.id)"
            >
              <td>
                <button type="button" class="link subject" @click.stop="select(row.id)">{{ row.subject }}</button>
              </td>
              <td><span class="badge" :data-tone="STATUS_TONES[row.status]">{{ row.statusLabel }}</span></td>
              <td>{{ row.department ?? '—' }}</td>
              <td>{{ row.confidence }}</td>
              <td>{{ row.channel }}</td>
              <td class="nowrap">{{ row.created }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside v-if="selected && selectedFields && selectedRow" class="card detail" aria-label="Ticket detail">
        <div class="detail-head">
          <h2>{{ selected.subject }}</h2>
          <button type="button" class="link" @click="selectedId = null">Close</button>
        </div>
        <dl>
          <dt>Status</dt>
          <dd>
            <span class="badge" :data-tone="STATUS_TONES[selectedFields.status]">{{ selectedRow.statusLabel }}</span>
          </dd>
          <dt>Department</dt>
          <dd>{{ selectedRow.department ?? 'None applied' }}</dd>
          <dt>Confidence</dt>
          <dd>{{ formatConfidence(selectedFields.confidence) }}</dd>
          <dt>Sender</dt>
          <dd class="plain" data-testid="ticket-sender">{{ senderLabel(selected.email) }}</dd>
          <dt>External id</dt>
          <dd class="plain">{{ selected.externalId }}</dd>
          <dt>Channel</dt>
          <dd>{{ selected.channel }}</dd>
          <dt>Created</dt>
          <dd>{{ selectedRow.created }}</dd>
          <dt>Taxonomy</dt>
          <dd data-testid="ticket-taxonomy">{{ selectedFields.taxonomyVersion > 0 ? `v${selectedFields.taxonomyVersion}` : '—' }}</dd>
        </dl>
        <h3>Body</h3>
        <p class="plain body">{{ selected.body || '(empty)' }}</p>
        <div class="why">
          <div>
            <h3>Rationale</h3>
            <p class="plain">{{ selectedFields.rationale || '(none)' }}</p>
          </div>
          <div>
            <h3>Evidence</h3>
            <!-- Plain text: an exact passage from this ticket, checked by the agent. -->
            <blockquote v-if="selectedFields.quote" class="plain quote" data-testid="ticket-quote">{{ selectedFields.quote }}</blockquote>
            <p v-else class="muted">No quote.</p>
          </div>
        </div>

        <section class="sender" aria-labelledby="prior-title">
          <h3 id="prior-title">Earlier tickets from this sender</h3>
          <p v-if="selected.email === null" class="muted">Unknown sender: no email, so no sender memory.</p>
          <p v-else-if="contextError" class="error" role="alert">{{ contextError }}</p>
          <p v-else-if="context === null" class="muted" role="status">Loading…</p>
          <p v-else-if="context.prior.length === 0" class="muted">None before this ticket.</p>
          <ol v-else class="prior" data-testid="prior-tickets">
            <li v-for="(prior, index) in context.prior" :key="index" class="plain">{{ priorTicketLine(prior) }}</li>
          </ol>
          <p v-if="selected.email !== null" class="muted small">
            Up to 5 decided tickets of this address, newest first, as the classifier receives them: data only.
          </p>

          <div v-if="selected.email !== null" class="merge">
            <button
              v-if="!mergeOpen"
              type="button"
              data-testid="merge-open"
              @click="
                mergeOpen = true;
                mergeMessage = null;
              "
            >
              Merge into email…
            </button>
            <form v-else class="merge-form" @submit.prevent="merge">
              <label class="field">
                <span>Merge {{ selected.email }} into</span>
                <input
                  v-model="mergeInto"
                  type="email"
                  required
                  maxlength="254"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="other@example.com"
                  data-testid="merge-into"
                />
                <small>Every ticket of {{ selected.email }} moves to that address. Decisions are not changed.</small>
              </label>
              <div class="actions">
                <button type="submit" class="primary" :disabled="merging" data-testid="merge-submit">
                  {{ merging ? 'Merging…' : 'Merge' }}
                </button>
                <button type="button" :disabled="merging" @click="mergeOpen = false">Cancel</button>
              </div>
            </form>
            <p v-if="mergeMessage" class="notice" :data-tone="mergeMessage.tone" role="status">{{ mergeMessage.text }}</p>
          </div>
        </section>

        <form class="override" @submit.prevent="override">
          <label class="field">
            <span>Override department</span>
            <select v-model="overrideDepartmentId" required :disabled="activeDepartments.length === 0">
              <option disabled value="">Choose an active department</option>
              <option v-for="department in activeDepartments" :key="department.id" :value="department.id">
                {{ department.name }} ({{ department.id }})
              </option>
            </select>
            <small v-if="activeDepartments.length === 0">No active department. Add or activate one under Departments.</small>
          </label>
          <p v-if="overrideError" class="error" role="alert">{{ overrideError }}</p>
          <button type="submit" :disabled="overriding || !overrideDepartmentId">
            {{ overriding ? 'Saving…' : 'Override' }}
          </button>
        </form>
      </aside>
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
.new-ticket {
  display: grid;
  gap: 12px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.wide {
  grid-column: 1 / -1;
}
.layout {
  display: grid;
  gap: 16px;
  align-items: start;
}
.layout[data-detail='open'] {
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
}
.list {
  padding: 0;
  overflow-x: auto;
}
.list > p {
  padding: 16px;
  margin: 0;
}
.list th,
.list td {
  padding: 8px;
}
.row {
  cursor: pointer;
}
.row:hover td {
  background: var(--surface-2);
}
.subject {
  font-weight: 500;
}
.nowrap {
  white-space: nowrap;
}
.detail {
  display: grid;
  gap: 10px;
  position: sticky;
  top: 0;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.detail h3 {
  margin-top: 4px;
}
.detail p {
  margin: 0;
}
.body {
  max-height: 280px;
  overflow: auto;
  background: var(--surface-2);
  border-radius: 6px;
  padding: 8px;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
}
.why {
  display: grid;
  gap: 10px;
}
.why h3 {
  margin-bottom: 4px;
}
.quote {
  margin: 0;
  padding: 6px 10px;
  border-left: 3px solid var(--accent);
  background: var(--surface-2);
  border-radius: 0 6px 6px 0;
}
.sender {
  display: grid;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.prior {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
  font-size: 13px;
}
.small {
  font-size: 12px;
}
.merge,
.merge-form {
  display: grid;
  gap: 8px;
}
.merge > button {
  justify-self: start;
}
small {
  color: var(--muted);
  font-weight: 400;
}
.override {
  display: grid;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
</style>
