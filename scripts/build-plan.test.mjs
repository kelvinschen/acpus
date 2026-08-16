import assert from "node:assert/strict";
import test from "node:test";
import { createBuildRunner } from "./build-plan.mjs";

test("workspace starts canonical DSH outputs after the foundation build", async () => {
  const steps = controlledSteps();
  const build = createBuildRunner(steps.run);
  const result = build("workspace");
  const settled = settlement(result);

  assert.deepEqual(steps.started(), ["foundation"]);

  steps.resolve("foundation");
  await turn();
  assert.deepEqual(steps.started(), [
    "foundation",
    "client",
    "dsh-preset",
    "dsh-remote",
    "dsh-client",
    "static-viz",
  ]);

  steps.resolve("static-viz");
  await turn();
  assert.deepEqual(steps.started(), [
    "foundation",
    "client",
    "dsh-preset",
    "dsh-remote",
    "dsh-client",
    "static-viz",
    "typescript",
  ]);

  steps.resolve("typescript");
  await turn();
  assert.equal(settled.value, false);

  steps.resolve("dsh-preset");
  steps.resolve("dsh-remote");
  steps.resolve("dsh-client");
  steps.resolve("client");
  await result;
});

test("workspace awaits DSH outputs and preserves failure order after TypeScript fails", async () => {
  const remoteFailure = new Error("Remote publication failed");
  const typescriptFailure = new Error("TypeScript failed");
  const steps = controlledSteps();
  const build = createBuildRunner(steps.run);
  const result = build("workspace");
  const settled = settlement(result);

  steps.resolve("foundation");
  await turn();
  steps.reject("dsh-remote", remoteFailure);
  steps.resolve("static-viz");
  await turn();
  steps.reject("typescript", typescriptFailure);
  await turn();
  assert.equal(settled.value, false);

  steps.resolve("client");
  steps.resolve("dsh-preset");
  steps.resolve("dsh-client");
  await assert.rejects(result, error => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.message, "Build stages failed: dsh-remote, typescript");
    assert.deepEqual(error.errors, [remoteFailure, typescriptFailure]);
    return true;
  });
});

test("package uses its TypeScript build without the workspace foundation", async () => {
  const started = [];
  const build = createBuildRunner(step => {
    started.push(step);
  });

  await build("package");

  assert.deepEqual(started.map(step => step.stage), ["client", "static-viz", "typescript"]);
  assert.equal(started.some(step => step.stage === "foundation"), false);
  const typescript = started.find(step => step.stage === "typescript");
  assert.equal(typescript.cwd.endsWith("/packages/web"), true);
  assert.deepEqual(typescript.args.slice(-2), ["-b", "tsconfig.build.json"]);
});

test("foundation failure starts no Web stages", async () => {
  const failure = new Error("foundation failed");
  const started = [];
  const build = createBuildRunner(step => {
    started.push(step.stage);
    return Promise.reject(failure);
  });

  await assert.rejects(build("workspace"), error => error === failure);
  assert.deepEqual(started, ["foundation"]);
});

test("static visualization failure skips TypeScript and awaits the client", async () => {
  const failure = new Error("static visualization failed");
  const steps = controlledSteps();
  const build = createBuildRunner(steps.run);
  const result = build("package");
  const settled = settlement(result);

  steps.reject("static-viz", failure);
  await turn();
  assert.deepEqual(steps.started(), ["client", "static-viz"]);
  assert.equal(settled.value, false);

  steps.resolve("client");
  await assert.rejects(result, error => error === failure);
  assert.equal(steps.started().includes("typescript"), false);
});

test("client failure still lets the static visualization and TypeScript chain finish", async () => {
  const failure = new Error("client failed");
  const steps = controlledSteps();
  const build = createBuildRunner(steps.run);
  const result = build("package");
  const settled = settlement(result);

  steps.reject("client", failure);
  await turn();
  assert.equal(settled.value, false);

  steps.resolve("static-viz");
  await turn();
  assert.deepEqual(steps.started(), ["client", "static-viz", "typescript"]);
  assert.equal(settled.value, false);

  steps.resolve("typescript");
  await assert.rejects(result, error => error === failure);
});

test("TypeScript failure awaits the client and preserves failure order", async () => {
  const clientFailure = new Error("client failed");
  const typescriptFailure = new Error("TypeScript failed");
  const steps = controlledSteps();
  const build = createBuildRunner(steps.run);
  const result = build("package");
  const settled = settlement(result);

  steps.resolve("static-viz");
  await turn();
  steps.reject("typescript", typescriptFailure);
  await turn();
  assert.equal(settled.value, false);

  steps.reject("client", clientFailure);
  await assert.rejects(result, error => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.message, "Build stages failed: client, typescript");
    assert.deepEqual(error.errors, [clientFailure, typescriptFailure]);
    return true;
  });
});

test("synchronous client start failure still starts and awaits the server chain", async () => {
  const failure = new Error("client could not start");
  const steps = controlledSteps({ synchronousFailure: { stage: "client", error: failure } });
  const build = createBuildRunner(steps.run);
  const result = build("package");
  const settled = settlement(result);

  assert.deepEqual(steps.started(), ["client", "static-viz"]);
  assert.equal(settled.value, false);

  steps.resolve("static-viz");
  await turn();
  assert.deepEqual(steps.started(), ["client", "static-viz", "typescript"]);
  assert.equal(settled.value, false);

  steps.resolve("typescript");
  await assert.rejects(result, error => error === failure);
});

function controlledSteps(options = {}) {
  const calls = [];
  const controls = new Map();

  return {
    run(step) {
      calls.push(step);
      if (options.synchronousFailure?.stage === step.stage) {
        throw options.synchronousFailure.error;
      }
      const control = deferred();
      controls.set(step.stage, control);
      return control.promise;
    },
    started() {
      return calls.map(step => step.stage);
    },
    resolve(stage) {
      assertControl(controls, stage).resolve();
    },
    reject(stage, error) {
      assertControl(controls, stage).reject(error);
    },
  };
}

function assertControl(controls, stage) {
  const control = controls.get(stage);
  assert.notEqual(control, undefined, `${stage} has not started`);
  return control;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settlement(promise) {
  const state = { value: false };
  void promise.then(
    () => {
      state.value = true;
    },
    () => {
      state.value = true;
    },
  );
  return state;
}

function turn() {
  return new Promise(resolve => setImmediate(resolve));
}
