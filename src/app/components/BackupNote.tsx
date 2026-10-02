import type { BackupReason } from '../state/persist';
import { backupText, forgetBackup, restoreBackup } from '../state/editActions';
import { useApp } from '../state/store';

const FROM: Record<BackupReason, string> = {
  link: 'from before you opened a link',
  import: 'from before you imported options',
  clear: 'from before Undo all',
  'clear-picks': 'from before Undo all picks',
  reset: 'from before the reset',
  restore: 'you swapped out',
};

/** Offers back the edits, picked roads or routes a link, a file, Undo all or a reset replaced. */
export function BackupNote({ of }: { of: 'edits' | 'picks' | 'tracks' }) {
  const backup = useApp((state) => state.backup);
  if (!backup || !backup[of]) return null;
  const what = backupText(backup);
  return (
    <p className="inspector-note">
      {backup.reason === 'restore' ? 'The' : 'Your'} {what} {FROM[backup.reason]} are kept aside.{' '}
      <button type="button" className="link-btn" onClick={restoreBackup}>
        Put them back
      </button>{' '}
      <button type="button" className="link-btn" onClick={forgetBackup}>
        Forget them
      </button>
    </p>
  );
}
