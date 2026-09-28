import { Check, CircleAlert, Info } from 'lucide-react';
import { useApp } from '../state/store';

export function Toasts() {
  const toasts = useApp((state) => state.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`}>
          {item.tone === 'success' ? (
            <Check size={16} aria-hidden="true" />
          ) : item.tone === 'error' ? (
            <CircleAlert size={16} aria-hidden="true" />
          ) : (
            <Info size={16} aria-hidden="true" />
          )}
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}
