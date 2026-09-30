import { ICON_PATHS, type IconId } from './iconPaths'

interface IconProps {
  name: IconId
  // Kantenlänge in Pixeln (Breite = Höhe)
  size?: number
  className?: string
  strokeWidth?: number
  // Mit title wird das Icon für Screenreader benannt (role="img" + <title>),
  // ohne title ist es reine Dekoration (aria-hidden).
  title?: string
}

// Linien-Icon der App-Shell. Farbe kommt über currentColor aus der Textfarbe
// des Elternelements (z.B. className="text-hp-highlight").
export function Icon({ name, size = 20, className, strokeWidth = 1.75, title }: IconProps) {
  const paths: readonly string[] = ICON_PATHS[name]
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      focusable="false"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

export default Icon
export type { IconId }
