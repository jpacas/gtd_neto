/**
 * Global search functionality for GTD Neto
 */

(function() {
  'use strict';

  let searchModal = null;
  let searchInput = null;
  let searchResults = null;
  let allItems = [];
  let isOpen = false;

  // Initialize search
  function initSearch() {
    createSearchModal();
    loadAllItems();
  }

  function createSearchModal() {
    const modalHTML = `
      <div id="search-modal" class="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 hidden pt-20">
        <div class="bg-white dark:bg-slate-800 rounded-lg shadow-2xl w-full max-w-2xl mx-4 overflow-hidden">
          <!-- Search input -->
          <div class="p-4 border-b dark:border-slate-700">
            <div class="flex items-center gap-3">
              <svg class="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <input
                type="text"
                id="search-input"
                placeholder="Buscar tareas en todas las listas..."
                class="flex-1 bg-transparent border-none focus:outline-none text-slate-900 dark:text-slate-100"
                autocomplete="off"
              />
              <kbd class="px-2 py-1 text-xs rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400">ESC</kbd>
            </div>
          </div>

          <!-- Results -->
          <div id="search-results" class="max-h-96 overflow-y-auto">
            <div class="p-8 text-center text-slate-500 dark:text-slate-400">
              <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <p class="text-sm">Escribe para buscar en todas tus tareas...</p>
            </div>
          </div>

          <!-- Footer -->
          <div class="p-3 border-t dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Buscar en: Hacer, Agendar, Delegar, Desglosar, Collect</span>
            <span>↑↓ Navegar · ⏎ Ir</span>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
    searchModal = document.getElementById('search-modal');
    searchInput = document.getElementById('search-input');
    searchResults = document.getElementById('search-results');

    // Event listeners
    searchInput.addEventListener('input', handleSearch);
    searchModal.addEventListener('click', (e) => {
      if (e.target === searchModal) closeSearch();
    });

    // Keyboard navigation
    searchInput.addEventListener('keydown', handleKeydown);
  }

  async function loadAllItems() {
    // For now, search works with client-side data
    // In a future version, this could fetch from an API endpoint
    allItems = [];
    console.log('Search initialized (client-side mode)');
  }

  function handleSearch(e) {
    const query = e.target.value.trim().toLowerCase();

    if (!query) {
      showEmptyState();
      return;
    }

    // Filter items
    const results = allItems.filter(item => {
      const text = (item.title || item.input || '').toLowerCase();
      return text.includes(query);
    });

    displayResults(results, query);
  }

  function displayResults(results, query) {
    if (results.length === 0) {
      searchResults.innerHTML = `
        <div class="p-8 text-center text-slate-500 dark:text-slate-400">
          <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M12 12h.01M12 12h.01M12 12h.01"/>
          </svg>
          <p class="text-sm">No se encontraron resultados para "${query}"</p>
        </div>
      `;
      return;
    }

    // Group by list
    const grouped = {};
    results.forEach(item => {
      const list = item.list || 'collect';
      if (!grouped[list]) grouped[list] = [];
      grouped[list].push(item);
    });

    const listNames = {
      collect: '📥 Collect',
      hacer: '✅ Hacer',
      agendar: '🗓️ Agendar',
      delegar: '🤝 Delegar',
      desglosar: '🧩 Desglosar'
    };

    let html = '';
    Object.keys(grouped).forEach(listKey => {
      const items = grouped[listKey];
      html += `
        <div class="border-b dark:border-slate-700 last:border-b-0">
          <div class="px-4 py-2 bg-slate-50 dark:bg-slate-900 text-xs font-semibold text-slate-600 dark:text-slate-400">
            ${listNames[listKey] || listKey} (${items.length})
          </div>
          ${items.map(item => `
            <a href="/${listKey}"
               class="block px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors border-b dark:border-slate-800 last:border-b-0 search-result-item"
               data-list="${listKey}">
              <div class="text-sm text-slate-900 dark:text-slate-100">${highlightQuery(item.title || item.input, query)}</div>
              ${item.urgency || item.importance ? `
                <div class="mt-1 flex gap-2 text-xs text-slate-500">
                  ${item.urgency ? `<span>Urgencia: ${item.urgency}</span>` : ''}
                  ${item.importance ? `<span>Importancia: ${item.importance}</span>` : ''}
                </div>
              ` : ''}
            </a>
          `).join('')}
        </div>
      `;
    });

    searchResults.innerHTML = html;

    // Add click handlers
    searchResults.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => closeSearch());
    });
  }

  function highlightQuery(text, query) {
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-700 px-0.5 rounded">$1</mark>');
  }

  function showEmptyState() {
    searchResults.innerHTML = `
      <div class="p-8 text-center text-slate-500 dark:text-slate-400">
        <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <p class="text-sm">Escribe para buscar en todas tus tareas...</p>
      </div>
    `;
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  }

  function openSearch() {
    if (!searchModal) return;

    isOpen = true;
    searchModal.classList.remove('hidden');
    searchInput.value = '';
    searchInput.focus();
    showEmptyState();

    // Reload items in case they changed
    loadAllItems();
  }

  function closeSearch() {
    if (!searchModal) return;

    isOpen = false;
    searchModal.classList.add('hidden');
    searchInput.value = '';
  }

  // Export functions
  window.GlobalSearch = {
    open: openSearch,
    close: closeSearch,
    isOpen: () => isOpen
  };

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }
})();
