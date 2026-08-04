type Props = {
  size?: number
  /** Spins and pulses — used as the thinking indicator. */
  busy?: boolean
  className?: string
}

let seed = 0

/**
 * The app mark, matching build/icon-source.png: a prompt chevron beside a
 * glowing caret bar on near-black.
 *
 * Drawn as SVG rather than shown from the PNG so it stays sharp at 14px in the
 * title bar and can animate without a second asset.
 */
export default function BrandMark({ size = 16, busy = false, className }: Props) {
  // Gradient and filter ids must be unique per instance or the first one on the
  // page wins for all of them.
  const id = `mark-${(seed += 1)}`

  return (
    <svg
      className={`brand-svg ${busy ? 'busy' : ''} ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="115" fill="#0a0a0a" />

      <g filter={`url(#${id}-glow)`}>
        <path
          d="M96 162 L174 222 L96 282"
          stroke={`url(#${id}-grad)`}
          strokeWidth="30"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <rect x="196" y="296" width="220" height="26" rx="13" fill="#ffffff" />
      </g>

      <defs>
        <linearGradient id={`${id}-grad`} x1="96" y1="162" x2="200" y2="300">
          <stop stopColor="#f2f2f2" />
          <stop offset="1" stopColor="#c9c9c9" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="10" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  )
}
