/**
 * Sistema de Tags para GTD_Neto
 */

class TagManager {
  constructor() {
    this.allTags = [];
    this.loadAllTags();
  }

  async loadAllTags() {
    try {
      const response = await fetch('/api/tags');
      const data = await response.json();
      this.allTags = data.tags || [];
    } catch (err) {
      console.error('Error loading tags:', err);
    }
  }

  async updateItemTags(itemId, tags) {
    const csrfToken = document.querySelector('input[name="_csrf"]')?.value || '';

    try {
      const response = await fetch(`/items/${itemId}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          _csrf: csrfToken,
          tags: tags.join(', '),
        }),
      });

      const data = await response.json();

      if (data.ok) {
        toast.success('Tags actualizados');
        return data.tags;
      } else {
        toast.error('Error al actualizar tags');
        return null;
      }
    } catch (err) {
      toast.error('Error de conexión');
      return null;
    }
  }

  createTagEditor(itemId, currentTags = []) {
    const container = document.createElement('div');
    container.className = 'mt-2 p-2 border dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-900';

    container.innerHTML = `
      <div class="flex items-center gap-2">
        <input
          type="text"
          class="flex-1 text-xs border dark:border-slate-700 dark:bg-slate-800 rounded px-2 py-1"
          placeholder="Agregar tags (separados por comas)..."
        />
        <button class="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700" data-action="save">
          Guardar
        </button>
        <button class="text-xs px-2 py-1 rounded border dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700" data-action="cancel">
          Cancelar
        </button>
      </div>
      <div class="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
        Sugerencias:
      </div>
    `;

    const input = container.querySelector('input');
    input.value = currentTags.join(', ');
    const saveBtn = container.querySelector('[data-action="save"]');
    const cancelBtn = container.querySelector('[data-action="cancel"]');
    const suggestionsRow = container.querySelector('.mt-1');

    this.allTags.slice(0, 10).forEach((tag, idx) => {
      const tagBtn = document.createElement('button');
      tagBtn.type = 'button';
      tagBtn.className = 'cursor-pointer hover:underline';
      tagBtn.dataset.tag = tag;
      tagBtn.textContent = tag;
      suggestionsRow.appendChild(tagBtn);
      if (idx < Math.min(this.allTags.length, 10) - 1) {
        suggestionsRow.appendChild(document.createTextNode(', '));
      }
    });

    // Click en sugerencias
    container.querySelectorAll('[data-tag]').forEach(el => {
      el.addEventListener('click', () => {
        const tag = el.dataset.tag;
        const current = input.value.split(',').map(t => t.trim()).filter(Boolean);
        if (!current.includes(tag)) {
          input.value = [...current, tag].join(', ');
        }
      });
    });

    saveBtn.addEventListener('click', async () => {
      const tags = input.value.split(',').map(t => t.trim()).filter(Boolean);
      LoadingManager.show(saveBtn);

      const updatedTags = await this.updateItemTags(itemId, tags);

      LoadingManager.hide(saveBtn);

      if (updatedTags !== null) {
        container.dispatchEvent(new CustomEvent('tags-updated', { detail: { tags: updatedTags } }));
      }
    });

    cancelBtn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('tags-cancelled'));
    });

    return container;
  }

  renderTags(tags = []) {
    if (!Array.isArray(tags) || tags.length === 0) return '';

    return tags
      .map(tag => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">${escapeHtml(tag)}</span>`)
      .join(' ');
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Instancia global
window.tagManager = new TagManager();
