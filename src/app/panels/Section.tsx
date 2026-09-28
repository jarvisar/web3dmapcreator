import type { ReactNode } from 'react';
import { toggleSection, useApp } from '../state/store';
import type { SectionKey } from '../state/store';

interface SectionProps {
  id: SectionKey;
  title: string;
  summary: ReactNode;
  children: ReactNode;
  /** Small status shown on the header whether open or closed, e.g. a warning dot. */
  badge?: ReactNode;
}

export function Section({ id, title, summary, children, badge }: SectionProps) {
  const open = useApp((state) => state.ui.sections[id]);
  const bodyId = `section-${id}`;
  return (
    <section className="section" aria-labelledby={`${bodyId}-title`}>
      <h2 className="section-heading">
        <button
          type="button"
          className="section-header"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => toggleSection(id)}
        >
          <span className="triangle" aria-hidden="true" />
          <span className="section-title" id={`${bodyId}-title`}>
            {title}
          </span>
          <span className="section-summary">{open ? '' : summary}</span>
          {badge}
        </button>
      </h2>
      {open && (
        <div className="section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
