<script setup lang="ts">
import { type Category, type TicketPriority } from '@ticket/shared';
import { onMounted, ref } from 'vue';
import { categoryExamplesProblem, parseCategoryForm, PRIORITY_OPTIONS, type CategoryAddForm } from '../category-form.js';
import { linesToList, listToLines } from '../department-form.js';
import { errorMessage, PRIORITY_LABELS } from '../screen.js';

/**
 * Problem categories: what kind of problem a ticket is, beside the department that
 * handles it. Add (id, name, description, default priority, examples; new ones are
 * active), edit (everything but the id, which decisions store), remove (refused while
 * a decision stores the id). An inactive category stays listed and cannot be assigned.
 */
const categories = ref<Category[]>([]);
const loading = ref(true);
const loadError = ref('');
const busy = ref(false);
const message = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

const emptyAdd = (): CategoryAddForm => ({ id: '', name: '', description: '', defaultPriority: '', examples: '' });
const addForm = ref<CategoryAddForm>(emptyAdd());
const addError = ref('');

const editingId = ref<string | null>(null);
const editForm = ref<{ name: string; description: string; active: boolean; defaultPriority: TicketPriority; examples: string }>({
  name: '',
  description: '',
  active: true,
  defaultPriority: 'normal',
  examples: '',
});
const editError = ref('');

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    categories.value = [...(await window.api.listCategories())];
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
  const parsed = parseCategoryForm(addForm.value);
  addError.value = parsed.ok ? '' : parsed.error;
  if (!parsed.ok) return;
  await run(async () => {
    const created = await window.api.createCategory(parsed.value);
    addForm.value = emptyAdd();
    await load();
    message.value = { tone: 'ok', text: `Added ${created.name}.` };
  });
}

function startEdit(category: Category): void {
  editingId.value = category.id;
  editError.value = '';
  editForm.value = {
    name: category.name,
    description: category.description,
    active: category.active,
    defaultPriority: category.defaultPriority,
    examples: listToLines(category.examples),
  };
  message.value = null;
}

async function saveEdit(id: string): Promise<void> {
  editError.value = categoryExamplesProblem(editForm.value.examples) ?? '';
  if (editError.value) return;
  await run(async () => {
    const updated = await window.api.updateCategory({
      id,
      name: editForm.value.name,
      description: editForm.value.description,
      active: editForm.value.active,
      defaultPriority: editForm.value.defaultPriority,
      examples: linesToList(editForm.value.examples),
    });
    editingId.value = null;
    await load();
    message.value = { tone: 'ok', text: `Saved ${updated.name}.` };
  });
}

async function remove(category: Category): Promise<void> {
  if (!window.confirm(`Remove the category “${category.name}” (${category.id})?`)) return;
  await run(async () => {
    await window.api.deleteCategory({ id: category.id });
    await load();
    message.value = { tone: 'ok', text: `Removed ${category.name}.` };
  });
}

onMounted(load);
</script>

<template>
  <section class="section" aria-labelledby="categories-title" data-testid="categories-section">
    <header class="head">
      <div>
        <h1 id="categories-title">Categories</h1>
        <p class="muted">
          A category is the kind of problem, separate from the department that handles it. The classifier picks
          one active category and a priority; the default priority is only its starting guide. The id never
          changes, because ticket decisions store it. Examples are written by an admin.
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
      <p v-if="loading && categories.length === 0" class="muted" role="status">Loading categories…</p>
      <p v-else-if="categories.length === 0" class="muted">No categories yet. Add the first one below.</p>
      <table v-else>
        <thead>
          <tr>
            <th scope="col">Id</th>
            <th scope="col">Name</th>
            <th scope="col">Description</th>
            <th scope="col">Default priority</th>
            <th scope="col">Examples</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="category in categories" :key="category.id">
            <tr v-if="editingId === category.id" class="editing">
              <td><code>{{ category.id }}</code></td>
              <td colspan="6">
                <form class="edit" @submit.prevent="saveEdit(category.id)">
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
                    <span>Default priority</span>
                    <select v-model="editForm.defaultPriority" required>
                      <option v-for="priority in PRIORITY_OPTIONS" :key="priority" :value="priority">{{ PRIORITY_LABELS[priority] }}</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Examples <small>one per line, up to 20, 300 characters each</small></span>
                    <textarea v-model="editForm.examples" rows="4" data-testid="edit-category-examples"></textarea>
                  </label>
                  <p v-if="editError" class="error wide" role="alert">{{ editError }}</p>
                  <div class="actions wide">
                    <button type="submit" class="primary" :disabled="busy || !editForm.name.trim()">Save</button>
                    <button type="button" :disabled="busy" @click="editingId = null">Cancel</button>
                    <span class="muted">The id <code>{{ category.id }}</code> cannot change.</span>
                  </div>
                </form>
              </td>
            </tr>
            <tr v-else>
              <td><code>{{ category.id }}</code></td>
              <td>{{ category.name }}</td>
              <td class="plain">{{ category.description || '—' }}</td>
              <td>{{ PRIORITY_LABELS[category.defaultPriority] }}</td>
              <td>
                <span v-if="category.examples.length === 0" class="muted">—</span>
                <details v-else>
                  <summary>{{ category.examples.length }} example{{ category.examples.length === 1 ? '' : 's' }}</summary>
                  <ul class="examples">
                    <li v-for="example in category.examples" :key="example" class="plain">{{ example }}</li>
                  </ul>
                </details>
              </td>
              <td>
                <span class="badge" :data-tone="category.active ? 'ok' : undefined">
                  {{ category.active ? 'Active' : 'Inactive' }}
                </span>
              </td>
              <td>
                <div class="actions row-actions">
                  <button type="button" :disabled="busy" @click="startEdit(category)">Edit</button>
                  <button type="button" class="danger" :disabled="busy" @click="remove(category)">Remove</button>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <form class="card add" @submit.prevent="add">
      <h2>Add category</h2>
      <div class="grid">
        <label class="field">
          <span>Id</span>
          <input v-model="addForm.id" required maxlength="64" autocomplete="off" placeholder="outage" />
          <small>Lowercase letters, digits, and hyphens. Cannot be changed later.</small>
        </label>
        <label class="field">
          <span>Name</span>
          <input v-model="addForm.name" required maxlength="120" autocomplete="off" placeholder="Outage" />
        </label>
        <label class="field wide">
          <span>Description</span>
          <textarea v-model="addForm.description" rows="2" maxlength="2000" placeholder="What kind of problem this is"></textarea>
        </label>
        <label class="field">
          <span>Default priority</span>
          <select v-model="addForm.defaultPriority" required data-testid="add-default-priority">
            <option disabled value="">Choose a priority</option>
            <option v-for="priority in PRIORITY_OPTIONS" :key="priority" :value="priority">{{ PRIORITY_LABELS[priority] }}</option>
          </select>
        </label>
        <label class="field">
          <span>Examples <small>optional, one per line</small></span>
          <textarea v-model="addForm.examples" rows="3" placeholder="The website returns 500" data-testid="add-category-examples"></textarea>
        </label>
      </div>
      <p v-if="addError" class="error" role="alert">{{ addError }}</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Add category</button>
        <span class="muted">New categories are active.</span>
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
  max-width: 75ch;
}
.list {
  overflow-x: auto;
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
.add {
  display: grid;
  gap: 12px;
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
