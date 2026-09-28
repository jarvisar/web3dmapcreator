// Icons lucide does not have: the app logo, the area shapes and the GitHub mark.

import type { AreaShape } from '../../core/settings';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect className="logo-base" x="1" y="22" width="30" height="8" rx="2.4" />
      <rect className="logo-base-top" x="1" y="22" width="30" height="2.4" rx="1.2" />
      <rect className="logo-block-a" x="4" y="12.5" width="7.5" height="10.5" rx="1.3" />
      <rect className="logo-block-b" x="12.5" y="2" width="7.5" height="21" rx="1.3" />
      <rect className="logo-block-c" x="21" y="8" width="7" height="15" rx="1.3" />
    </svg>
  );
}

export function ShapeIcon({ shape, size = 18 }: { shape: AreaShape; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      {shape === 'rectangle' && <rect x="2.5" y="5" width="15" height="10" rx="0.6" />}
      {shape === 'rounded' && <rect x="2.5" y="5" width="15" height="10" rx="3.2" />}
      {shape === 'circle' && <circle cx="10" cy="10" r="7" />}
      {shape === 'hexagon' && <polygon points="2.5,10 6.25,3.8 13.75,3.8 17.5,10 13.75,16.2 6.25,16.2" strokeLinejoin="round" />}
    </svg>
  );
}

export function GithubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
