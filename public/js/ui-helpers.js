/**
 * UI Helpers - Toast notifications and loading states
 */

// Toast notification helper
function showToast(message, type = 'success') {
  const backgroundColor = {
    success: 'linear-gradient(to right, #00b09b, #96c93d)',
    error: 'linear-gradient(to right, #ff5f6d, #ffc371)',
    info: 'linear-gradient(to right, #2563eb, #3b82f6)',
    warning: 'linear-gradient(to right, #f59e0b, #fbbf24)'
  };

  if (typeof Toastify !== 'undefined') {
    Toastify({
      text: message,
      duration: 3000,
      gravity: 'top',
      position: 'right',
      style: {
        background: backgroundColor[type] || backgroundColor.info
      },
      stopOnFocus: true
    }).showToast();
  }
}

// Loading state helper
function setLoadingState(element, isLoading) {
  if (!element) return;

  if (isLoading) {
    element.disabled = true;
    element.dataset.originalText = element.innerHTML;
    element.innerHTML = `
      <svg class="animate-spin h-4 w-4 inline-block mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      Procesando...
    `;
  } else {
    element.disabled = false;
    if (element.dataset.originalText) {
      element.innerHTML = element.dataset.originalText;
      delete element.dataset.originalText;
    }
  }
}

// Show loading overlay
function showLoadingOverlay(message = 'Cargando...') {
  const overlay = document.createElement('div');
  overlay.id = 'loading-overlay';
  overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
  overlay.innerHTML = `
    <div class="bg-white dark:bg-slate-800 rounded-lg p-6 flex flex-col items-center">
      <svg class="animate-spin h-10 w-10 text-blue-600 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <p class="text-slate-900 dark:text-slate-100">${message}</p>
    </div>
  `;
  document.body.appendChild(overlay);
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.remove();
  }
}

// Export for use in other scripts
window.UIHelpers = {
  showToast,
  setLoadingState,
  showLoadingOverlay,
  hideLoadingOverlay
};
