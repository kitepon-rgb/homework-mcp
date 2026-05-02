export interface LauncherInput {
  taskId: string;
  cwd: string;
  scriptPath: string;
}

export interface LauncherHandler {
  launch(input: LauncherInput): void;
}
