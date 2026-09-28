// Placement for tooltips and popovers, in viewport pixels.

export type Placement = 'top' | 'bottom' | 'bottom-start' | 'bottom-end' | 'left-start' | 'right-start';

export interface FloatingPosition {
  left: number;
  top: number;
  maxHeight: number;
  side: 'top' | 'bottom' | 'left' | 'right';
}

const MARGIN = 8;

export function placeFloating(anchor: DOMRect, size: { width: number; height: number }, placement: Placement, gap = 8): FloatingPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(MARGIN, x), Math.max(MARGIN, vw - size.width - MARGIN));
  const clampY = (y: number) => Math.min(Math.max(MARGIN, y), Math.max(MARGIN, vh - size.height - MARGIN));

  if (placement === 'left-start' || placement === 'right-start') {
    const rightRoom = vw - anchor.right - gap - MARGIN;
    const leftRoom = anchor.left - gap - MARGIN;
    const wantRight = placement === 'right-start';
    const right = wantRight ? rightRoom >= size.width || rightRoom >= leftRoom : !(leftRoom >= size.width || leftRoom >= rightRoom);
    // No room either side on a narrow screen: drop below the anchor instead.
    if (Math.max(rightRoom, leftRoom) < Math.min(size.width, 280)) {
      return placeFloating(anchor, size, 'bottom-start', gap);
    }
    const left = right ? anchor.right + gap : anchor.left - gap - size.width;
    return { left: clampX(left), top: clampY(anchor.top), maxHeight: vh - 2 * MARGIN, side: right ? 'right' : 'left' };
  }

  const below = vh - anchor.bottom - gap - MARGIN;
  const above = anchor.top - gap - MARGIN;
  let side: 'top' | 'bottom' = placement === 'top' ? 'top' : 'bottom';
  if (side === 'top' && above < size.height && below > above) side = 'bottom';
  if (side === 'bottom' && below < size.height && above > below) side = 'top';
  const room = side === 'bottom' ? below : above;
  const height = Math.min(size.height, room);
  const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;

  let left: number;
  if (placement === 'bottom-start') left = anchor.left;
  else if (placement === 'bottom-end') left = anchor.right - size.width;
  else left = anchor.left + anchor.width / 2 - size.width / 2;
  return { left: clampX(left), top: Math.max(MARGIN, top), maxHeight: Math.max(120, room), side };
}
