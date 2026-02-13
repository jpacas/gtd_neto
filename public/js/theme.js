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
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'theme-toggle';
    toggleBtn.className = 'fixed bottom-4 right-4 p-3 rounded-full bg-white dark:bg-slate-800 border dark:border-slate-700 shadow-lg hover:shadow-xl transition-all z-40';
    toggleBtn.setAttribute('aria-label', 'Toggle dark mode');
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
