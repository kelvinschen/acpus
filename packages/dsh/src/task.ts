export type ResolvedTaskSelector = {
  name: string;
  occurrence: number;
};

export type DelegatedTaskSelector = ResolvedTaskSelector;

export function taskSelector(
  task: { workflowName: string; occurrence: number },
): ResolvedTaskSelector {
  return { name: task.workflowName, occurrence: task.occurrence };
}
