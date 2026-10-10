import { formatPath, jsonPointer, type PathSegment } from "./json.js";

/** How serious a {@link Diagnostic} is: an error stops the operation, a warning never does. */
export type Severity = "error" | "warning";

/**
 * A problem found while validating a definition, an input or a contract.
 * `code` is stable and machine-readable (for agents that repair flows);
 * `message` is for people. `path` points into the checked document, for
 * people (`steps[2].run`).
 */
export interface Diagnostic {
  code: string;
  severity: Severity;
  path: string;
  message: string;
  /**
   * The same place as an RFC 6901 JSON Pointer into the checked document
   * (`/steps/2/run`; `""` is the whole document), for tools. Present when
   * the place is a path in the document.
   */
  pointer?: string;
  /** A mechanical fix, when there is one that does not depend on the instance. */
  hint?: string;
}

/** Collects diagnostics while a document is checked; each records its `path` and `pointer`. */
export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  error(code: string, path: readonly PathSegment[], message: string, hint?: string): void {
    this.items.push({ code, severity: "error", path: formatPath(path), pointer: jsonPointer(path), message, ...(hint !== undefined ? { hint } : {}) });
  }

  warn(code: string, path: readonly PathSegment[], message: string, hint?: string): void {
    this.items.push({ code, severity: "warning", path: formatPath(path), pointer: jsonPointer(path), message, ...(hint !== undefined ? { hint } : {}) });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

/** Thrown by APIs that refuse to proceed with an invalid document. */
export class DiagnosticsError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    const first = diagnostics.find((d) => d.severity === "error");
    super(first ? `${message}: ${first.code} at ${first.path}: ${first.message}` : message);
    this.name = "DiagnosticsError";
    this.diagnostics = diagnostics;
  }
}
