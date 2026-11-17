import { type ReactNode, type RefObject, useId, useRef } from 'react';
import { useI18n } from './I18n';
import { CloseIcon } from './Icons';
import { useDialog } from './useDialog';

/**
 * A modal dialog with the UI-9 classes (`.modal-backdrop`, `.modal-header`,
 * `.modal-close`, `.modal-scroll-region`) and the A11Y-2 behaviour from
 * `useDialog`. Its opener sets `aria-haspopup="dialog"` and `aria-expanded`.
 */
export function Dialog({
  title,
  eyebrow,
  description,
  onClose,
  initialFocusRef = null,
  returnFocusRef = null,
  className = '',
  role = 'dialog',
  closeLabel,
  children,
  footer,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  onClose(): void;
  initialFocusRef?: RefObject<HTMLElement | null> | null;
  /** Where focus returns if the opener lost focus before the dialog opened (A11Y-2). */
  returnFocusRef?: RefObject<HTMLElement | null> | null;
  className?: string;
  role?: 'dialog' | 'alertdialog';
  /** The close button's label; "Close" in the reader's language by default. */
  closeLabel?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const close = closeLabel ?? t.dialog.close;
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLElement>(null);
  useDialog(dialog, initialFocusRef, onClose, returnFocusRef);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialog}
        className={`modal-dialog ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="button button-icon modal-close" type="button" onClick={onClose} aria-label={close} title={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="modal-scroll-region">
          {description && <p id={descriptionId} className="modal-description">{description}</p>}
          {children}
        </div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

/** Asks before an action that cannot be undone, in place of `window.confirm`. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
  children?: ReactNode;
}) {
  // The safe choice gets the initial focus, so Enter never confirms by accident.
  const cancel = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();
  return (
    <Dialog
      title={title}
      description={description}
      onClose={() => { if (!busy) onCancel(); }}
      initialFocusRef={cancel}
      role="alertdialog"
      className="confirm-dialog"
      footer={(
        <>
          <button className={`button ${danger ? 'button-danger' : 'button-primary'}`} type="button" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
          <button ref={cancel} className="button button-secondary" type="button" disabled={busy} onClick={onCancel}>{cancelLabel ?? t.common.cancel}</button>
        </>
      )}
    >
      {children}
    </Dialog>
  );
}
