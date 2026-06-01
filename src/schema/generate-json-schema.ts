import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WorkflowSpecSchema } from "./workflow-spec.js";

const schema = z.toJSONSchema(WorkflowSpecSchema, {
  target: "draft-2020-12"
});

const outPath = path.resolve(process.cwd(), "schemas", "workflow-spec.schema.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
console.log(outPath);
