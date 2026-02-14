export class WorkerPool {
  private available: number
  private waiting: (() => void)[] = []
  private running = 0

  constructor(private maxConcurrency = 4) {
    this.available = maxConcurrency
  }

  get runningCount(): number {
    return this.running
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      this.running++
      return
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running++
        resolve()
      })
    })
  }

  release(): void {
    if (this.running <= 0) return
    this.running--
    const next = this.waiting.shift()
    if (next) {
      next()
    } else {
      this.available++
    }
  }

  async waitForAll(): Promise<void> {
    if (this.running === 0) return
    return new Promise((resolve) => {
      const check = () => {
        if (this.running === 0) {
          resolve()
        } else {
          setTimeout(check, 10)
        }
      }
      check()
    })
  }
}
