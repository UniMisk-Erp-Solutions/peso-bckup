/**
 * MaintenanceIllustration — an ORIGINAL, locally-bundled SVG illustration
 * for the public maintenance screen. No remote GIF, no third-party CDN, no
 * copyrighted character — the maintenance page must render identically
 * whether or not any external asset host is reachable, which is the whole
 * point of a maintenance page. See
 * docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §35.
 *
 * A small, friendly character sitting beside a laptop with a wrench,
 * gently "waiting". Motion is a subtle CSS animation (float + a slow clock
 * pulse) applied only under `prefers-reduced-motion: no-preference` — the
 * component renders fully static, with no visual change, when the visitor
 * has reduced motion enabled.
 */
export function MaintenanceIllustration() {
  return (
    <div className="maintenance-illustration" aria-hidden="true">
      <style>{`
        .maintenance-illustration .float-group,
        .maintenance-illustration .wrench-group,
        .maintenance-illustration .blink {
          animation: none;
        }
        @media (prefers-reduced-motion: no-preference) {
          .maintenance-illustration .float-group {
            animation: maintenance-float 3.2s ease-in-out infinite;
            transform-origin: center;
          }
          .maintenance-illustration .wrench-group {
            animation: maintenance-wrench 2.4s ease-in-out infinite;
            transform-origin: 132px 96px;
          }
          .maintenance-illustration .blink {
            animation: maintenance-blink 4.5s ease-in-out infinite;
            transform-origin: center;
          }
        }
        @keyframes maintenance-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes maintenance-wrench {
          0%, 100% { transform: rotate(-8deg); }
          50% { transform: rotate(8deg); }
        }
        @keyframes maintenance-blink {
          0%, 92%, 100% { transform: scaleY(1); }
          96% { transform: scaleY(0.1); }
        }
      `}</style>
      <svg
        viewBox="0 0 200 160"
        width="200"
        height="160"
        role="img"
        aria-label="A friendly character waiting beside a laptop while PesoWise is under maintenance"
      >
        {/* Ground shadow */}
        <ellipse cx="100" cy="146" rx="62" ry="7" className="fill-muted" opacity="0.5" />

        <g className="float-group">
          {/* Laptop */}
          <g>
            <rect x="118" y="108" width="46" height="30" rx="3" className="fill-muted-foreground/20" />
            <rect x="122" y="112" width="38" height="22" rx="1.5" className="fill-background" />
            <rect x="112" y="136" width="58" height="6" rx="2" className="fill-muted-foreground/30" />
          </g>

          {/* Character body */}
          <g>
            {/* Legs, sitting cross-legged */}
            <path
              d="M62 132 Q80 142 100 132 Q88 138 74 138 Q64 138 62 132 Z"
              className="fill-amber-700/70 dark:fill-amber-600/60"
            />
            {/* Body */}
            <rect x="58" y="86" width="44" height="46" rx="18" className="fill-amber-500 dark:fill-amber-500/90" />
            {/* Head */}
            <circle cx="80" cy="70" r="22" className="fill-amber-200 dark:fill-amber-200/90" />
            {/* Simple hair */}
            <path
              d="M58 66 Q60 46 80 46 Q100 46 102 66 Q90 58 80 58 Q70 58 58 66 Z"
              className="fill-amber-900/70 dark:fill-amber-900/60"
            />
            {/* Face: eyes (blink) + slightly downturned mouth for "a little sad, not dramatic" */}
            <g className="blink">
              <circle cx="72" cy="70" r="2.4" className="fill-foreground/70" />
              <circle cx="88" cy="70" r="2.4" className="fill-foreground/70" />
            </g>
            <path
              d="M72 80 Q80 76 88 80"
              className="stroke-foreground/50"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
            {/* Arm resting on knee */}
            <path
              d="M58 102 Q46 110 48 122"
              className="stroke-amber-500 dark:stroke-amber-500/90"
              strokeWidth="10"
              strokeLinecap="round"
              fill="none"
            />
          </g>

          {/* Small toolbox beside the character */}
          <g>
            <rect x="30" y="118" width="24" height="16" rx="2" className="fill-red-400/80 dark:fill-red-500/70" />
            <rect x="38" y="112" width="8" height="8" rx="1.5" className="fill-red-400/80 dark:fill-red-500/70" />
          </g>

          {/* Wrench, gently rotating above the laptop */}
          <g className="wrench-group">
            <circle cx="140" cy="88" r="14" className="fill-amber-100 dark:fill-amber-100/10" opacity="0.6" />
            <path
              d="M128 96 L136 88 M133 91 A5 5 0 1 1 141 83 A5 5 0 0 1 133 91 Z"
              className="stroke-muted-foreground"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
