import { useState, useEffect, useCallback } from "react";
import { X, ExternalLink, ListTodo, Sparkles } from "lucide-react";
import { useTaskStore } from "@/stores/taskStore";
import { useUIStore } from "@/stores/uiStore";
import {
  getTasksForThread,
  insertTask,
  completeTask,
  uncompleteTask,
  deleteTask as dbDeleteTask,
  getSubtasks,
} from "@/services/db/tasks";
import type { DbTask } from "@/services/db/tasks";
import { handleRecurringTaskCompletion } from "@/services/tasks/taskManager";
import { TaskItem } from "./TaskItem";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { navigateToLabel } from "@/router/navigate";

import { Tooltip } from "@/components/ui/Tooltip";
interface TaskSidebarProps {
  accountId: string;
  threadId: string;
}

export function TaskSidebar({ accountId, threadId }: TaskSidebarProps) {
  const threadTasks = useTaskStore((s) => s.threadTasks);
  const setThreadTasks = useTaskStore((s) => s.setThreadTasks);
  const toggleTaskSidebar = useUIStore((s) => s.toggleTaskSidebar);

  useEffect(() => {
    let cancelled = false;
    getTasksForThread(accountId, threadId).then((tasks) => {
      if (!cancelled) setThreadTasks(tasks);
    });
    return () => { cancelled = true; };
  }, [accountId, threadId, setThreadTasks]);

  const handleAddTask = useCallback(async (title: string) => {
    await insertTask({
      accountId,
      title,
      threadId,
      threadAccountId: accountId,
    });
    // Refresh
    const tasks = await getTasksForThread(accountId, threadId);
    setThreadTasks(tasks);
    useTaskStore.getState().setIncompleteCount(
      useTaskStore.getState().incompleteCount + 1,
    );
  }, [accountId, threadId, setThreadTasks]);

  const handleToggleComplete = useCallback(async (id: string, completed: boolean) => {
    if (completed) {
      const task = threadTasks.find((t) => t.id === id);
      if (task?.recurrence_rule) {
        await handleRecurringTaskCompletion(id);
      } else {
        await completeTask(id);
      }
    } else {
      await uncompleteTask(id);
    }
    const tasks = await getTasksForThread(accountId, threadId);
    setThreadTasks(tasks);
    // Update count
    const { getIncompleteTaskCount } = await import("@/services/db/tasks");
    const count = await getIncompleteTaskCount(accountId);
    useTaskStore.getState().setIncompleteCount(count);
  }, [accountId, threadId, setThreadTasks, threadTasks]);

  const handleDelete = useCallback(async (id: string) => {
    await dbDeleteTask(id);
    const tasks = await getTasksForThread(accountId, threadId);
    setThreadTasks(tasks);
    const { getIncompleteTaskCount } = await import("@/services/db/tasks");
    const count = await getIncompleteTaskCount(accountId);
    useTaskStore.getState().setIncompleteCount(count);
  }, [accountId, threadId, setThreadTasks]);

  // Load subtasks for each task
  const [subtaskMap, setSubtaskMap] = useState<Record<string, DbTask[]>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadSubtasks() {
      const map: Record<string, DbTask[]> = {};
      for (const task of threadTasks) {
        const subs = await getSubtasks(task.id);
        if (subs.length > 0) map[task.id] = subs;
      }
      if (!cancelled) setSubtaskMap(map);
    }
    loadSubtasks();
    return () => { cancelled = true; };
  }, [threadTasks]);

  return (
    <aside
      aria-label="Tasks for this conversation"
      className="task-panel flex h-full w-[min(23rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-white/70 bg-bg-primary/95 shadow-[0_24px_70px_rgba(62,50,39,0.16)] backdrop-blur-xl dark:border-white/10"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary bg-gradient-to-br from-white/80 via-bg-primary to-accent/5 dark:from-white/5">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <ListTodo size={15} />
            </span>
            <h3 className="font-serif text-xl font-semibold tracking-tight text-text-primary">Tasks</h3>
          </div>
          <p className="mt-1 text-xs text-text-tertiary">
            {threadTasks.length === 0 ? "Turn this conversation into momentum" : `${threadTasks.length} linked to this conversation`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip content="Open tasks page"><button
            onClick={() => navigateToLabel("tasks")}

            className="rounded-lg p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <ExternalLink size={13} />
          </button></Tooltip>
          <button
            onClick={toggleTaskSidebar}
            className="rounded-lg p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-3">
        {threadTasks.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Sparkles size={19} />
            </span>
            <p className="text-sm font-medium text-text-primary">Nothing to hold onto yet</p>
            <p className="mt-1 max-w-52 text-xs leading-5 text-text-tertiary">Add the next small step, or extract tasks from the message toolbar.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {threadTasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                subtasks={subtaskMap[task.id]}
                onToggleComplete={handleToggleComplete}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Quick add */}
      <div className="border-t border-border-secondary bg-white/45 dark:bg-black/10">
        <TaskQuickAdd onAdd={handleAddTask} placeholder="Add a task…" />
      </div>
    </aside>
  );
}
