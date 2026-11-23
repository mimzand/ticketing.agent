<script setup lang="ts">
import { CreateDepartmentSchema, type Department, type TaxonomyState } from '@ticket/shared';
import { onMounted, ref } from 'vue';
import { linesToList, listProblem, listToLines } from '../department-form.js';
import { errorMessage } from '../screen.js';

/**
 * Departments: every department, active or not. Add (id, name, description, aliases,
 * examples; new ones are active), edit (everything but the id, which decisions store),
 * remove (refused while a decision references the id). Every change is a new taxonomy
 * version; the history below is read only.
 */
const departments = ref<Department[]>([]);
const taxonomy = ref<TaxonomyState | null>(null);
const loading = ref(true);
const loadError = ref('');
const busy = ref(false);
const message = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

const emptyAdd = () => ({ id: '', name: '', description: '', aliases: '', examples: '' });
const addForm = ref(emptyAdd());
const addError = ref('');

const editingId = ref<string | null>(null);
const editForm = ref({ name: '', description: '', active: true, aliases: '', examples: '' });
const editError = ref('');

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [list, state] = await Promise.all([window.api.listDepartments(), window.api.getTaxonomy()]);
    departments.value = [...list];
    taxonomy.value = state;
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
  addError.value = listProblem(addForm.value.aliases, addForm.value.examples) ?? '';
  if (addError.value) return;
  const parsed = CreateDepartmentSchema.safeParse({
    id: addForm.value.id,
    name: addForm.value.name,
    description: addForm.value.description,
    aliases: linesToList(addForm.value.aliases),
    examples: linesToList(addForm.value.examples),
  });
  if (!parsed.success) {
    addError.value = parsed.error.issues[0]?.message ?? 'Check the fields.';
    return;
  }
  await run(async () => {
    const created = await window.api.createDepartment(parsed.data);
    addForm.value = emptyAdd();
    await load();
    message.value = { tone: 'ok', text: `Added ${created.name}.` };
  });
}

function startEdit(department: Department): void {
  editingId.value = department.id;
  editError.value = '';
  editForm.value = {
    name: department.name,
    description: department.description,
    active: department.active,
    aliases: listToLines(department.aliases),
    examples: listToLines(department.examples),
  };
  message.value = null;
}

