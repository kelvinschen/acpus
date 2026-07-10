export type InitTarget = "file" | "catalog";

export type InitOptions = {
  target: InitTarget;
  destination: string;
};

export type InitResult = {
  target: InitTarget;
  path: string;
};
