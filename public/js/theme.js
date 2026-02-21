/**
 * Sistema de Dark Mode para GTD_Neto
 */

class ThemeManager {
  constructor() {
    this.theme = this.getStoredTheme() || this.getPreferredTheme();
    this.init();
  }

  init() {
    this.applyTheme(this.theme);
    this.createToggle();
  }

  getStoredTheme() {
    return localStorage.getItem('gtd-theme');
  }

  getPreferredTheme() {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  applyTheme(theme) {
    this.theme = theme;
    const html = document.documentElement;

    if (theme === 'dark') {
      html.classList.add('dark');
    } else {
      html.classList.remove('dark');
    }

    localStorage.setItem('gtd-theme', theme);
  }

  toggle() {
    const newTheme = this.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme(newTheme);
    this.updateToggleButton();
  }

  createToggle() {
    // If a toggle button already exists in the DOM (injected by layout), use it
    const existing = document.getElementById('theme-toggle');
    if (existing) {
      existing.innerHTML = this.theme === 'dark' ? '☀️' : '🌙';
      existing.addEventListener('click', () => { this.toggle(); });
      return;
    }

    // Fallback: create floating button (used on pages without main nav)
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'theme-toggle';
    toggleBtn.className = 'fixed right-4 p-3 rounded-full bg-white dark:bg-slate-800 border dark:border-slate-700 shadow-lg hover:shadow-xl transition-shadow transition-colors z-40';
    toggleBtn.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 1rem)';
    toggleBtn.setAttribute('aria-label', 'Cambiar tema');
    toggleBtn.innerHTML = this.theme === 'dark' ? '☀️' : '🌙';

    toggleBtn.addEventListener('click', () => {
      this.toggle();
    });

    document.body.appendChild(toggleBtn);
  }

  updateToggleButton() {
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = this.theme === 'dark' ? '☀️' : '🌙';
    }
  }
}

// Inicializar el theme manager
document.addEventListener('DOMContentLoaded', () => {
  window.themeManager = new ThemeManager();
});
