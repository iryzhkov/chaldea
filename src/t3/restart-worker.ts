import type { FeedPoster } from "../feed/poster.ts";
import { recoverPlannedRestarts, type RestartJournal, type RestartOptions } from "./restart.ts";

/** Restart delivery never blocks or tears down the quota subscription. */
export class RestartRecoveryWorker {
  readonly options: RestartOptions;
  readonly journal: RestartJournal;
  readonly poster: Pick<FeedPoster, "enqueue">;
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #again = false;
  constructor(options: RestartOptions, journal: RestartJournal, poster: Pick<FeedPoster, "enqueue">) {
    this.options = options; this.journal = journal; this.poster = poster;
  }
  kick(): void {
    if (this.#closed) return;
    if (this.#running) { this.#again = true; return; }
    if (this.#timer) clearTimeout(this.#timer);
    this.#running = recoverPlannedRestarts(this.options, this.journal, this.poster)
      .catch(() => this.options.logger.warn("planned restart recovery unavailable; quota observation continues"))
      .finally(() => {
        this.#running = undefined;
        if (this.#closed) return;
        let retry: number | null = Date.now() + 5_000;
        try { retry = this.#again ? Date.now() : this.journal.nextRetry(this.options.t3BaseDir); }
        catch { this.options.logger.warn("restart journal unavailable; retrying independently"); }
        this.#again = false;
        if (retry !== null) {
          this.#timer = setTimeout(() => this.kick(), Math.max(500, retry - Date.now()));
          this.#timer.unref();
        }
      });
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }
}
