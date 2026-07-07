import { createRoot } from "react-dom/client";
import "./styles.css";
import { StaticGraphApp, type StaticGraphData } from "./ui/StaticGraphApp.js";

declare global {
  interface Window {
    __ACPUS_WORKFLOW_VIZ__?: StaticGraphData;
  }
}

const root = document.getElementById("root");
const data = window.__ACPUS_WORKFLOW_VIZ__;

if (root && data) {
  createRoot(root).render(<StaticGraphApp data={data} />);
}
