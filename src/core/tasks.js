import { isSafeOffer } from "./activities.js";

/** Today's flyout tasks, finished or not, with whether a run can do them. */
export function toTasks(tasks) {
  return (tasks ?? []).map((task) => ({
    id: task.id,
    title: task.title,
    points: task.points,
    done: task.done,
    state: task.done ? "done" : isSafeOffer(task) ? "auto" : "manual",
    url: task.url,
    hash: task.hash,
    activityType: task.activityType,
  }));
}

const TASK_ORDER = { auto: 0, manual: 1, locked: 2, app: 3, done: 4 };

/**
 * The one list the popup shows: today's tasks and the quests, open ones first
 * (what the run will do, then what is left for the user), finished ones last,
 * with the totals for the progress bar.
 */
export function taskList(dash, questCache) {
  const tasks = [...(dash?.tasks ?? [])];
  for (const quest of questCache?.quests ?? []) {
    const done = quest.total > 0 && quest.done >= quest.total;
    const open = quest.children.some((c) => !c.isCompleted && !c.isLocked);
    tasks.push({
      id: quest.id,
      title: quest.title,
      points: quest.points,
      done,
      quest: { done: quest.done, total: quest.total, expiresAt: quest.expiresAt },
      state: done ? "done" : quest.appOnly ? "app" : open ? "auto" : "locked",
      // For app-only quests: "desktop" (the Windows app) or "mobile".
      app: quest.appKind ?? null,
    });
  }
  tasks.sort((a, b) => TASK_ORDER[a.state] - TASK_ORDER[b.state] || b.points - a.points);
  return {
    items: tasks,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    pointsLeft: tasks.filter((t) => !t.done).reduce((sum, t) => sum + t.points, 0),
  };
}
