// Outline fonts are OFL TTFs with fairly even stroke widths. On wood, strokes
// thinner than the beam disappear, so high-contrast display fonts lose parts of
// their letters. Stroke fonts are the Hershey single-line fonts, for plotters.
export type FontKind = 'outline' | 'stroke';

export interface FontInfo {
  id: string;
  name: string;
  kind: FontKind;
  // Relative to the app's base URL.
  file: string;
  note: string;
}

export const FONTS: FontInfo[] = [
  { id: 'montserrat', name: 'Montserrat', kind: 'outline', file: 'fonts/Montserrat-SemiBold.ttf', note: 'Geometric sans' },
  { id: 'josefin', name: 'Josefin Sans', kind: 'outline', file: 'fonts/JosefinSans-Bold.ttf', note: 'Vintage geometric' },
  { id: 'cinzel', name: 'Cinzel', kind: 'outline', file: 'fonts/Cinzel-SemiBold.ttf', note: 'Engraved capitals' },
  { id: 'oswald', name: 'Oswald', kind: 'outline', file: 'fonts/Oswald-Medium.ttf', note: 'Condensed sans' },
  { id: 'bebas', name: 'Bebas Neue', kind: 'outline', file: 'fonts/BebasNeue-Regular.ttf', note: 'Tall capitals' },
  { id: 'bitter', name: 'Bitter', kind: 'outline', file: 'fonts/Bitter-SemiBold.ttf', note: 'Slab serif' },
  { id: 'hershey-sans', name: 'Hershey Sans', kind: 'stroke', file: 'fonts/hershey/futural.json', note: 'Single-line' },
  { id: 'hershey-sans-bold', name: 'Hershey Sans Bold', kind: 'stroke', file: 'fonts/hershey/futuram.json', note: 'Double-line' },
  { id: 'hershey-serif', name: 'Hershey Serif', kind: 'stroke', file: 'fonts/hershey/timesr.json', note: 'Single-line serif' },
  { id: 'hershey-script', name: 'Hershey Script', kind: 'stroke', file: 'fonts/hershey/scripts.json', note: 'Single-line script' },
  { id: 'hershey-gothic', name: 'Hershey Gothic', kind: 'stroke', file: 'fonts/hershey/gothiceng.json', note: 'Blackletter' },
];

// A font the user loaded. Its bytes are sent along with each render request.
export const CUSTOM_FONT_ID = 'custom';

export function fontInfo(id: string): FontInfo | undefined {
  return FONTS.find((f) => f.id === id);
}
