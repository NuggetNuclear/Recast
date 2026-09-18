// Toasts, modals and the side drawer.
import { h, $ } from './util.js';
import { icon } from './icons.js';

export function toast(message, { type = 'info', timeout = 4200 } = {}) {
  const el = h('div.toast', { class: type, role: type === 'error' ? 'alert' : 'status' }, icon(type === 'error' ? 'alert' : 'check'), h('span', message));
  $('#toasts').append(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  setTimeout(close, timeout);
  el.addEventListener('click', close);
}

const stack = [];

function trapKeys(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); top.close(); }
  if (e.key === 'Tab') {
    const focusables = [...top.el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
document.addEventListener('keydown', trapKeys);

function layer(el, backdrop, onClose) {
  const previous = document.activeElement;
  const entry = {
    el,
    close() {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      el.remove();
      backdrop?.remove();
      if (!stack.length) document.body.style.overflow = '';
      onClose?.();
      previous?.focus?.({ preventScroll: true });
    },
  };
  stack.push(entry);
  document.body.style.overflow = 'hidden';
  return entry;
}

/** A centred modal. Returns { close, body, foot }. */
export function modal({ title, subtitle, body, actions = [], size = '', onClose }) {
  const bodyEl = h('div.modal-body', body);
  const foot = actions.length ? h('div.modal-foot', actions) : null;
  const closeBtn = h('button.icon-btn.close', { type: 'button', 'aria-label': 'Close' }, icon('x'));
  const box = h('div.modal', { class: size, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('div', h('h2', title), subtitle ? h('p', subtitle) : null), closeBtn), bodyEl, foot);
  const backdrop = h('div.backdrop');
  const wrap = h('div.modal-wrap', box);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) entry.close(); });
  document.body.append(backdrop, wrap);
  const entry = layer(wrap, backdrop, onClose);
  closeBtn.addEventListener('click', () => entry.close());
  setTimeout(() => (box.querySelector('input, select, textarea') || closeBtn).focus(), 20);
  return { close: entry.close, body: bodyEl, foot, el: box };
}

/** A right-hand drawer. */
export function drawer({ title, subtitle, head, body, actions = [], onClose }) {
  const closeBtn = h('button.icon-btn.close', { type: 'button', 'aria-label': 'Close' }, icon('x'));
  const bodyEl = h('div.drawer-body', body);
  const el = h('aside.drawer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.drawer-head', h('div', { style: { minWidth: 0 } }, h('h2', title), subtitle ? h('div.sub', subtitle) : null, head), closeBtn),
    bodyEl,
    actions.length ? h('div.drawer-foot', actions) : null);
  const backdrop = h('div.backdrop');
  backdrop.addEventListener('click', () => entry.close());
  document.body.append(backdrop, el);
  const entry = layer(el, backdrop, onClose);
  closeBtn.addEventListener('click', () => entry.close());
  setTimeout(() => closeBtn.focus(), 20);
  return { close: entry.close, body: bodyEl, el };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Could not copy', { type: 'error' });
  }
}
