/**
 * Command Palette — GTD Neto
 * Vanilla JS, no dependencies. Opens with Cmd+K or Ctrl+K.
 */
(function () {
  'use strict';

  const COMMANDS = [
    { id: 'go-dashboard', label: 'Ir a Dashboard', icon: '🧭', action: () => { window.location.href = '/'; } },
    { id: 'go-collect', label: 'Ir a Collect', icon: '📥', action: () => { window.location.href = '/collect'; } },
    { id: 'go-hacer', label: 'Ir a Hacer', icon: '✅', action: () => { window.location.href = '/hacer'; } },
    { id: 'go-agendar', label: 'Ir a Agendar', icon: '🗓️', action: () => { window.location.href = '/agendar'; } },
    { id: 'go-delegar', label: 'Ir a Delegar', icon: '🤝', action: () => { window.location.href = '/delegar'; } },
    { id: 'go-desglosar', label: 'Ir a Desglosar', icon: '🧩', action: () => { window.location.href = '/desglosar'; } },
    { id: 'go-someday', label: 'Ir a Algún Día', icon: '⭐', action: () => { window.location.href = '/someday'; } },
    { id: 'go-nohacer', label: 'Ir a No hacer', icon: '🚫', action: () => { window.location.href = '/no-hacer'; } },
    { id: 'go-terminado', label: 'Ir a Terminado', icon: '🎯', action: () => { window.location.href = '/terminado'; } },
    { id: 'go-stats', label: 'Ver Estadísticas', icon: '📈', action: () => { window.location.href = '/stats'; } },
    { id: 'go-weekly', label: 'Revisión Semanal', icon: '🔄', action: () => { window.location.href = '/weekly-review'; } },
    { id: 'go-settings', label: 'Configuración', icon: '⚙️', action: () => { window.location.href = '/settings'; } },
    { id: 'go-export', label: 'Exportar datos', icon: '💾', action: () => { window.location.href = '/export'; } },
    { id: 'toggle-theme', label: 'Cambiar tema', icon: '🌙', action: () => {
      const btn = document.getElementById('theme-toggle');
      if (btn) btn.click();
    }},
    { id: 'focus-collect', label: 'Captura rápida', icon: '✏️', action: () => {
      const fab = document.getElementById('fab-capture');
      if (fab) fab.click();
    }},
  ];

  let overlay = null;
  let box = null;
  let inputEl = null;
  let listEl = null;
  let activeIdx = 0;
  let filtered = [...COMMANDS];

  function buildPalette() {
    overlay = document.createElement('div');
    overlay.className = 'cmd-palette-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Búsqueda de comandos');

    box = document.createElement('div');
    box.className = 'cmd-palette-box';

    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'cmd-palette-input';
    inputEl.placeholder = 'Buscar comando…';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('spellcheck', 'false');

    listEl = document.createElement('ul');
    listEl.className = 'max-h-72 overflow-y-auto py-1';
    listEl.setAttribute('role', 'listbox');

    box.appendChild(inputEl);
    box.appendChild(listEl);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    inputEl.addEventListener('input', () => {
      const q = inputEl.value.trim().toLowerCase();
      filtered = q ? COMMANDS.filter(c => c.label.toLowerCase().includes(q)) : [...COMMANDS];
      activeIdx = 0;
      renderList();
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); execActive(); }
      else if (e.key === 'Escape') { close(); }
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    renderList();
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!filtered.length) {
      const li = document.createElement('li');
      li.className = 'px-4 py-3 text-sm text-surface-400 text-center';
      li.textContent = 'Sin resultados';
      listEl.appendChild(li);
      return;
    }
    filtered.forEach((cmd, i) => {
      const li = document.createElement('li');
      li.className = i === activeIdx ? 'cmd-palette-item-active' : 'cmd-palette-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === activeIdx));
      li.innerHTML = `<span class="text-lg w-6 text-center shrink-0">${cmd.icon}</span><span>${cmd.label}</span>`;
      li.addEventListener('click', () => { activeIdx = i; execActive(); });
      li.addEventListener('mouseenter', () => { activeIdx = i; renderList(); });
      listEl.appendChild(li);
    });
    // Scroll active into view
    const activeLi = listEl.children[activeIdx];
    if (activeLi) activeLi.scrollIntoView({ block: 'nearest' });
  }

  function execActive() {
    const cmd = filtered[activeIdx];
    if (cmd) { close(); cmd.action(); }
  }

  function open() {
    if (!overlay) buildPalette();
    overlay.classList.remove('hidden');
    filtered = [...COMMANDS];
    activeIdx = 0;
    inputEl.value = '';
    renderList();
    setTimeout(() => inputEl.focus(), 10);
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // Keyboard shortcut: Cmd+K / Ctrl+K
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (overlay && !overlay.classList.contains('hidden')) {
        close();
      } else {
        open();
      }
    }
  });

  // Toolbar button
  const btn = document.getElementById('cmd-palette-btn');
  if (btn) btn.addEventListener('click', open);
})();
