import { Box, Cylinder, MapPin, MousePointer2, Pentagon, Redo2, Spline, SquareDashedMousePointer, Type, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { ToolButton } from '../../components/ToolButton';
import { redoEdit, setTool, undoEdit } from '../../state/editActions';
import { useApp, type EditTool } from '../../state/store';

export const TOOLS: { tool: EditTool; label: string; key: string; icon: ReactNode }[] = [
  { tool: 'select', label: 'Select', key: 'V', icon: <MousePointer2 size={15} aria-hidden="true" /> },
  { tool: 'several', label: 'Select several', key: 'M', icon: <SquareDashedMousePointer size={15} aria-hidden="true" /> },
  { tool: 'text', label: 'Add text', key: 'T', icon: <Type size={15} aria-hidden="true" /> },
  { tool: 'pin', label: 'Add a map pin', key: 'P', icon: <MapPin size={15} aria-hidden="true" /> },
  { tool: 'box', label: 'Add a box', key: 'B', icon: <Box size={15} aria-hidden="true" /> },
  { tool: 'cylinder', label: 'Add a cylinder', key: 'C', icon: <Cylinder size={15} aria-hidden="true" /> },
  { tool: 'path', label: 'Draw a road or path', key: 'L', icon: <Spline size={15} aria-hidden="true" /> },
  { tool: 'area', label: 'Draw a building or area', key: 'A', icon: <Pentagon size={15} aria-hidden="true" /> },
];

// The editor's tools down the left of the viewer, with undo and redo under them.
export function EditToolbar() {
  const tool = useApp((state) => state.ui.tool);
  const canUndo = useApp((state) => state.editHistory.past.length > 0);
  const canRedo = useApp((state) => state.editHistory.future.length > 0);
  return (
    <div className="edit-tools" role="toolbar" aria-label="Edit tools" aria-orientation="vertical">
      <div className="toolbar toolbar-vertical floating">
        {TOOLS.map((t) => (
          <ToolButton key={t.tool} label={`${t.label} (${t.key})`} pressed={tool === t.tool} onClick={() => setTool(t.tool)} placement="right">
            {t.icon}
          </ToolButton>
        ))}
      </div>
      <div className="toolbar toolbar-vertical floating">
        <ToolButton label="Undo (Ctrl+Z)" onClick={undoEdit} disabled={!canUndo} placement="right">
          <Undo2 size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Redo (Ctrl+Shift+Z)" onClick={redoEdit} disabled={!canRedo} placement="right">
          <Redo2 size={15} aria-hidden="true" />
        </ToolButton>
      </div>
    </div>
  );
}
