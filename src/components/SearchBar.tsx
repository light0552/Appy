import { useEffect, useRef, useState } from "react";

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** 0 to disable debouncing in the consumer. */
  delay?: number;
}

export default function SearchBar({
  value,
  onChange,
  placeholder = "Search movies and TV",
  autoFocus = false,
  delay = 300,
}: SearchBarProps) {
  const timer = useRef<number | null>(null);
  // Controlled text so the visible query can never drift from the active one.
  const [text, setText] = useState(value);

  // Sync when the parent sets the value externally (e.g. a picked chip).
  useEffect(() => setText(value), [value]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const commit = (next: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange(next), delay);
  };

  /** Commit immediately, cancelling any pending debounce (Enter, Clear). */
  const submit = (next: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    onChange(next);
  };

  return (
    <label className="field" style={{ minHeight: 48 }}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
        style={{ color: "var(--muted)", flex: "0 0 auto" }}
      >
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" strokeLinecap="round" />
      </svg>

      <input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        aria-label="Search"
        onChange={(event) => {
          setText(event.target.value);
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setText(event.currentTarget.value);
            submit(event.currentTarget.value);
          }
        }}
      />

      {text && (
        <button
          type="button"
          className="icon-btn icon-btn--bare"
          aria-label="Clear search"
          style={{ width: 44, height: 44, marginRight: -6 }}
          onClick={() => {
            setText("");
            submit("");
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </label>
  );
}
