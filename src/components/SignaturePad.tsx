import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'

// Unterschriftsfeld für Finger/Maus (Pointer Events). Liefert ein transparentes PNG.
// Bei Größenänderung (Drehen des Handys) wird das Feld geleert, weil sich die Fläche ändert.

// Kugelschreiber-Blau (keine Markenfarbe, wirkt wie echte Tinte)
const INK = '#1b2a6b'

export interface SignaturePadHandle {
  clear(): void
  toPng(): string
}

const SignaturePad = forwardRef<SignaturePadHandle, { onInk: (hasInk: boolean) => void; className?: string }>(
  function SignaturePad({ onInk, className }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    // nur EIN Finger zeichnet: ein zweiter Kontakt (Handballen) wird ignoriert
    const active = useRef<number | null>(null)
    const last = useRef<{ x: number; y: number } | null>(null)

    const setup = useCallback(() => {
      const c = canvasRef.current
      if (!c) return
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr)
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = INK; ctx.fillStyle = INK
      onInk(false)
    }, [onInk])

    useEffect(() => {
      setup()
      const c = canvasRef.current
      if (!c || typeof ResizeObserver === 'undefined') return
      let w = c.clientWidth
      const ro = new ResizeObserver(() => { if (c.clientWidth !== w) { w = c.clientWidth; setup() } })
      ro.observe(c)
      return () => ro.disconnect()
    }, [setup])

    useImperativeHandle(ref, () => ({
      clear: setup,
      toPng: () => canvasRef.current?.toDataURL('image/png') ?? '',
    }), [setup])

    const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (active.current !== null) return
      e.currentTarget.setPointerCapture(e.pointerId)
      active.current = e.pointerId
      last.current = pos(e)
      const ctx = e.currentTarget.getContext('2d')
      if (ctx) { ctx.beginPath(); ctx.arc(last.current.x, last.current.y, 1.1, 0, Math.PI * 2); ctx.fill() }
    }
    const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerId !== active.current || !last.current) return
      const ctx = e.currentTarget.getContext('2d')
      if (!ctx) return
      const p = pos(e)
      ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke()
      last.current = p
      onInk(true)
    }
    const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerId !== active.current) return
      active.current = null; last.current = null
    }

    return (
      <canvas ref={canvasRef}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className={className ?? 'w-full h-44 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 touch-none cursor-crosshair'} />
    )
  })

export default SignaturePad
