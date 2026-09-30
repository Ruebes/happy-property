import { useTranslation } from 'react-i18next'

export type SpinnerSize = 'sm' | 'md' | 'lg'

interface SpinnerProps {
  size?: SpinnerSize
  // Text für Screenreader; ohne Angabe "Wird geladen"
  label?: string
  className?: string
}

const SIZES: Record<SpinnerSize, string> = {
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-10 w-10 border-[3px]',
}

// Lade-Ring: blasser Navy-Ring mit einem Korall-Segment, das umläuft.
export default function Spinner({ size = 'md', label, className = '' }: SpinnerProps) {
  const { t } = useTranslation()
  return (
    <span role="status" className={`inline-flex items-center justify-center ${className}`}>
      <span
        aria-hidden="true"
        className={`block animate-spin rounded-full border-hp-navy/15 border-t-hp-highlight motion-reduce:animate-[spin_2.5s_linear_infinite] ${SIZES[size]}`}
      />
      <span className="sr-only">{label ?? t('ui.spinner.loading')}</span>
    </span>
  )
}
