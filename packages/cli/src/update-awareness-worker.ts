import { runUpdateAwarenessWorker } from "./update/awareness.js";

void runUpdateAwarenessWorker(process.argv.slice(2)).catch(() => {});
