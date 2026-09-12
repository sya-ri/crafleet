import path from "node:path";
import {
    assertStopped,
    type ConfigCaptureOptions,
    CrafleetError,
    type SecretReference,
} from "@crafleet/core";
import { NodeServerController } from "../runtime/controller.js";
import { NodeConfigManager } from "./config.js";
import { assertNoSymlinks, exists, withMutex } from "./io.js";
import { recoveryJournalPaths } from "./projects.js";

export class NodeFilesManager extends NodeConfigManager {
    constructor(
        projectDir: string,
        references: Readonly<Record<string, SecretReference>> = {},
        private readonly options: {
            home?: string;
            lockRoot?: string;
            checkpoint?: (stage: string) => Promise<void>;
        } = {},
    ) {
        super(projectDir, references, "files", options.checkpoint);
    }
    private async operate<T>(
        action: () => Promise<T>,
        dryRun = false,
        recovery = false,
    ): Promise<T> {
        const lockRoot = this.options.lockRoot ?? this.projectDir;
        const controller = new NodeServerController(
            this.projectDir,
            this.options.home ?? "",
        );
        const operation = async () => {
            await assertNoSymlinks(this.projectDir);
            assertStopped((await controller.status()).status);
            for (const journal of recoveryJournalPaths({
                dir: this.projectDir,
                lockRoot,
            })) {
                if (
                    recovery &&
                    journal ===
                        path.join(
                            this.projectDir,
                            ".crafleet/files-capture.json",
                        )
                )
                    continue;
                if (await exists(journal))
                    throw new CrafleetError(
                        "RECOVERY_REQUIRED",
                        "Recover the interrupted operation before managing files.",
                        3,
                    );
            }
            return action();
        };
        return dryRun
            ? operation()
            : withMutex(
                  path.join(lockRoot, ".crafleet/operation.lock"),
                  operation,
              );
    }
    override capture(options: ConfigCaptureOptions = {}) {
        return this.operate(() => super.capture(options), options.dryRun);
    }
    override track(relative: string) {
        return this.operate(() => super.track(relative));
    }
    override untrack(relative: string) {
        return this.operate(() => super.untrack(relative));
    }
    override resolve(relative: string, side: "base" | "runtime") {
        return this.operate(() => super.resolve(relative, side));
    }
    override async recoverCapture(dryRun = false) {
        if (
            !(await exists(
                path.join(this.projectDir, ".crafleet/files-capture.json"),
            ))
        )
            return { recovered: false };
        return this.operate(() => super.recoverCapture(dryRun), dryRun, true);
    }
}
