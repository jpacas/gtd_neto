/**
 * Sistema de notificaciones Toast para GTD_Neto
 */

class ToastManager {
  constructor() {
    this.container = null;
    this.init();
  }

  init() {
    // Crear contenedor si no existe
    if (!document.getElementById('toast-container')) {
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      this.container.className = 'fixed top-4 right-4 z-50 space-y-2';
      document.body.appendChild(this.container);
    } else {
      this.container = document.getElementById('toast-container');
    }
  }

  show(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} transform translate-x-full opacity-0 transition-all duration-300 ease-out`;

    const colors = {
      success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
      error: 'bg-red-50 border-red-200 text-red-800',
      warning: 'bg-amber-50 border-amber-200 text-amber-800',
      info: 'bg-blue-50 border-blue-200 text-blue-800',
    };

    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ',
    };

    const wrap = document.createElement('div');
    wrap.className = `${colors[type] || colors.info} px-4 py-3 rounded-lg border shadow-lg flex items-center gap-2 min-w-[300px] max-w-md`;

    const icon = document.createElement('span');
    icon.className = 'text-lg font-semibold';
    icon.textContent = icons[type] || icons.info;

    const text = document.createElement('span');
    text.className = 'text-sm flex-1';
    text.textContent = String(message || '');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close text-lg hover:opacity-70';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.textContent = '×';

    wrap.append(icon, text, closeBtn);
    toast.appendChild(wrap);

    this.container.appendChild(toast);

    // Animación de entrada
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.remove('translate-x-full', 'opacity-0');
      });
    });

    // Botón cerrar
    closeBtn.addEventListener('click', () => this.hide(toast));

    // Auto-hide
    if (duration > 0) {
      setTimeout(() => this.hide(toast), duration);
    }

    return toast;
  }

  hide(toast) {
    toast.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }

  success(message, duration) {
    return this.show(message, 'success', duration);
  }

  error(message, duration) {
    return this.show(message, 'error', duration);
  }

  warning(message, duration) {
    return this.show(message, 'warning', duration);
  }

  info(message, duration) {
    return this.show(message, 'info', duration);
  }
}

// Instancia global
window.toast = new ToastManager();
