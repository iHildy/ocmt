import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Opens the user's preferred text editor to edit the provided content.
 * Falls back to 'vim' if no VISUAL or EDITOR environment variable is set.
 */
export async function openEditor(
	initialContent: string,
): Promise<string | null> {
	const editorCommand = process.env.VISUAL || process.env.EDITOR || "vim";
	const tmpFile = join(
		tmpdir(),
		`oc-edit-${Math.random().toString(36).slice(2)}.md`,
	);

	await fs.writeFile(tmpFile, initialContent);

	return new Promise((resolve, reject) => {
		// Use shell: true to support editor commands with arguments (e.g., "code --wait")
		const child = spawn(editorCommand, [tmpFile], {
			stdio: "inherit",
			shell: true,
		});

		child.on("exit", async (code) => {
			if (code === 0) {
				try {
					const content = await fs.readFile(tmpFile, "utf-8");
					await fs.unlink(tmpFile);
					resolve(content.trim());
				} catch (err) {
					reject(err);
				}
			} else {
				try {
					await fs.unlink(tmpFile);
				} catch {
					// ignore
				}
				resolve(null);
			}
		});

		child.on("error", async (err) => {
			try {
				await fs.unlink(tmpFile);
			} catch {
				// ignore
			}
			reject(
				new Error(
					`Failed to start editor (${editorCommand}): ${err instanceof Error ? err.message : String(err)}`,
				),
			);
		});
	});
}
