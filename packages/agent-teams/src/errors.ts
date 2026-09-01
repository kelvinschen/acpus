export class AgentTeamCommandFailure extends Error {
  readonly type = "agent_team_command_failure";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentTeamCommandFailure";
  }
}
