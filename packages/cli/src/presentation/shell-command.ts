const bareArgument = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Renders one copyable POSIX-shell command from its exact argv. */
export function renderShellCommand(argv: readonly string[]): string {
  return argv.map(renderArgument).join(" ");
}

function renderArgument(value: string): string {
  if (bareArgument.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
