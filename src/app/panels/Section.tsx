import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { toggleSection, useApp } from '../state/store';
import type { SectionKey } from '../state/store';

interface SectionProps {
  id: SectionKey;
  title: string;
  icon: ReactNode;
  summary: ReactNode;
  children: ReactNode;
  /** Small status shown on the header whether open or closed, e.g. a warning dot. */
  badge?: ReactNode;
}

export function Section({ id, title, icon, summary, children, badge }: SectionProps) {
  const open = useApp((state) => state.ui.sections[id]);
  const bodyId = `section-${id}`;
  return (
    <section className={`section${open ? ' is-open' : ''}`} id={`${bodyId}-wrap`} aria-labelledby={`${bodyId}-title`}>
      <h2 className="section-heading">
        <button
          type="button"
          className="section-header"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => toggleSection(id)}
        >
          <span className="section-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="section-titles">
            <span className="section-title" id={`${bodyId}-title`}>
              {title}
            </span>
            {!open && <span className="section-summary">{summary}</span>}
          </span>
          {badge}
          <ChevronDown className="section-chevron" size={16} aria-hidden="true" />
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
