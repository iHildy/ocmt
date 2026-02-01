import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function editWithEditor(
	initialContent: string,
	extension = "md",
): Promise<string | null> {
	const editor =
		process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
	const tmpFile = join(tmpdir(), `ocmt_edit_${Date.now()}.${extension}`);

	try {
		await writeFile(tmpFile, initialContent, "utf8");

		return new Promise((resolve) => {
			// Split editor command in case it has arguments (e.g. "code --wait")
			const [cmd, ...args] = editor.split(" ");

			const child = spawn(cmd, [...args, tmpFile], {
				stdio: "inherit",
			});

			child.on("exit", async (code) => {
				if (code === 0) {
					try {
						const content = await readFile(tmpFile, "utf8");
						await unlink(tmpFile);
						resolve(content);
					} catch {
						try {
							await unlink(tmpFile);
						} catch {}
						resolve(null);
					}
				} else {
					try {
						await unlink(tmpFile);
					} catch {}
					resolve(null);
				}
			});

			child.on("error", async () => {
				try {
					await unlink(tmpFile);
				} catch {}
				resolve(null);
			});
		});
	} catch {
		return null;
	}
}
