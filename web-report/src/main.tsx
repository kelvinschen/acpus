import React from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { ReportApp } from "./ReportApp.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReportApp />
  </React.StrictMode>
);
