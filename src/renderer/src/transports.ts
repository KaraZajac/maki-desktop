import type { Transport } from '@shared/client'

/** maki enumerates with Baochip's baosec IDs (OpenMoko vendor space). */
export const MAKI_USB: SerialPortFilter = { usbVendorId: 0x1d50, usbProductId: 0x6198 }

export function isMaki(port: SerialPort): boolean {
  const info = port.getInfo()
  return info.usbVendorId === MAKI_USB.usbVendorId && info.usbProductId === MAKI_USB.usbProductId
}

/** The badge over USB CDC-ACM, through Chromium's Web Serial. */
export class SerialTransport implements Transport {
  private dataListener: (bytes: Uint8Array) => void = () => {}
  private closeListeners: (() => void)[] = []
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private closing = false
  private closed = false

  private constructor(readonly port: SerialPort) {
    this.writer = port.writable!.getWriter()
    void this.pump()
  }

  static async open(port: SerialPort): Promise<SerialTransport> {
    await port.open({ baudRate: 115200 }) // CDC-ACM ignores it
    return new SerialTransport(port)
  }

  private async pump(): Promise<void> {
    while (!this.closing && this.port.readable) {
      this.reader = this.port.readable.getReader()
      try {
        for (;;) {
          const { value, done } = await this.reader.read()
          if (done) break
          if (value) this.dataListener(value)
        }
      } catch {
        break // unplugged
      } finally {
        this.reader.releaseLock()
      }
    }
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    for (const l of this.closeListeners) l()
  }

  send(bytes: Uint8Array): Promise<void> {
    return this.writer.write(bytes)
  }
  onData(listener: (bytes: Uint8Array) => void): void {
    this.dataListener = listener
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }
  async close(): Promise<void> {
    this.closing = true
    await this.reader?.cancel().catch(() => {})
    this.writer.releaseLock()
    await this.port.close().catch(() => {})
    this.finish()
  }
}

/** The fake maki (libs/maki-proto/examples/fake_maki.rs), over TCP through the main process. */
export class DevTransport implements Transport {
  private dataListener: (bytes: Uint8Array) => void = () => {}
  private closeListeners: (() => void)[] = []

  private constructor() {
    window.maki.dev.onData((bytes) => this.dataListener(bytes))
    window.maki.dev.onClose(() => this.closeListeners.forEach((l) => l()))
  }

  static async open(host = '127.0.0.1', port = 7878): Promise<DevTransport> {
    await window.maki.dev.open(host, port)
    return new DevTransport()
  }
  send(bytes: Uint8Array): Promise<void> {
    return window.maki.dev.send(bytes)
  }
  onData(listener: (bytes: Uint8Array) => void): void {
    this.dataListener = listener
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }
  close(): Promise<void> {
    return window.maki.dev.close()
  }
}
