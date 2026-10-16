import { invoke } from "@tauri-apps/api/core";

export interface Task {
  id: string;
  outcome: string;
  plannedFor: string;
  estimatedMinutes: number;
  actualSeconds: number;
  status: "planned" | "active" | "completed";
  startedAt: number | null;
  completedOn: string | null;
  createdAt: number;
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

  start(id: string): Promise<Task> {
    return invoke("start_task", { id });
  }

  complete(id: string): Promise<Task> {
    return invoke("complete_task", { id });
  }
}
