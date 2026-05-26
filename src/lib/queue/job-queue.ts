import { EventEmitter } from "events";
import { Logger } from "@/lib/logging/logger";

interface QueueTask {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  priority: number;
  retries: number;
  maxRetries: number;
  createdAt: Date;
}

class JobQueue extends EventEmitter {
  private queue: QueueTask[] = [];
  private running = false;
  private processing = false;
  private concurrency = 1;

  enqueue(
    type: string,
    payload: Record<string, unknown>,
    options: { priority?: number; maxRetries?: number } = {}
  ): string {
    const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const task: QueueTask = {
      id,
      type,
      payload,
      priority: options.priority ?? 5,
      retries: 0,
      maxRetries: options.maxRetries ?? 3,
      createdAt: new Date(),
    };

    this.queue.push(task);
    this.queue.sort((a, b) => a.priority - b.priority);
    this.emit("enqueued", task);

    if (this.running && !this.processing) {
      this.processNext();
    }

    return id;
  }

  start() {
    this.running = true;
    this.processNext();
  }

  stop() {
    this.running = false;
  }

  get size() {
    return this.queue.length;
  }

  private async processNext() {
    if (!this.running || this.processing || this.queue.length === 0) return;

    this.processing = true;
    const task = this.queue.shift()!;

    try {
      await Logger.debug("QUEUE", `Processing task: ${task.type}`, { id: task.id });
      this.emit("processing", task);
      await this.execute(task);
      this.emit("completed", task);
    } catch (e) {
      task.retries++;
      if (task.retries < task.maxRetries) {
        await Logger.warn("QUEUE", `Task failed, retrying (${task.retries}/${task.maxRetries})`, {
          id: task.id,
          error: String(e),
        });
        this.queue.unshift(task);
      } else {
        await Logger.error("QUEUE", `Task failed permanently: ${task.type}`, {
          id: task.id,
          error: String(e),
        });
        this.emit("failed", task, e);
      }
    } finally {
      this.processing = false;
      setTimeout(() => this.processNext(), 100);
    }
  }

  private async execute(task: QueueTask): Promise<void> {
    this.emit("execute", task);
  }
}

export const jobQueue = new JobQueue();
