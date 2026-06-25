import { ONTOLOGY_ENTITY_TYPES, type OntologyEntity } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateOntologyEntity(entity: unknown): ValidationResult {
  const errors: string[] = [];
  const candidate = entity as Partial<OntologyEntity>;

  if (!candidate || typeof candidate !== "object") {
    return { valid: false, errors: ["entity must be an object"] };
  }

  if (!candidate.id || typeof candidate.id !== "string") {
    errors.push("id is required");
  }

  if (!candidate.label || typeof candidate.label !== "string") {
    errors.push("label is required");
  }

  if (!candidate.type || !ONTOLOGY_ENTITY_TYPES.includes(candidate.type)) {
    errors.push(`type must be one of: ${ONTOLOGY_ENTITY_TYPES.join(", ")}`);
  }

  if (!candidate.properties || typeof candidate.properties !== "object" || Array.isArray(candidate.properties)) {
    errors.push("properties must be an object");
  }

  if (!Array.isArray(candidate.relations)) {
    errors.push("relations must be an array");
  } else {
    candidate.relations.forEach((relation, index) => {
      if (!relation || typeof relation !== "object") {
        errors.push(`relations[${index}] must be an object`);
        return;
      }

      if (!relation.type || typeof relation.type !== "string") {
        errors.push(`relations[${index}].type is required`);
      }

      if (!relation.targetId || typeof relation.targetId !== "string") {
        errors.push(`relations[${index}].targetId is required`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

export function createOntologyEntity(input: OntologyEntity): OntologyEntity {
  const result = validateOntologyEntity(input);
  if (!result.valid) {
    throw new Error(result.errors.join("; "));
  }

  return {
    ...input,
    properties: { ...input.properties },
    relations: input.relations.map((relation) => ({ ...relation }))
  };
}

