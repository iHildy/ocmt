/**
 * Execution mode determines how prompts and confirmations behave.
 *
 * - "interactive": Full action loops with all options (current behavior)
 * - "confirm-each": Show AI content, simple Enter to confirm
 * - "auto-accept": Show AI content briefly, proceed automatically
 */
export type ExecutionMode = "interactive" | "confirm-each" | "auto-accept";
