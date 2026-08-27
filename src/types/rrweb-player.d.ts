// rrweb-player 0.7.x liefert keine eigenen Typdefinitionen —
// minimale Deklaration fuer den Session-Replay-Player in WebAnalytics.
declare module 'rrweb-player' {
  interface RRWebPlayerProps {
    events: unknown[]
    width?: number
    height?: number
    autoPlay?: boolean
    showController?: boolean
    speedOption?: number[]
    skipInactive?: boolean
  }
  export default class rrwebPlayer {
    constructor(options: { target: HTMLElement; props: RRWebPlayerProps })
    play(): void
    pause(): void
    $destroy(): void
  }
}
