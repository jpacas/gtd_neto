/**
 * Keyboard shortcuts for GTD Neto
 */

(function() {
  'use strict';

  // Hotkey configuration
  const HOTKEYS = {
    // Navigation
    'g d': () => navigateTo('/'),           // Go to Dashboard
    'g c': () => navigateTo('/collect'),    // Go to Collect
    'g h': () => navigateTo('/hacer'),      // Go to Hacer
    'g a': () => navigateTo('/agendar'),    // Go to Agendar
    'g l': () => navigateTo('/delegar'),    // Go to Delegar (L for deLegar)
    'g p': () => navigateTo('/desglosar'),  // Go to Desglosar (P for Project)
    'g s': () => navigateTo('/stats'),      // Go to Stats

    // Actions (with Ctrl/Cmd)
    'ctrl+h': () => moveSelectedItemToList('hacer'),
    'ctrl+a': () => moveSelectedItemToList('agendar'),
    'ctrl+d': () => moveSelectedItemToList('delegar'),
    'ctrl+p': () => moveSelectedItemToList('desglosar'),
    'ctrl+n': () => moveSelectedItemToList('no-hacer'),

    // Search
    'ctrl+k': (e) => {
      e.preventDefault();
      openSearch();
    },

    // Focus on input
    '/': (e) => {
      e.preventDefault();
      focusOnNewItemInput();
    }
  };

  let keySequence = '';
  let sequenceTimer = null;

  document.addEventListener('keydown', (e) => {
    // Ignore if user is typing in an input/textarea
    if (e.target.matches('input, textarea, select')) {
      // Except for Ctrl+K (search) which should work anywhere
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        handleHotkey('ctrl+k', e);
      }
      return;
    }

    // Build key combination
    let key = '';

    if (e.ctrlKey || e.metaKey) {
      key = 'ctrl+' + e.key.toLowerCase();
    } else if (e.shiftKey) {
      key = 'shift+' + e.key.toLowerCase();
    } else {
      key = e.key.toLowerCase();
    }

    // Handle single key shortcuts
    if (HOTKEYS[key]) {
      handleHotkey(key, e);
      return;
    }

    // Handle key sequences (like "g d" for go to dashboard)
    clearTimeout(sequenceTimer);
    keySequence += key + ' ';

    // Check if sequence matches any hotkey
    const matchingKey = Object.keys(HOTKEYS).find(k =>
      k.includes(' ') && keySequence.trim() === k
    );

    if (matchingKey) {
      handleHotkey(matchingKey, e);
      keySequence = '';
    } else {
      // Reset sequence after 1 second
      sequenceTimer = setTimeout(() => {
        keySequence = '';
      }, 1000);
    }
  });

  function handleHotkey(key, event) {
    const action = HOTKEYS[key];
    if (action) {
      event.preventDefault();
      action(event);
    }
  }

  function navigateTo(path) {
    window.location.href = path;
  }

  function moveSelectedItemToList(listName) {
    // Find the currently selected/focused item
    const selectedItem = document.querySelector('.item-card.selected, .item-card:focus-within');

    if (!selectedItem) {
      if (window.UIHelpers) {
        window.UIHelpers.showToast('Selecciona una tarea primero', 'info');
      }
      return;
    }

    // Find the move button for that list
    const moveButton = selectedItem.querySelector(`button[data-destination="${listName}"]`);

    if (moveButton) {
      moveButton.click();
    } else {
      if (window.UIHelpers) {
        window.UIHelpers.showToast('No se puede mover a esa lista desde aquí', 'warning');
      }
    }
  }

  function openSearch() {
    // Open global search modal
    if (window.GlobalSearch) {
      window.GlobalSearch.open();
    } else {
      console.warn('Global search not loaded');
    }
  }

  function focusOnNewItemInput() {
    const input = document.querySelector('input[name="text"], textarea[name="text"]');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Show hotkey help on "?"
  document.addEventListener('keydown', (e) => {
    if (e.key === '?' && !e.target.matches('input, textarea')) {
      e.preventDefault();
      showHotkeyHelp();
    }
  });

  function showHotkeyHelp() {
    const helpHTML = `
      <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" id="hotkey-help">
        <div class="bg-white dark:bg-slate-800 rounded-lg p-6 max-w-2xl max-h-screen overflow-y-auto">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-2xl font-bold text-slate-900 dark:text-slate-100">⌨️ Atajos de Teclado</h2>
            <button onclick="document.getElementById('hotkey-help').remove()"
                    class="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
              ✕
            </button>
          </div>

          <div class="space-y-4">
            <div>
              <h3 class="font-semibold text-lg mb-2 text-slate-900 dark:text-slate-100">Navegación (presiona dos teclas)</h3>
              <div class="grid grid-cols-2 gap-2 text-sm">
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">g</kbd> + <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">d</kbd> = Dashboard</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">g</kbd> + <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">c</kbd> = Collect</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">g</kbd> + <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">h</kbd> = Hacer</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">g</kbd> + <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">a</kbd> = Agendar</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">g</kbd> + <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">l</kbd> = Delegar</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">g</kbd> + <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">p</kbd> = Desglosar</div>
              </div>
            </div>

            <div>
              <h3 class="font-semibold text-lg mb-2 text-slate-900 dark:text-slate-100">Mover Tareas (Ctrl/⌘ + tecla)</h3>
              <div class="grid grid-cols-2 gap-2 text-sm">
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">Ctrl+H</kbd> = Mover a Hacer</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">Ctrl+A</kbd> = Mover a Agendar</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">Ctrl+D</kbd> = Mover a Delegar</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">Ctrl+P</kbd> = Mover a Desglosar</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">Ctrl+N</kbd> = Mover a No hacer</div>
              </div>
            </div>

            <div>
              <h3 class="font-semibold text-lg mb-2 text-slate-900 dark:text-slate-100">Otras Acciones</h3>
              <div class="grid grid-cols-2 gap-2 text-sm">
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">/</kbd> = Enfocar input</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">Ctrl+K</kbd> = Búsqueda (próximo)</div>
                <div><kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded">?</kbd> = Mostrar esta ayuda</div>
              </div>
            </div>
          </div>

          <div class="mt-6 text-center">
            <button onclick="document.getElementById('hotkey-help').remove()"
                    class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              Cerrar
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', helpHTML);
  }

  console.log('⌨️ Hotkeys cargados. Presiona "?" para ver todos los atajos.');
})();
