<script setup lang="ts">
import { CreateDepartmentSchema, type Department } from '@ticket/shared';
import { onMounted, ref } from 'vue';
import { errorMessage } from '../screen.js';

/**
 * Departments: every department, active or not. Add (id, name, description; new
 * ones are active), edit (name, description, active; the id is immutable), remove
 * (refused while a decision references the id).
 */
const departments = ref<Department[]>([]);
const loading = ref(true);
const loadError = ref('');
const busy = ref(false);
const message = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

const addForm = ref({ id: '', name: '', description: '' });
const addError = ref('');

const editingId = ref<string | null>(null);
const editForm = ref({ name: '', description: '', active: true });

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    departments.value = [...(await window.api.listDepartments())];
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  message.value = null;
  try {
    await action();
  } catch (error) {
    message.value = { tone: 'error', text: errorMessage(error) };
  } finally {
    busy.value = false;
  }
}

async function add(): Promise<void> {
  addError.value = '';
  const parsed = CreateDepartmentSchema.safeParse(addForm.value);
  if (!parsed.success) {
    addError.value = parsed.error.issues[0]?.message ?? 'Check the fields.';
    return;
  }
  await run(async () => {
    const created = await window.api.createDepartment(parsed.data);
    addForm.value = { id: '', name: '', description: '' };
    await load();
    message.value = { tone: 'ok', text: `Added ${created.name}.` };
  });
}

function startEdit(department: Department): void {
  editingId.value = department.id;
  editForm.value = { name: department.name, description: department.description, active: department.active };
  message.value = null;
}

async function saveEdit(id: string): Promise<void> {
  await run(async () => {
    const updated = await window.api.updateDepartment({ id, ...editForm.value });
    departments.value = departments.value.map((department) => (department.id === id ? updated : department));
    editingId.value = null;
    message.value = { tone: 'ok', text: `Saved ${updated.name}.` };
  });
}

async function remove(department: Department): Promise<void> {
  if (!window.confirm(`Remove the department “${department.name}” (${department.id})?`)) return;
  await run(async () => {
    await window.api.deleteDepartment({ id: department.id });
    await load();
    message.value = { tone: 'ok', text: `Removed ${department.name}.` };
  });
}

onMounted(load);
</script>

<template>
  <section class="section" aria-labelledby="departments-title" data-testid="departments-section">
    <header class="head">
      <div>
        <h1 id="departments-title">Departments</h1>
        <p class="muted">
          Every department, including inactive ones. The classifier and the override list use only active
          departments. The id never changes, because ticket decisions store it.
        </p>
      </div>
      <button type="button" :disabled="loading" @click="load">Refresh</button>
    </header>

    <p v-if="message" class="notice" :data-tone="message.tone" :role="message.tone === 'error' ? 'alert' : 'status'">
      {{ message.text }}
    </p>
    <p v-if="loadError" class="notice" data-tone="error" role="alert">
      {{ loadError }} <button type="button" class="link" @click="load">Retry</button>
    </p>

    <div class="card list">
      <p v-if="loading && departments.length === 0" class="muted" role="status">Loading departments…</p>
      <p v-else-if="departments.length === 0" class="muted">No departments yet. Add the first one below.</p>
      <table v-else>
        <thead>
          <tr>
            <th scope="col">Id</th>
            <th scope="col">Name</th>
            <th scope="col">Description</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="department in departments" :key="department.id">
            <td><code>{{ department.id }}</code></td>
            <template v-if="editingId === department.id">
              <td>
                <label class="visually-hidden" :for="`name-${department.id}`">Name</label>
                <input :id="`name-${department.id}`" v-model="editForm.name" required maxlength="120" />
              </td>
              <td>
                <label class="visually-hidden" :for="`desc-${department.id}`">Description</label>
                <textarea :id="`desc-${department.id}`" v-model="editForm.description" rows="2" maxlength="2000"></textarea>
              </td>
              <td>
                <label class="check"><input v-model="editForm.active" type="checkbox" /> Active</label>
              </td>
              <td>
                <div class="actions row-actions">
                  <button type="button" class="primary" :disabled="busy || !editForm.name.trim()" @click="saveEdit(department.id)">
                    Save
                  </button>
                  <button type="button" :disabled="busy" @click="editingId = null">Cancel</button>
                </div>
              </td>
            </template>
            <template v-else>
              <td>{{ department.name }}</td>
              <td class="plain">{{ department.description || '—' }}</td>
              <td>
                <span class="badge" :data-tone="department.active ? 'ok' : undefined">
                  {{ department.active ? 'Active' : 'Inactive' }}
                </span>
              </td>
              <td>
                <div class="actions row-actions">
                  <button type="button" :disabled="busy" @click="startEdit(department)">Edit</button>
                  <button type="button" class="danger" :disabled="busy" @click="remove(department)">Remove</button>
                </div>
              </td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="card add" @submit.prevent="add">
      <h2>Add department</h2>
      <div class="grid">
        <label class="field">
          <span>Id</span>
          <input v-model="addForm.id" required maxlength="64" autocomplete="off" placeholder="billing" />
          <small>Lowercase letters, digits, and hyphens. Cannot be changed later.</small>
        </label>
        <label class="field">
          <span>Name</span>
          <input v-model="addForm.name" required maxlength="120" autocomplete="off" placeholder="Billing" />
        </label>
        <label class="field wide">
          <span>Description</span>
          <textarea v-model="addForm.description" rows="2" maxlength="2000" placeholder="What tickets belong here"></textarea>
        </label>
      </div>
      <p v-if="addError" class="error" role="alert">{{ addError }}</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Add department</button>
        <span class="muted">New departments are active.</span>
      </div>
    </form>
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
  max-width: 70ch;
}
.list {
  padding: 0;
  overflow-x: auto;
}
.list > p {
  padding: 16px;
  margin: 0;
}
.row-actions {
  justify-content: flex-end;
  flex-wrap: nowrap;
}
.check {
  display: flex;
  gap: 6px;
  align-items: center;
  white-space: nowrap;
}
.add {
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
code {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
}
</style>
