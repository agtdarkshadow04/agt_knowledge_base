import { type RefObject, useEffect, useRef } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** The elements inside `container` that Tab can reach, in document order. */
export function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => !element.closest('[hidden], [inert]'));
}

/**
 * The one dialog behaviour (A11Y-2): sets the initial focus, traps Tab inside
 * the dialog, closes on Escape, locks page scroll and, when the dialog closes,
 * returns focus to the element that opened it. The dialog element itself
 * carries `role="dialog"`, `aria-modal="true"` and `aria-labelledby`.
 *
 * `onClose` may change on every render: the hook always calls the latest one.
 */
export function useDialog(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null> | null,
  onClose: () => void,
  /** Where focus returns when the opener lost focus before the dialog opened (it was disabled meanwhile, for example). */
  returnFocusRef: RefObject<HTMLElement | null> | null = null,
) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const opener = active ?? returnFocusRef?.current ?? null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (initialFocusRef?.current ?? focusableElements(dialog)[0] ?? dialog).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (!dialog) return;
      if (event.key === 'Escape') {
        // A nested dialog (for example the editor's own popovers) handles its own Escape.
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    dialog.addEventListener('keydown', onKeyDown);
    // Escape from focus that left the dialog (a click on the backdrop) still closes it.
    function onDocumentKeyDown(event: KeyboardEvent) {
      if (!dialog?.contains(event.target as Node)) onKeyDown(event);
    }
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [dialogRef, initialFocusRef, returnFocusRef]);
}
