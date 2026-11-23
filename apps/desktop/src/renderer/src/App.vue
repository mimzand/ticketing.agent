<script setup lang="ts">
import { type Department, type TicketView, type DesktopHealth } from '@ticket/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ticketFields } from './screen.js';

const POLL_MS = 5_000;

const health = ref<DesktopHealth | null>(null);
const checking = ref(false);
const departments = ref<Department[]>([]);
const tickets = ref<TicketView[]>([]);
const errorText = ref('');
const busy = ref(false);
const result = ref<TicketView | null>(null);

const departmentForm = ref({ id: '', name: '', description: '' });
const ticketForm = ref({ externalId: '', subject: '', body: '', channel: 'email' });
const overrideDepartmentId = ref('');

const activeDepartments = computed(() => departments.value.filter((department) => department.active));
const shown = computed(() => (result.value ? ticketFields(result.value) : null));

let timer: ReturnType<typeof setInterval> | undefined;

async function refreshHealth(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  try {
    health.value = await window.api.getHealth();
  } catch {
    health.value = {
      agent: 'unavailable',
      reason: 'The desktop shell could not check the agent.',
      checkedAt: new Date().toISOString(),
    };
  } finally {
    checking.value = false;
  }
}

async function refreshLists(): Promise<void> {
  departments.value = [...(await window.api.listDepartments())];
  tickets.value = [...(await window.api.listTickets())];
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorText.value = '';
  try {
    await action();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : 'The request failed.';
  } finally {
    busy.value = false;
  }
}

function createDepartment(): Promise<void> {
  return run(async () => {
    await window.api.createDepartment({ ...departmentForm.value });
    departmentForm.value = { id: '', name: '', description: '' };
    await refreshLists();
  });
}

function submitTicket(): Promise<void> {
  return run(async () => {
    result.value = await window.api.classifyTicket({ ...ticketForm.value });
    await refreshLists();
  });
}

function overrideTicket(id: string): Promise<void> {
  return run(async () => {
    result.value = await window.api.overrideTicket({ id, departmentId: overrideDepartmentId.value });
    await refreshLists();
  });
}

onMounted(() => {
  void refreshHealth();
  void refreshLists().catch(() => undefined);
  timer = setInterval(() => void refreshHealth(), POLL_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <main class="shell">
    <h1>Ticketing Agent</h1>

    <section class="card" aria-live="polite">
      <h2>Agent</h2>
      <p v-if="health === null">Checking…</p>
      <template v-else-if="health.agent === 'connected'">
        <p class="status ok">Connected</p>
        <dl>
          <dt>pid</dt>
          <dd>{{ health.ping.pid }}</dd>
          <dt>Version</dt>
          <dd>{{ health.ping.version }}</dd>
          <dt>Protocol</dt>
          <dd>{{ health.ping.protocolVersion }}</dd>
        </dl>
      </template>
      <template v-else>
        <p class="status down">Unavailable</p>
        <p>{{ health.reason }}</p>
      </template>
      <button type="button" :disabled="checking" @click="refreshHealth">Ping again</button>
    </section>

    <p v-if="errorText" class="status down" role="alert">{{ errorText }}</p>

    <section class="card">
      <h2>Department</h2>
      <form @submit.prevent="createDepartment">
        <label>Id <input v-model="departmentForm.id" required autocomplete="off" /></label>
        <label>Name <input v-model="departmentForm.name" required autocomplete="off" /></label>
        <label>Description <input v-model="departmentForm.description" autocomplete="off" /></label>
        <button type="submit" :disabled="busy">Create department</button>
      </form>
    </section>

    <section class="card">
      <h2>Ticket</h2>
      <form @submit.prevent="submitTicket">
        <label>External id <input v-model="ticketForm.externalId" required autocomplete="off" /></label>
        <label>Subject <input v-model="ticketForm.subject" required autocomplete="off" /></label>
        <label>Channel <input v-model="ticketForm.channel" required autocomplete="off" /></label>
        <label>Body <textarea v-model="ticketForm.body" rows="4" /></label>
        <button type="submit" :disabled="busy">Submit ticket</button>
      </form>
      <div v-if="shown">
        <h3>Result</h3>
        <dl>
          <dt>Status</dt>
          <dd>{{ shown.status }}</dd>
          <dt>Department</dt>
          <dd>{{ shown.department ?? 'none' }}</dd>
          <dt>Confidence</dt>
          <dd>{{ shown.confidence }}</dd>
          <dt>Rationale</dt>
          <dd>{{ shown.rationale }}</dd>
        </dl>
      </div>
    </section>

    <section class="card">
      <h2>Recent tickets</h2>
      <p v-if="tickets.length === 0">No tickets yet.</p>
      <ul v-else>
        <li v-for="ticket in tickets" :key="ticket.id">
          <p>{{ ticket.subject }} — {{ ticketFields(ticket).status }} — {{ ticketFields(ticket).department ?? 'none' }}</p>
          <form @submit.prevent="overrideTicket(ticket.id)">
            <label>
              Override
              <select v-model="overrideDepartmentId" required>
                <option disabled value="">Choose a department</option>
                <option v-for="department in activeDepartments" :key="department.id" :value="department.id">
                  {{ department.name }}
                </option>
              </select>
            </label>
            <button type="submit" :disabled="busy || activeDepartments.length === 0">Override</button>
          </form>
        </li>
      </ul>
    </section>
  </main>
</template>

<style>
body {
  margin: 0;
  font-family: system-ui, 'Segoe UI', sans-serif;
  background: #f6f7f9;
  color: #1d2330;
}
.shell {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px;
}
h1 {
  font-size: 20px;
}
.card {
  background: #fff;
  border: 1px solid #dde1e8;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}
h2 {
  margin-top: 0;
  font-size: 16px;
}
form {
  display: grid;
  gap: 8px;
}
label {
  display: grid;
  gap: 4px;
  font-size: 14px;
}
input,
textarea,
select,
button {
  font: inherit;
}
.status {
  font-weight: 600;
}
.ok {
  color: #1a7f37;
}
.down {
  color: #b42318;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
}
dt {
  color: #5b6474;
}
dd {
  margin: 0;
}
ul {
  padding-left: 18px;
}
</style>
