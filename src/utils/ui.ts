import * as p from "@clack/prompts";
import type { ExecutionMode } from "../types/mode";

let silentMode = false;
let executionMode: ExecutionMode = "interactive";

export function setSilentMode(silent: boolean) {
	silentMode = silent;
}

export function isSilentMode() {
	return silentMode;
}

export function createSpinner() {
	const s = p.spinner();

	return {
		start: (msg?: string) => {
			if (!silentMode) s.start(msg);
		},
		stop: (msg?: string, code?: number) => {
			if (!silentMode) s.stop(msg, code);
		},
		message: (msg?: string) => {
			if (!silentMode) s.message(msg);
		},
	};
}

export function setExecutionMode(mode: ExecutionMode) {
	executionMode = mode;
}

export function getExecutionMode(): ExecutionMode {
	return executionMode;
}

export function isAutoAcceptMode(): boolean {
	return executionMode === "auto-accept";
}

export function isConfirmEachMode(): boolean {
	return executionMode === "confirm-each";
}

export function isInteractiveMode(): boolean {
	return executionMode === "interactive";
}
