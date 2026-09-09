import { CrafleetError } from "@crafleet/core";

/** Contention at acquisition, distinct from BUSY raised inside a locked action. */
export class MutexBusyError extends CrafleetError {
    constructor(readonly directory: string) {
        super(
            "BUSY",
            "Another operation is active, or an interrupted operation needs recovery.",
            4,
            "Run crafleet recover after verifying no operation is active.",
        );
    }
}
