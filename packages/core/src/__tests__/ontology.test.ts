import { describe, expect, it } from "vitest";
import { createOntologyEntity, validateOntologyEntity } from "../ontology.js";

describe("ontology", () => {
  it("accepts a valid entity", () => {
    const entity = createOntologyEntity({
      id: "goal-1",
      type: "Goal",
      label: "Ship MVP",
      properties: { owner: "builder" },
      relations: [{ type: "uses", targetId: "skill-1" }]
    });

    expect(entity.type).toBe("Goal");
  });

  it("rejects invalid entity shapes", () => {
    const result = validateOntologyEntity({ id: "bad", type: "Unknown", relations: {} });

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("type must be one of");
    expect(result.errors.join(" ")).toContain("relations must be an array");
  });
});

