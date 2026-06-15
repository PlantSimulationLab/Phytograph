// Static, always-visible toolbar block. Renders the commands for one *section*
// of the registry (Tools / Create / Simulate — see lib/toolCommands.ts) grouped
// by toolGroup. Every tool is always shown; single-input/gizmo tools grey out
// with a tooltip when their prerequisite isn't selected, while multi-input tools
// (which pick their own inputs in a dialog) stay enabled. This replaces the old
// selection-conditional toolbar so users can always see every available action.
import {
  type ToolCommand,
  type SelectionState,
  type ToolGroup,
  TOOL_GROUPS,
  commandsForGroup,
  isCommandAvailable,
  requiresText,
} from '../lib/toolCommands';

interface ToolbarProps {
  commands: ToolCommand[];
  selection: SelectionState;
  /** Block heading (e.g. "Tools", "Create", "Simulate"). */
  title?: string;
  /** Which groups this block renders. Defaults to the analysis Tools groups. */
  groups?: { id: ToolGroup; label: string }[];
}

export function Toolbar({ commands, selection, title = 'Tools', groups = TOOL_GROUPS }: ToolbarProps) {
  // Nothing to show (e.g. no commands in any of this block's groups) → render
  // nothing, so an empty section doesn't leave a stray heading.
  const hasAny = groups.some(g => commandsForGroup(commands, g.id).length > 0);
  if (!hasAny) return null;

  // When a single group's label matches the block title (Create/Simulate), the
  // per-group sub-heading is redundant — show only the block title.
  const singleGroupSameLabel = groups.length === 1 && groups[0].label === title;

  return (
    <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg flex flex-col gap-2">
      <div className="text-[10px] text-neutral-500 text-center">{title}</div>
      {groups.map(group => {
        const groupCmds = commandsForGroup(commands, group.id);
        if (groupCmds.length === 0) return null;
        return (
          <div key={group.id}>
            {!singleGroupSameLabel && (
              <div className="text-[9px] uppercase tracking-wide text-neutral-600 mb-1 px-0.5">
                {group.label}
              </div>
            )}
            <div className="grid grid-cols-3 gap-1">
              {groupCmds.map(cmd => {
                const available = isCommandAvailable(cmd, selection);
                const active = cmd.isActive?.() ?? false;
                const Icon = cmd.icon;
                const title = available
                  ? cmd.name
                  : cmd.multiInput
                    ? `${cmd.name} — import a point cloud first`
                    : `${cmd.name} — select ${requiresText(cmd.requires ?? null)} first`;
                return (
                  <button
                    key={cmd.id}
                    data-testid={cmd.testId ?? `tool-${cmd.id}`}
                    onClick={() => { if (available) cmd.action(); }}
                    disabled={!available}
                    title={title}
                    className={`p-2 rounded transition-colors flex items-center justify-center ${
                      !available
                        ? 'opacity-40 cursor-not-allowed'
                        : active
                          ? 'bg-green-600 text-white'
                          : 'hover:bg-neutral-700'
                    }`}
                  >
                    {Icon ? (
                      <Icon className={`w-4 h-4 ${active ? 'text-white' : 'text-neutral-300'}`} />
                    ) : (
                      <span className="text-[10px] text-neutral-300">{cmd.name.slice(0, 2)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
