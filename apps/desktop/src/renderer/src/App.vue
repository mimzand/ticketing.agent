<script setup lang="ts">
import { type AgentStatusEvent, type DesktopHealth } from '@ticket/shared';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import CategoriesSection from './sections/CategoriesSection.vue';
import DepartmentsSection from './sections/DepartmentsSection.vue';
import SettingsSection from './sections/SettingsSection.vue';
import TicketsSection from './sections/TicketsSection.vue';

type Section = 'tickets' | 'departments' | 'categories' | 'settings';
const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: 'tickets', label: 'Tickets' },
  { id: 'departments', label: 'Departments' },
  { id: 'categories', label: 'Categories' },
  { id: 'settings', label: 'Settings' },
];
const POLL_MS = 5_000;
/** Faster while the agent is down, so "Reconnecting…" clears soon after it is back. */
const POLL_DOWN_MS = 1_000;

const section = ref<Section>('tickets');
const health = ref<DesktopHealth | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let unmounted = false;

async function refreshHealth(): Promise<void> {
  try {
    health.value = await window.api.getHealth();
  } catch {
    health.value = {
      agent: 'unavailable',
      reason: 'The desktop shell could not check the agent.',
      reconnecting: false,
      checkedAt: new Date().toISOString(),
    };
  }
  if (unmounted) return;
  timer = setTimeout(() => void refreshHealth(), health.value.agent === 'connected' ? POLL_MS : POLL_DOWN_MS);
}

/** Keeps "Reconnecting…" on screen briefly even when the restart is very fast. */
const RECONNECT_MIN_SHOW_MS = 1_500;
let reconnectShownAt = 0;
let unsubscribe: (() => void) | undefined;

function onAgentStatus(status: AgentStatusEvent): void {
  if (status.reconnecting) {
    reconnectShownAt = Date.now();
    health.value = {
      agent: 'unavailable',
      reason: 'The agent stopped unexpectedly. Reconnecting…',
      reconnecting: true,
      checkedAt: new Date().toISOString(),
    };
    return;
  }
  if (status.state === 'running' || status.state === 'attached' || status.state === 'failed') {
    const wait = Math.max(0, reconnectShownAt + RECONNECT_MIN_SHOW_MS - Date.now());
    clearTimeout(timer);
    timer = setTimeout(() => void refreshHealth(), wait);
  }
}

onMounted(() => {
  unsubscribe = window.api.onAgentStatus(onAgentStatus);
  void refreshHealth();
});
onBeforeUnmount(() => {
  unmounted = true;
  unsubscribe?.();
  clearTimeout(timer);
});
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <p class="brand">Ticketing Agent</p>
      <nav aria-label="Sections">
        <button
          v-for="item in SECTIONS"
          :key="item.id"
          type="button"
          class="nav-item"
          :aria-current="section === item.id ? 'page' : undefined"
          :data-testid="`nav-${item.id}`"
          @click="section = item.id"
        >
          {{ item.label }}
        </button>
      </nav>
      <div class="agent" aria-live="polite">
        <span
          class="dot"
          :data-state="health === null ? 'unknown' : health.agent === 'unavailable' && health.reconnecting ? 'reconnecting' : health.agent"
          aria-hidden="true"
        ></span>
        <span v-if="health === null">Checking agent…</span>
        <span v-else-if="health.agent === 'connected'">
          Agent connected
          <small class="muted">
            {{ health.mode === 'attached' ? 'Attached' : health.mode === 'spawned' ? 'Started by the app' : 'Running' }}
            · pid {{ health.ping.pid }} · v{{ health.ping.version }}
          </small>
        </span>
        <span v-else-if="health.reconnecting" data-testid="agent-reconnecting">
          Reconnecting…
          <small class="muted">The agent stopped unexpectedly and is being restarted.</small>
        </span>
        <span v-else :title="health.reason">
          Agent unavailable
          <small class="muted">{{ health.reason }}</small>
        </span>
      </div>
    </aside>

    <main class="content">
      <TicketsSection v-if="section === 'tickets'" />
      <DepartmentsSection v-else-if="section === 'departments'" />
      <CategoriesSection v-else-if="section === 'categories'" />
      <SettingsSection v-else />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  height: 100%;
}
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 12px;
  background: var(--surface);
  border-right: 1px solid var(--border);
}
.brand {
  margin: 0 8px;
  font-weight: 700;
}
nav {
  display: grid;
  gap: 2px;
}
.nav-item {
  text-align: left;
  border: none;
  background: none;
  padding: 8px 10px;
  border-radius: 6px;
}
.nav-item:hover {
  background: var(--surface-2);
}
.nav-item[aria-current='page'] {
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}
.agent {
  margin-top: auto;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px;
  font-size: 13px;
}
.agent small {
  display: block;
}
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--muted);
}
.dot[data-state='connected'] {
  background: var(--ok);
}
.dot[data-state='unavailable'] {
  background: var(--danger);
}
.dot[data-state='reconnecting'] {
  background: var(--warn);
}
.content {
  overflow: auto;
  padding: 20px 24px;
}
</style>
