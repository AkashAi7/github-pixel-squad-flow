/**
 * Lightweight concurrency scheduler for parallel task execution.
 * Prevents double-starts and caps the number of concurrently running tasks.
 */
export class TaskScheduler {
  private readonly running = new Set<string>();
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Returns true if the task can be started (not already running and under the cap). */
  canStart(taskId: string): boolean {
    return !this.running.has(taskId) && this.running.size < this.maxConcurrent;
  }

  /** Mark a task as running. Returns false if rejected (already running or cap reached). */
  start(taskId: string): boolean {
    if (!this.canStart(taskId)) {
      return false;
    }
    this.running.add(taskId);
    return true;
  }

  /** Mark a task as finished (success or failure). */
  finish(taskId: string): void {
    this.running.delete(taskId);
  }

  /** Number of currently running tasks. */
  get activeCount(): number {
    return this.running.size;
  }

  /** Whether the scheduler has capacity for more tasks. */
  get hasCapacity(): boolean {
    return this.running.size < this.maxConcurrent;
  }

  /** Whether a specific task is currently running. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }
}
