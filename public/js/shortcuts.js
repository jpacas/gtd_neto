/**
 * Sistema de Keyboard Shortcuts para GTD_Neto
 */

class ShortcutManager {
  constructor() {
    this.shortcuts = {
      'g d': { action: () => window.location.href = '/', description: 'Ir al Dashboard' },
      'g c': { action: () => window.location.href = '/collect', description: 'Ir a Collect' },
      'g h': { action: () => window.location.href = '/hacer', description: 'Ir a Hacer' },
      'g a': { action: () => window.location.href = '/agendar', description: 'Ir a Agendar' },
      'g l': { action: () => window.location.href = '/delegar', description: 'Ir a Delegar' },
      'g p': { action: () => window.location.href = '/desglosar', description: 'Ir a Desglosar (Projects)' },
      'g t': { action: () => window.location.href = '/terminado', description: 'Ir a Terminado' },
      'g s': { action: () => window.location.href = '/search', description: 'Ir a Búsqueda' },
      'g e': { action: () => window.location.href = '/stats', description: 'Ir a Estadísticas' },
      '?': { action: () => this.showHelp(), description: 'Mostrar atajos de teclado' },
    };

    this.sequence = '';
    this.sequenceTimeout = null;
    this.helpShown = false;

    this.init();
  }

  init() {
    document.addEventListener('keydown', (e) => {
      // Ignorar si está en un input/textarea
      if (e.target.matches('input, textarea, select')) return;

      // ESC para cerrar help
      if (e.key === 'Escape' && this.helpShown) {
        this.hideHelp();
        return;
      }

      // Acumular secuencia
      this.sequence += e.key.toLowerCase();

      // Clear timeout anterior
      if (this.sequenceTimeout) clearTimeout(this.sequenceTimeout);

      // Buscar match
      const match = Object.keys(this.shortcuts).find(key => {
        return this.sequence.endsWith(key);
      });

      if (match) {
        e.preventDefault();
        this.shortcuts[match].action();
        this.sequence = '';
      } else {
        // Reset después de 1 segundo sin teclas
        this.sequenceTimeout = setTimeout(() => {
          this.sequence = '';
        }, 1000);
      }
    });
  }

  showHelp() {
    if (this.helpShown) return;

    const modal = document.createElement('div');
    modal.id = 'shortcuts-modal';
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4';
    modal.innerHTML = `
      <div class="bg-white dark:bg-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold dark:text-slate-100">⌨️ Atajos de Teclado</h3>
          <button class="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300" onclick="window.shortcutManager.hideHelp()">✕</button>
        </div>
        <div class="space-y-2 max-h-96 overflow-y-auto">
          ${Object.entries(this.shortcuts).map(([key, data]) => `
            <div class="flex items-center justify-between py-2 border-b dark:border-slate-700 last:border-0">
              <span class="text-sm dark:text-slate-300">${data.description}</span>
              <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs font-mono">${key}</kbd>
            </div>
          `).join('')}
        </div>
        <div class="mt-4 text-xs text-slate-500 dark:text-slate-400 text-center">
          Presiona <kbd class="px-1 bg-slate-100 dark:bg-slate-700 rounded">ESC</kbd> para cerrar
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.helpShown = true;

    // Click fuera para cerrar
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.hideHelp();
      }
    });
  }

  hideHelp() {
    const modal = document.getElementById('shortcuts-modal');
    if (modal) {
      modal.remove();
      this.helpShown = false;
    }
  }
}

// Instancia global
document.addEventListener('DOMContentLoaded', () => {
  window.shortcutManager = new ShortcutManager();
});
