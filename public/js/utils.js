/**
 * Utilidades comunes para GTD_Neto
 */

// Loading state manager
const LoadingManager = {
  spinnerHTML: `
    <svg class="animate-spin h-4 w-4 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  `,

  show(button, saveText = true) {
    if (saveText) {
      button.dataset.originalText = button.innerHTML;
    }
    button.disabled = true;
    button.innerHTML = `${this.spinnerHTML} Cargando...`;
    button.classList.add('opacity-70', 'cursor-not-allowed');
  },

  hide(button) {
    button.disabled = false;
    button.innerHTML = button.dataset.originalText || button.innerHTML.replace(this.spinnerHTML, '').replace('Cargando...', '').trim();
    button.classList.remove('opacity-70', 'cursor-not-allowed');
  }
};

// Confirmación con estilo
function confirmAction(message, onConfirm, onCancel) {
  if (confirm(message)) {
    if (onConfirm) onConfirm();
    return true;
  } else {
    if (onCancel) onCancel();
    return false;
  }
}

function promptModal({ title = 'Ingresar valor', defaultValue = '', placeholder = '', allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const panel = document.createElement('div');
    panel.className = 'w-full max-w-md rounded-xl border dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-2xl';

    const heading = document.createElement('h3');
    heading.className = 'text-sm font-semibold mb-3 dark:text-slate-100';
    heading.textContent = title;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'w-full border dark:border-slate-700 dark:bg-slate-900 rounded-lg px-3 py-2 text-sm';
    input.value = String(defaultValue || '');
    input.placeholder = placeholder;

    const actions = document.createElement('div');
    actions.className = 'mt-3 flex justify-end gap-2';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'px-3 py-1.5 text-sm rounded-lg border dark:border-slate-700';
    cancel.textContent = 'Cancelar';

    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white';
    accept.textContent = 'Aceptar';

    actions.append(cancel, accept);
    panel.append(heading, input, actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const close = (value) => {
      overlay.remove();
      resolve(value);
    };

    cancel.addEventListener('click', () => close(null));
    accept.addEventListener('click', () => {
      const val = String(input.value || '').trim();
      if (!allowEmpty && !val) return;
      close(val);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') {
        e.preventDefault();
        accept.click();
      }
    });

    input.focus();
    input.select();
  });
}

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Helpers de validación
const Validators = {
  email(value) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(value);
  },

  notEmpty(value) {
    return value && value.trim().length > 0;
  },

  minLength(value, min) {
    return value && value.trim().length >= min;
  },

  maxLength(value, max) {
    return value && value.trim().length <= max;
  },

  isDate(value) {
    return value && !isNaN(Date.parse(value));
  },

  inRange(value, min, max) {
    const num = Number(value);
    return !isNaN(num) && num >= min && num <= max;
  }
};

// Helper para forms con validación
function setupFormValidation(formId, rules) {
  const form = document.getElementById(formId);
  if (!form) return;

  const fields = Object.keys(rules);

  fields.forEach(fieldName => {
    const input = form.querySelector(`[name="${fieldName}"]`);
    if (!input) return;

    const rule = rules[fieldName];

    // Validar on blur
    input.addEventListener('blur', () => {
      validateField(input, rule);
    });

    // Validar on input (con debounce)
    if (rule.validateOnInput) {
      input.addEventListener('input', debounce(() => {
        validateField(input, rule);
      }, 300));
    }
  });

  // Validar on submit
  form.addEventListener('submit', (e) => {
    let isValid = true;

    fields.forEach(fieldName => {
      const input = form.querySelector(`[name="${fieldName}"]`);
      if (!input) return;

      if (!validateField(input, rules[fieldName])) {
        isValid = false;
      }
    });

    if (!isValid) {
      e.preventDefault();
      toast.error('Por favor corrige los errores en el formulario');
    }
  });
}

function bindAutoLoadingToPostForms() {
  document.querySelectorAll('form').forEach((form) => {
    if (form.dataset.autoLoadingBound === '1') return;
    if (String(form.method || '').toUpperCase() !== 'POST') return;
    if (form.dataset.autoLoading === 'off') return;

    form.dataset.autoLoadingBound = '1';
    form.addEventListener('submit', () => {
      const submitBtn = form.querySelector('button[type="submit"], button:not([type])');
      if (submitBtn) LoadingManager.show(submitBtn);
    });
  });
}

function validateField(input, rule) {
  const value = input.value;
  let errorMessage = '';

  // Ejecutar validadores
  if (rule.required && !Validators.notEmpty(value)) {
    errorMessage = rule.requiredMessage || 'Este campo es requerido';
  } else if (rule.email && value && !Validators.email(value)) {
    errorMessage = rule.emailMessage || 'Email inválido';
  } else if (rule.minLength && !Validators.minLength(value, rule.minLength)) {
    errorMessage = rule.minLengthMessage || `Mínimo ${rule.minLength} caracteres`;
  } else if (rule.maxLength && !Validators.maxLength(value, rule.maxLength)) {
    errorMessage = rule.maxLengthMessage || `Máximo ${rule.maxLength} caracteres`;
  } else if (rule.custom) {
    const customResult = rule.custom(value);
    if (customResult !== true) {
      errorMessage = customResult;
    }
  }

  // Mostrar/ocultar error
  const errorEl = input.parentElement.querySelector('.field-error');

  if (errorMessage) {
    input.classList.add('border-red-300', 'focus:border-red-500');
    input.classList.remove('border-slate-300');

    if (errorEl) {
      errorEl.textContent = errorMessage;
    } else {
      const error = document.createElement('div');
      error.className = 'field-error text-xs text-red-600 mt-1';
      error.textContent = errorMessage;
      input.parentElement.appendChild(error);
    }

    return false;
  } else {
    input.classList.remove('border-red-300', 'focus:border-red-500');
    input.classList.add('border-slate-300');

    if (errorEl) {
      errorEl.remove();
    }

    return true;
  }
}

// Exportar al scope global
window.LoadingManager = LoadingManager;
window.confirmAction = confirmAction;
window.promptModal = promptModal;
window.debounce = debounce;
window.Validators = Validators;
window.setupFormValidation = setupFormValidation;
window.validateField = validateField;
window.bindAutoLoadingToPostForms = bindAutoLoadingToPostForms;

document.addEventListener('DOMContentLoaded', () => {
  bindAutoLoadingToPostForms();
});
