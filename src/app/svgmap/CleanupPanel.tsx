import { fieldRange } from '../../core/svgmap/limits';
import type { CleanupSettings } from '../../core/svgmap/lines/cleanup';
import { CheckField, Disclosure, SliderField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
import { Segmented } from '../components/Segmented';
import { formatNumber } from '../lib/format';
import { Section } from '../panels/Section';
import { setCleanup, setCleanupPreset, useApp } from '../state/store';
import type { CleanupPreset } from './settings';

const PRESET_NAMES: Record<CleanupPreset, string> = {
  off: 'Off',
  light: 'Light',
  standard: 'Standard',
  strong: 'Strong',
  custom: 'Custom',
};

type NumberKey = { [K in keyof CleanupSettings]: CleanupSettings[K] extends number ? K : never }[keyof CleanupSettings];
type BooleanKey = { [K in keyof CleanupSettings]: CleanupSettings[K] extends boolean ? K : never }[keyof CleanupSettings];

export function CleanupPanel() {
  const preset = useApp((state) => state.svg.cleanupPreset);
  const c = useApp((state) => state.svg.cleanup);

  const num = (key: NumberKey, label: string, step: number, unit?: string, help?: string) => (
    <NumberField label={label} value={c[key]} onChange={(v) => setCleanup({ [key]: v })} {...fieldRange(`cleanup.${key}`)} step={step} decimals={3} unit={unit} help={help} />
  );
  // Fractions and multipliers, shown as a percentage.
  const pct = (key: NumberKey, label: string) => (
    <NumberField label={label} value={c[key]} onChange={(v) => setCleanup({ [key]: v })} {...fieldRange(`cleanup.${key}`, 100)} step={1} decimals={0} scale={100} unit="%" />
  );
  const check = (key: BooleanKey, label: string) => <CheckField label={label} checked={c[key]} onChange={(v) => setCleanup({ [key]: v })} />;

  return (
    <Section id="cleanup" title="Line cleanup" summary={PRESET_NAMES[preset]}>
      <Segmented<CleanupPreset>
        label="Line cleanup"
        value={preset === 'custom' ? ('' as CleanupPreset) : preset}
        stretch
        onChange={setCleanupPreset}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'light', label: 'Light' },
          { value: 'standard', label: 'Standard' },
          { value: 'strong', label: 'Strong' },
        ]}
      />
      <p className="field-hint">
        {preset === 'custom'
          ? 'Custom settings. Pick a preset to reset them.'
          : 'Two lines closer than the beam burn as one dark band. Cleanup joins streets, removes doubled lines like sidewalks, and thins out dense tangles of paths.'}
      </p>
      {c.enabled && (
        <>
          <SliderField
            label="Line spacing"
            value={c.lineSpacing}
            onChange={(lineSpacing) => setCleanup({ lineSpacing })}
            min={0}
            // Enough for a laser at a usable step, and more when a thick pen needs it.
            max={Math.max(1.5, Math.ceil(c.lineSpacing * 10) / 10)}
            step={0.01}
            format={(value) => `${formatNumber(value, 2)} mm`}
            help="Parallel lines closer than this are merged. Set it to about the beam width, or 1.5 to 2 times the pen width."
          />
          <Disclosure label="All settings">
            <div className="group-label">Joining</div>
            {check('weld', 'Join pieces that meet end to end')}
            {check('weldThroughJunctions', 'Continue through junctions into the straightest street')}
            {num('weldTolerance', 'Join tolerance', 0.005, 'mm')}
            {num('junctionMaxTurn', 'Max turn', 1, '°')}

            <div className="group-label">Overlaps</div>
            {check('cull', 'Remove lines that double another')}
            {check('wholePaths', 'Keep or drop whole streets')}
            {num('parallelAngle', 'Parallel within', 1, '°')}
            {pct('shadowFraction', 'Share covered')}

            <div className="group-label">Gaps and dead ends</div>
            {num('snapGap', 'Close gaps up to', 0.01, 'mm')}
            {num('pruneStubs', 'Remove stubs under', 0.05, 'mm')}
            {check('collapseLoops', 'Turn tiny loops into junctions')}
            {num('loopRadius', 'Smallest open loop radius', 0.01, 'mm')}

            <div className="group-label">Footpaths</div>
            {check('aggressivePaths', 'Stronger cleanup for footpaths')}
            {num('pathStubs', 'Footpath stubs under', 0.05, 'mm')}
            {num('tangleSpan', 'Tangle size', 0.5, 'mm')}
            {num('tangleSegments', 'Tangle segments', 1)}
            {num('tangleRatio', 'Tangle length / size', 0.1)}

            <div className="group-label">Dense areas</div>
            {check('dense', 'Thin out patches that burn dark')}
            {num('denseLimit', 'Density limit', 0.1, 'mm/mm²')}
            {num('denseWindow', 'Measured over', 0.1, 'mm')}
            {num('denseSeparation', 'Spacing there', 0.01, 'mm')}
            {num('denseProtectRank', 'Protect roads up to rank', 1, undefined, 'Rank 6 is residential streets. Anything more important is never removed from a dense patch.')}
            {pct('denseHotFraction', 'Share in patch')}
            {pct('denseShadowFraction', 'Share doubled')}
            {num('denseMeshMax', 'Mesh links under', 0.1, 'mm')}
            {pct('denseMeshDetour', 'Max detour')}
            {check('denseCountsFill', 'Count filled areas as dark')}
            {pct('denseCoveredScale', 'Limit over filled areas')}
          </Disclosure>
        </>
      )}
    </Section>
  );
}
