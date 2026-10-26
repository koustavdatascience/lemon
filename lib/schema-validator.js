/**
 * schema-validator.js — Slice 11
 *
 * Lightweight, dependency-free JSON schema validator for Lemon's agent
 * action responses. Keeps the bundle small and avoids CSP issues that
 * a full ajv/zod import might cause in the service-worker context.
 *
 * Usage:
 *   import { validate } from "../lib/schema-validator.js";
 *
 *   const result = validate(parsed, FIND_ELEMENT_SCHEMA);
 *   if (!result.ok) throw new Error(result.errors.join(", "));
 *
 * Returns:
 *   { ok: true }
 *   { ok: false, errors: string[] }
 */

// ─── Schema definitions ────────────────────────────────────────────────────────

/**
 * Schema for the AI response to a "find-element" request.
 *
 * Expected shape:
 *   { "elementId": <positive integer>, "reason": <non-empty string> }
 */
export const FIND_ELEMENT_SCHEMA = {
  type: "object",
  required: ["elementId", "reason"],
  properties: {
    elementId: { type: "integer", minimum: 1 },
    reason:    { type: "string",  minLength: 1 },
  },
  additionalPropertiesAllowed: true,  // don't fail on extra keys the model may add
};

/**
 * Schema for a single agent action (Slice 12).
 *
 * Expected shape:
 *   {
 *     "action": "click" | "type" | "select" | "scroll" | "done",
 *     "elementId": <positive integer>,   // absent for "scroll" and "done"
 *     "value": <string>,                  // present for "type" and "select"
 *     "reason": <non-empty string>
 *   }
 */
export const AGENT_ACTION_SCHEMA = {
  type: "object",
  required: ["action", "reason"],
  properties: {
    action:    { type: "string", enum: ["click", "type", "select", "scroll", "done"] },
    elementId: { type: "integer", minimum: 1 },
    value:     { type: "string" },
    reason:    { type: "string", minLength: 1 },
  },
  additionalPropertiesAllowed: true,
};

// ─── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate `data` against a simple `schema` descriptor.
 *
 * Supported constraint keywords:
 *   - type            : "object" | "string" | "number" | "integer" | "boolean" | "array" | "null"
 *   - required        : string[]   — keys that must be present (object only)
 *   - properties      : Record<key, schema>  — per-property sub-schemas
 *   - minimum         : number     — inclusive lower bound (number / integer)
 *   - minLength       : number     — inclusive minimum string length
 *   - enum            : any[]      — value must be one of these
 *   - items           : schema     — applied to every element of an array
 *   - additionalPropertiesAllowed : boolean  — default true (we never block extras)
 *
 * @param {unknown} data
 * @param {object}  schema
 * @param {string}  [path=""]  — dot-path used in error messages
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(data, schema, path = "") {
  const errors = [];
  _validate(data, schema, path || "root", errors);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

// ─── Internal recursive validator ─────────────────────────────────────────────

function _validate(data, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;

  // ── type check ────────────────────────────────────────────────────────────
  if (schema.type !== undefined) {
    const expectedType = schema.type;
    const actualType   = _typeOf(data);

    if (expectedType === "integer") {
      if (!Number.isInteger(data)) {
        errors.push(`${path}: expected integer, got ${actualType} (${JSON.stringify(data)})`);
        return; // no point checking further constraints on wrong type
      }
    } else if (actualType !== expectedType) {
      errors.push(`${path}: expected ${expectedType}, got ${actualType} (${JSON.stringify(data)})`);
      return;
    }
  }

  // ── enum ──────────────────────────────────────────────────────────────────
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push(
        `${path}: value ${JSON.stringify(data)} is not one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`
      );
    }
  }

  // ── minimum ───────────────────────────────────────────────────────────────
  if (schema.minimum !== undefined && typeof data === "number") {
    if (data < schema.minimum) {
      errors.push(`${path}: ${data} is less than minimum ${schema.minimum}`);
    }
  }

  // ── minLength ─────────────────────────────────────────────────────────────
  if (schema.minLength !== undefined && typeof data === "string") {
    if (data.length < schema.minLength) {
      errors.push(`${path}: string length ${data.length} is less than minLength ${schema.minLength}`);
    }
  }

  // ── object-specific checks ────────────────────────────────────────────────
  if (schema.type === "object" && data !== null && typeof data === "object") {
    // required
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          _validate(data[key], subSchema, `${path}.${key}`, errors);
        }
      }
    }
  }

  // ── array-specific checks ─────────────────────────────────────────────────
  if (schema.type === "array" && Array.isArray(data)) {
    if (schema.items) {
      data.forEach((item, i) => _validate(item, schema.items, `${path}[${i}]`, errors));
    }
  }
}

// ─── Type helper ──────────────────────────────────────────────────────────────

/**
 * Returns a JSON-schema-compatible type string for `value`.
 * Note: "integer" is never returned here — integer checks are handled
 * explicitly above using Number.isInteger().
 *
 * @param {unknown} value
 * @returns {string}
 */
function _typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "string" | "number" | "boolean" | "object" | "undefined"
}
