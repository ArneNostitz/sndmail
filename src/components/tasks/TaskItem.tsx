import { useState, useCallback } from "react";
import {
  Circle,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  Trash2,
  Calendar,
  RepeatIcon,
  Link2,
  BellRing,
} from "lucide-react";
import type { DbTask, TaskPriority } from "@/services/db/tasks";
import { DateTimePickerDialog } from "@/components/ui/DateTimePickerDialog";

import { Tooltip } from "@/components/ui/Tooltip";
const PRIORITY_COLORS: Record<TaskPriority, string> = {
  none: "text-text-tertiary",
  low: "text-blue-400",
  medium: "text-amber-400",
  high: "text-orange-500",
  urgent: "text-red-500",
};

const PRIORITY_DOT_COLORS: Record<TaskPriority, string> = {
  none: "bg-text-tertiary/30",
  low: "bg-blue-400",
  medium: "bg-amber-400",
  high: "bg-orange-500",
  urgent: "bg-red-500",
};

function formatDueDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((dueStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays <= 7) return `${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getDueDateColor(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = timestamp - now;
  if (diff < 0) return "text-red-500 bg-red-500/10";
  if (diff < 86400) return "text-amber-500 bg-amber-500/10";
  return "text-text-tertiary bg-bg-tertiary";
}

interface TaskItemProps {
  task: DbTask;
  subtasks?: DbTask[];
  onToggleComplete: (id: string, completed: boolean) => void;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Set or clear when a task is due. Omitted, the date is read-only. */
  onSetDueDate?: (id: string, dueDate: number | null) => void;
  isSelected?: boolean;
  compact?: boolean;
}

export function TaskItem({
  task,
  subtasks,
  onToggleComplete,
  onSelect,
  onDelete,
  onSetDueDate,
  isSelected,
  compact,
}: TaskItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [pickingDue, setPickingDue] = useState(false);
  const tags: string[] = (() => {
    try {
      return JSON.parse(task.tags_json) as string[];
    } catch {
      return [];
    }
  })();

  const hasSubtasks = subtasks && subtasks.length > 0;
  const completedSubtasks = subtasks?.filter((s) => s.is_completed).length ?? 0;
  const hasRecurrence = !!task.recurrence_rule;

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleComplete(task.id, !task.is_completed);
  }, [task.id, task.is_completed, onToggleComplete]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.(task.id);
  }, [task.id, onDelete]);

  return (
    <div>
      <div
        onClick={() => onSelect?.(task.id)}
        className={`task-row group flex items-start gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200 ${
          isSelected ? "bg-accent/10 border border-accent/20 shadow-[0_6px_18px_rgba(79,70,229,0.08)]" : "hover:bg-white/60 dark:hover:bg-white/5 border border-transparent"
        } ${task.is_completed ? "opacity-60" : ""}`}
      >
        {/* Checkbox */}
        <button onClick={handleToggle} className="task-check mt-0.5 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          {task.is_completed ? (
            <CheckCircle2 size={16} className="text-success" />
          ) : (
            <Circle size={16} className={PRIORITY_COLORS[task.priority]} />
          )}
        </button>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {task.priority !== "none" && (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT_COLORS[task.priority]}`} />
            )}
            <span
              className={`text-sm truncate ${
                task.is_completed ? "line-through text-text-tertiary" : "text-text-primary"
              }`}
            >
              {task.title}
            </span>
            {/* A follow-up reminder is a task with a bell — same list, same
                due date, but it is waiting on someone else, not on you */}
            {task.kind === "reminder" && (
              <BellRing size={11} className="shrink-0 text-accent" aria-label="Follow-up reminder" />
            )}
          </div>

          {!compact && (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {task.due_date ? (
                <Tooltip content={onSetDueDate ? "Change when this is due" : undefined}><button
                  onClick={(e) => { e.stopPropagation(); if (onSetDueDate) setPickingDue(true); }}
                  disabled={!onSetDueDate}

                  className={`inline-flex items-center gap-1 text-[0.6875rem] px-1.5 py-0.5 rounded-full ${getDueDateColor(task.due_date)} ${onSetDueDate ? "hover:brightness-95" : "cursor-default"}`}
                >
                  <Calendar size={10} />
                  {formatDueDate(task.due_date)}
                </button></Tooltip>
              ) : onSetDueDate ? (
                <Tooltip content="Set a due date"><button
                  onClick={(e) => { e.stopPropagation(); setPickingDue(true); }}

                  className="inline-flex items-center gap-1 text-[0.6875rem] px-1.5 py-0.5 rounded-full text-text-tertiary hover:text-accent hover:bg-bg-hover transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Calendar size={10} />
                  Due
                </button></Tooltip>
              ) : null}
              {hasRecurrence && (
                <span className="inline-flex items-center gap-0.5 text-[0.6875rem] text-text-tertiary">
                  <RepeatIcon size={10} />
                </span>
              )}
              {task.thread_id && (
                <span className="inline-flex items-center gap-0.5 text-[0.6875rem] text-accent/70">
                  <Link2 size={10} />
                </span>
              )}
              {hasSubtasks && (
                <span className="text-[0.6875rem] text-text-tertiary">
                  {completedSubtasks}/{subtasks.length}
                </span>
              )}
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {hasSubtasks && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="p-0.5 text-text-tertiary hover:text-text-primary"
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          {onDelete && (
            <button
              onClick={handleDelete}
              className="p-0.5 text-text-tertiary hover:text-danger transition-colors"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Subtasks */}
      {expanded && hasSubtasks && (
        <div className="ml-7 mt-0.5 space-y-0.5">
          {subtasks.map((sub) => (
            <TaskItem
              key={sub.id}
              task={sub}
              onToggleComplete={onToggleComplete}
              onSelect={onSelect}
              compact
            />
          ))}
        </div>
      )}

      {pickingDue && onSetDueDate && (
        <DateTimePickerDialog
          isOpen
          title="Due..."
          presets={getDuePresets()}
          submitLabel="Set due date"
          onSelect={(timestamp) => {
            onSetDueDate(task.id, timestamp);
            setPickingDue(false);
          }}
          onClose={() => setPickingDue(false)}
          onClear={task.due_date ? () => {
            onSetDueDate(task.id, null);
            setPickingDue(false);
          } : undefined}
          clearLabel="Remove due date"
        />
      )}
    </div>
  );
}

/** The dates a task is usually due, so the common cases are one click. */
function getDuePresets(): { label: string; timestamp: number }[] {
  const at9 = (daysAhead: number) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(9, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  const laterToday = () => {
    const d = new Date();
    d.setHours(d.getHours() + 3, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  return [
    { label: "Later today", timestamp: laterToday() },
    { label: "Tomorrow", timestamp: at9(1) },
    { label: "Next week", timestamp: at9(7) },
  ];
}
