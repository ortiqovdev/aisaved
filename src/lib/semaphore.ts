/**
 * Oddiy semafor: bir vaqtda ko'pi bilan `limit` ta ish, qolganlari navbat
 * tartibida (FIFO) kutadi.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;

  // Parametr-xossa (constructor(private x)) emas: Node TS'ni faqat "strip" qiladi
  constructor(limit: number) {
    this.limit = limit;
  }

  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      // Joy bo'shamaydi — to'g'ridan-to'g'ri kutayotganga o'tadi (active o'zgarmaydi)
      if (next) next();
      else this.active -= 1;
    }
  }
}
