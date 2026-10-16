import { invoke } from "@tauri-apps/api/core";

export interface TaskResource {
  id: string;
  label: string;
  target: string;
  kind: "link" | "file";
}

export interface Task {
  id: string;
  outcome: string;
  isPriority: boolean;
  plannedFor: string;
  estimatedMinutes: number;
  actualSeconds: number;
  status: "planned" | "active" | "completed";
  startedAt: number | null;
  completedOn: string | null;
  createdAt: number;
  resources: TaskResource[];
}

export interface Dashboard {
  today: string;
  tomorrow: string;
  todayTasks: Task[];
  tomorrowTasks: Task[];
  activeTask: Task | null;
  canPlanTomorrow: boolean;
  completions: { day: string; count: number }[];
  serverNow: number;
}

/** Single IPC boundary. Views never access the database or invoke commands directly. */
export class PlanningClient {
  dashboard(): Promise<Dashboard> {
    return invoke("dashboard");
  }

  create(outcome: string, day: string, estimatedMinutes: number): Promise<Task> {
    return invoke("create_task", { outcome, day, estimatedMinutes });
  }

  rename(id: string, outcome: string): Promise<Task> {
    return invoke("rename_task", { id, outcome });
  }

  addLink(id: string, label: string, url: string): Promise<Task> {
    return invoke("add_task_link", { id, label, url });
  }

  attachFile(id: string): Promise<void> {
    return invoke("attach_task_file", { id });
  }

  removeResource(id: string, resourceId: string): Promise<Task> {
    return invoke("remove_task_resource", { id, resourceId });
  }

  openResource(id: string, resourceId: string): Promise<void> {
    return invoke("open_task_resource", { id, resourceId });
  }

  prioritize(id: string): Promise<Task> {
    return invoke("prioritize_task", { id });
  }

  start(id: string): Promise<Task> {
    return invoke("start_task", { id });
  }

  pause(id: string, reason: string): Promise<Task> {
    return invoke("pause_task", { id, reason });
  }

  stopTimer(id: string): Promise<Task> {
    return invoke("stop_timer", { id });
  }

  savePauseReason(id: string, reason: string): Promise<void> {
    return invoke("save_pause_reason", { id, reason });
  }

  resume(id: string): Promise<Task> {
    return invoke("resume_task", { id });
  }

  complete(id: string): Promise<Task> {
    return invoke("complete_task", { id });
  }
}
