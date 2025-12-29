import * as p from "@clack/prompts";

let silentMode = false;

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
