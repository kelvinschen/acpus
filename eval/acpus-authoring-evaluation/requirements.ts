export const REQUIREMENTS = [
  {
    id: "daily-planning",
    title: "Build a realistic daily plan",
    request: `I want to provide a messy list of tasks, fixed commitments, deadlines, and how much energy I expect to have. Give me a realistic plan for the day, call out conflicts and trade-offs, let me accept it or ask for changes, and finish with the plan I agreed to.`,
  },
  {
    id: "support-triage",
    title: "Triage customer reports",
    request: `I receive a batch of customer reports with uneven detail and urgency. I want each report assessed consistently, ambiguous or risky cases highlighted, and a concise action list that tells the team what to handle now, what can wait, and what needs escalation.`,
  },
  {
    id: "release-readiness",
    title: "Assess release readiness",
    request: `I want to point at a software project, describe the release goal, and get an evidence-based readiness assessment. It should distinguish blockers from non-blocking concerns, explain uncertainty, and give me a clear ship-or-hold recommendation with next actions.`,
  },
  {
    id: "meeting-decisions",
    title: "Turn meeting notes into decisions",
    request: `I want to provide raw meeting notes containing tangents, disagreement, and incomplete statements. Produce a trustworthy record of decisions, owners, due dates, unresolved questions, and follow-ups without inventing commitments that were never made.`,
  },
  {
    id: "trip-planning",
    title: "Plan a resilient group trip",
    request: `I want a group trip plan based on travelers' preferences, budget, dates, pace, and non-negotiable constraints. Compare meaningful alternatives, produce a practical day-by-day itinerary, and include contingency choices for likely disruptions.`,
  },
  {
    id: "meal-planning",
    title: "Create a low-waste meal plan",
    request: `I want a five-day meal plan based on dietary needs, available pantry items, cooking time, and budget. Reuse ingredients to reduce waste, identify anything that must be bought, and make the plan easy to adjust when a meal is skipped.`,
  },
  {
    id: "adaptive-study",
    title: "Coach an adaptive study session",
    request: `I want a study coach for a topic, my current confidence, and an upcoming deadline. It should make a focused plan, test my understanding, adapt to my answers, explain mistakes, and finish with an honest summary of what I know and what to study next.`,
  },
  {
    id: "interactive-story",
    title: "Run an interactive story",
    request: `I want a replayable interactive story from a theme, characters, and desired length. The story should remember earlier choices, offer meaningful decisions, keep character behavior coherent, and end with a recap of how the player's choices shaped the outcome.`,
  },
  {
    id: "rock-paper-scissors",
    title: "Run a rock-paper-scissors match",
    request: `I want to run a best-of-N rock-paper-scissors match for two named players. Record each valid round, reject unusable moves fairly, stop as soon as the match is decided, and return a clear match history and winner.`,
  },
  {
    id: "werewolf-moderator",
    title: "Moderate a game of Werewolf",
    request: `I want a moderator for a text-based game of Werewolf with a roster and chosen roles. It should guide night and day play, keep private information private, collect and resolve player decisions, track who is alive, detect the winning side, and produce an appropriate public game record.`,
  },
] as const;
