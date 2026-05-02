export interface SchedulerTask {
  id: string;
  schedulerRef: string;
  dueAt: Date;
  cwd: string;
  fireScriptPath: string;
  nodeExecPath: string;
}

export interface SchedulerHandler {
  register(task: SchedulerTask): void;
  unregister(schedulerRef: string): void;
}