async function saveEdit(id: string): Promise<void> {
  editError.value = listProblem(editForm.value.aliases, editForm.value.examples) ?? '';
  if (editError.value) return;
  await run(async () => {
    const updated = await window.api.updateDepartment({
      id,
      name: editForm.value.name,
      description: editForm.value.description,
      active: editForm.value.active,
      aliases: linesToList(editForm.value.aliases),
      examples: linesToList(editForm.value.examples),
    });
    editingId.value = null;
    await load();
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

const formatTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

onMounted(load);
</script>

<template>
  <section class="section" aria-labelledby="departments-title" data-testid="departments-section">
    <header class="head">
      <div>
        <h1 id="departments-title">
          Departments
          <span v-if="taxonomy" class="badge" data-tone="accent" data-testid="taxonomy-version">
            Taxonomy v{{ taxonomy.current }}
          </span>
        </h1>
        <p class="muted">
          Every department, including inactive ones. The classifier and the override list use only active
          departments. The id never changes, because ticket decisions store it. Aliases and examples help the
          classifier; it must still answer with an id.
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
            <th scope="col">Aliases</th>
            <th scope="col">Examples</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="department in departments" :key="department.id">
            <tr v-if="editingId === department.id" class="editing">
              <td><code>{{ department.id }}</code></td>
              <td colspan="6">
                <form class="edit" @submit.prevent="saveEdit(department.id)">
                  <label class="field">
                    <span>Name</span>
                    <input v-model="editForm.name" required maxlength="120" />
                  </label>
                  <label class="field check-field">
                    <span>Status</span>
                    <span class="check"><input v-model="editForm.active" type="checkbox" /> Active</span>
                  </label>
                  <label class="field wide">
                    <span>Description</span>
                    <textarea v-model="editForm.description" rows="2" maxlength="2000"></textarea>
                  </label>
                  <label class="field">
                    <span>Aliases <small>one per line, up to 20, 64 characters each</small></span>
                    <textarea v-model="editForm.aliases" rows="4" data-testid="edit-aliases"></textarea>
                  </label>
                  <label class="field">
                    <span>Examples <small>one per line, up to 20, 300 characters each</small></span>
                    <textarea v-model="editForm.examples" rows="4" data-testid="edit-examples"></textarea>
                  </label>
                  <p v-if="editError" class="error wide" role="alert">{{ editError }}</p>
                  <div class="actions wide">
                    <button type="submit" class="primary" :disabled="busy || !editForm.name.trim()">Save</button>
                    <button type="button" :disabled="busy" @click="editingId = null">Cancel</button>
                    <span class="muted">The id <code>{{ department.id }}</code> cannot change.</span>
                  </div>
                </form>
              </td>
            </tr>
            <tr v-else>
              <td><code>{{ department.id }}</code></td>
              <td>{{ department.name }}</td>
              <td class="plain">{{ department.description || '—' }}</td>
              <td>
                <span v-if="department.aliases.length === 0" class="muted">—</span>
                <span v-for="alias in department.aliases" :key="alias" class="badge alias">{{ alias }}</span>
              </td>
              <td>
                <span v-if="department.examples.length === 0" class="muted">—</span>
                <details v-else>
                  <summary>{{ department.examples.length }} example{{ department.examples.length === 1 ? '' : 's' }}</summary>
                  <ul class="examples">
                    <li v-for="example in department.examples" :key="example" class="plain">{{ example }}</li>
                  </ul>
                </details>
              </td>
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
            </tr>
          </template>
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
        <label class="field">
          <span>Aliases <small>optional, one per line</small></span>
          <textarea v-model="addForm.aliases" rows="3" placeholder="Accounts payable" data-testid="add-aliases"></textarea>
        </label>
        <label class="field">
          <span>Examples <small>optional, one per line</small></span>
          <textarea v-model="addForm.examples" rows="3" placeholder="My invoice total is wrong" data-testid="add-examples"></textarea>
        </label>
      </div>
      <p v-if="addError" class="error" role="alert">{{ addError }}</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Add department</button>
        <span class="muted">New departments are active.</span>
      </div>
    </form>

    <section class="card history" aria-labelledby="history-title" data-testid="taxonomy-history">
      <h2 id="history-title">Taxonomy history</h2>
      <p class="muted">
        Every change to a department, its aliases, or its examples is a new version. Each classify records the
        version it used. Read only: versions are never rolled back or rewritten.
      </p>
      <p v-if="taxonomy && taxonomy.history.length === 0" class="muted">Version 0: no department has been added yet.</p>
      <table v-else-if="taxonomy">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Time</th>
            <th scope="col">Departments</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in taxonomy.history" :key="entry.version">
            <td>
              v{{ entry.version }}
              <span v-if="entry.version === taxonomy.current" class="badge" data-tone="accent">current</span>
            </td>
            <td>{{ formatTime(entry.createdAt) }}</td>
            <td>{{ entry.departmentCount }}</td>
          </tr>
        </tbody>
      </table>
    </section>
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
.head h1 {
  display: flex;
  gap: 10px;
  align-items: center;
}
.head p {
  margin: 4px 0 0;
  max-width: 75ch;
}
.list,
.history {
  overflow-x: auto;
}
.list {
  padding: 0;
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
  font-weight: 400;
}
.alias {
  margin: 0 4px 4px 0;
  color: var(--text);
}
.examples {
  margin: 6px 0 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
  max-width: 40ch;
}
details summary {
  cursor: pointer;
  color: var(--accent);
}
.editing td {
  background: var(--surface-2);
}
.edit,
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.add,
.history {
  display: grid;
  gap: 12px;
}
.history p {
  margin: 0;
}
.wide {
  grid-column: 1 / -1;
}
small {
  color: var(--muted);
  font-weight: 400;
}
code {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
}
</style>
