import { useMemo } from 'react'
import encodeQR from '@paulmillr/qr'

/** Modules of light around the code, as scanners want. */
const QUIET = 3

/**
 * `text` as a QR code: dark on rice, the way every scanner reads them, in a rounded tile that
 * fills its box.
 */
export function Qr({
  text,
  className = 'h-44 w-44'
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const { size, path } = useMemo(() => {
    const modules = encodeQR(text, 'raw', { ecc: 'medium', border: 0 })
    // each row's runs of dark modules, as one path
    let d = ''
    modules.forEach((row, y) => {
      for (let x = 0; x < row.length;) {
        if (!row[x]) {
          x++
          continue
        }
        const start = x
        while (x < row.length && row[x]) x++
        d += `M${start + QUIET} ${y + QUIET}h${x - start}v1h${start - x}z`
      }
    })
    return { size: modules.length + 2 * QUIET, path: d }
  }, [text])
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={`shrink-0 rounded-xl bg-rice shadow-[0_10px_30px_-14px_rgba(0,0,0,0.9)] ${className}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code: ${text}`}
    >
      <path d={path} fill="#11111b" />
    </svg>
  )
}
