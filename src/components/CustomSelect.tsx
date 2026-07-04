/**
 * CustomSelect — Ersetzt native <select>-Elemente im gesamten Projekt.
 *
 * Merkmale:
 * - Vollständig gestaltet mit Tailwind (kein appearance-none-Hack)
 * - Optionaler „hint"-Text pro Option (kleine graue Zeile)
 * - Smooth-Open-Animation
 * - Schließt beim Klick außerhalb und bei Escape
 * - Unterstützt disabled-State
 * - style-Prop für focus-ring-Farben (kompatibel mit vorhandenem focusRing())
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

export interface SelectOption {
  value: string
  label: string
  hint?: string          // optional: zweite Zeile in grau
  disabled?: boolean
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
  style?: React.CSSProperties
}

export function CustomSelect({
  value,
  onChange,
  options,
  placeholder,
  className = '',
  disabled = false,
  style,
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef      = useRef<HTMLDivElement>(null)

  const resolvedPlaceholder = placeholder ?? t('customSelect.selectPlaceholder', '– Auswählen –')

  const selected = options.find(o => o.value === value)

  // Schließen bei Klick außerhalb
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Schließen bei Escape
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
  }, [])

  // Gewählte Option in Sicht scrollen
  useEffect(() => {
    if (!open || !listRef.current) return
    const active = listRef.current.querySelector('[data-selected="true"]') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest' })
  }, [open])

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      onKeyDown={onKeyDown}
    >
      {/* Trigger-Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        style={style}
        className={`
          w-full flex items-center justify-between gap-2
          px-4 py-2.5 rounded-xl border text-sm font-body text-left
          bg-white transition-all duration-150
          ${disabled
            ? 'opacity-50 cursor-not-allowed border-gray-200 text-gray-400'
            : open
              ? 'border-[var(--color-highlight)] ring-2 ring-[var(--color-highlight)]/20 text-hp-black'
              : 'border-gray-200 hover:border-gray-300 text-hp-black'}
        `}
      >
        <span className={`truncate ${!selected ? 'text-gray-400' : ''}`}>
          {selected ? selected.label : resolvedPlaceholder}
        </span>
        {/* Chevron */}
        <svg
          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200
                      ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
        >
          <path fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0
               111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0
               01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Dropdown-Panel */}
      {open && (
        <div
          ref={listRef}
          className="
            absolute z-50 mt-1.5 w-full min-w-[10rem]
            bg-white border border-gray-100 rounded-2xl
            shadow-xl shadow-black/10
            overflow-y-auto max-h-64
            origin-top
            animate-[dropdownOpen_120ms_ease-out_forwards]
          "
          style={{ animationFillMode: 'forwards' }}
        >
          {options.length === 0 && (
            <p className="px-4 py-3 text-sm text-gray-400 font-body">{t('customSelect.noOptions', 'Keine Optionen')}</p>
          )}
          {options.map(opt => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                data-selected={isSelected}
                disabled={opt.disabled}
                onClick={() => { onChange(opt.value); setOpen(false) }}
                className={`
                  w-full flex flex-col items-start px-4 py-2.5 text-sm font-body
                  text-left transition-colors duration-100
                  ${opt.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                  ${isSelected
                    ? 'bg-[var(--color-highlight)]/8 text-[var(--color-highlight)]'
                    : 'text-hp-black hover:bg-gray-50'}
                `}
              >
                <span className="font-medium leading-snug">{opt.label}</span>
                {opt.hint && (
                  <span className="text-xs text-gray-400 mt-0.5 leading-snug">{opt.hint}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
