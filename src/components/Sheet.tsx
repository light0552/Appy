import { useEffect, useRef, type ReactNode } from "react";

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * Shared modal sheet: focus moves in, Tab stays inside, Escape closes, and
 * focus returns to the trigger. The visual shell lives in styles.css.
 */
export default function Sheet({ title, onClose, children, className }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const sheet = sheetRef.current;
    const focusables = () =>
      sheet
        ? Array.from(
            sheet.querySelectorAll<HTMLElement>("input, button, [tabindex]"),
          ).filter((el) => !el.hasAttribute("disabled"))
        : [];

    const firstFocusable = focusables()[0];
    if (firstFocusable) firstFocusable.focus();
    else sheet?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && sheet?.contains(active);
      if (event.shiftKey) {
        if (active === first || !inside) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !inside) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      if (restore && restore.isConnected) restore.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className={`sheet${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
