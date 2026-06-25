import type { LayoutProfile } from "./types.js";

export function createDefaultLayoutProfile(): LayoutProfile {
  return {
    id: "default-professional-builder",
    name: "Professional Builder",
    version: 1,
    panels: [
      { id: "runs", title: "Runs", kind: "runs", region: "main", visible: true },
      { id: "skills", title: "Skills", kind: "skills", region: "left", visible: true },
      { id: "ontology", title: "Ontology", kind: "ontology", region: "right", visible: true },
      { id: "schedules", title: "Schedules", kind: "schedules", region: "right", visible: true },
      { id: "artifacts", title: "Artifacts", kind: "artifacts", region: "bottom", visible: true },
      { id: "logs", title: "Logs", kind: "logs", region: "bottom", visible: true }
    ]
  };
}

