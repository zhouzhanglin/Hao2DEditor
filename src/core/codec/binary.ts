/**
 * .hao2d 的二进制读写原语。
 * 与 C# `BinaryWriter` / `BinaryReader` 对齐：
 * - string = int32 字节长度 + UTF-8 字节（长度 <= 0 视为空串）
 * - bool = 1 字节；sbyte = 1 字节有符号
 * - 所有多字节数值均为小端
 */

export class ByteWriter {
  private buffer: ArrayBuffer
  private view: DataView
  private length = 0
  private readonly encoder = new TextEncoder()

  constructor(initialCapacity = 4096) {
    this.buffer = new ArrayBuffer(initialCapacity)
    this.view = new DataView(this.buffer)
  }

  get byteLength(): number {
    return this.length
  }

  private ensure(extra: number): void {
    const need = this.length + extra
    if (need <= this.buffer.byteLength) return
    let next = this.buffer.byteLength > 0 ? this.buffer.byteLength : 1024
    while (next < need) next *= 2
    const grown = new ArrayBuffer(next)
    new Uint8Array(grown).set(new Uint8Array(this.buffer, 0, this.length))
    this.buffer = grown
    this.view = new DataView(grown)
  }

  writeUint8(value: number): void {
    this.ensure(1)
    this.view.setUint8(this.length, value & 0xff)
    this.length += 1
  }

  writeInt8(value: number): void {
    this.ensure(1)
    this.view.setInt8(this.length, value)
    this.length += 1
  }

  writeBool(value: boolean): void {
    this.writeUint8(value ? 1 : 0)
  }

  writeUint16(value: number): void {
    this.ensure(2)
    this.view.setUint16(this.length, value & 0xffff, true)
    this.length += 2
  }

  writeInt32(value: number): void {
    this.ensure(4)
    this.view.setInt32(this.length, value | 0, true)
    this.length += 4
  }

  writeUint32(value: number): void {
    this.ensure(4)
    this.view.setUint32(this.length, value >>> 0, true)
    this.length += 4
  }

  writeFloat32(value: number): void {
    this.ensure(4)
    this.view.setFloat32(this.length, value, true)
    this.length += 4
  }

  writeString(value: string): void {
    const text = value ?? ''
    const bytes = this.encoder.encode(text)
    this.writeInt32(bytes.length)
    if (bytes.length > 0) {
      this.ensure(bytes.length)
      new Uint8Array(this.buffer, this.length, bytes.length).set(bytes)
      this.length += bytes.length
    }
  }

  writeFloatArray(values: ArrayLike<number>): void {
    this.writeInt32(values.length)
    for (let i = 0; i < values.length; i++) this.writeFloat32(values[i])
  }

  writeIntArray(values: ArrayLike<number>): void {
    this.writeInt32(values.length)
    for (let i = 0; i < values.length; i++) this.writeInt32(values[i])
  }

  writeStringArray(values: readonly string[]): void {
    this.writeInt32(values.length)
    for (const value of values) this.writeString(value)
  }

  /** 长度 16 的列主序矩阵，按列 0..3 依次写出（每列 4 个 float） */
  writeMatrix(matrix: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) this.writeFloat32(matrix[i])
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.length).slice()
  }
}

export class ByteReader {
  private readonly view: DataView
  private offset = 0
  private readonly decoder = new TextDecoder()

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get position(): number {
    return this.offset
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.byteLength) {
      throw new Error(`Hao2D: 数据在偏移 ${this.offset} 处提前结束（还需要 ${count} 字节）`)
    }
  }

  readUint8(): number {
    this.need(1)
    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  readInt8(): number {
    this.need(1)
    const value = this.view.getInt8(this.offset)
    this.offset += 1
    return value
  }

  readBool(): boolean {
    return this.readUint8() !== 0
  }

  readUint16(): number {
    this.need(2)
    const value = this.view.getUint16(this.offset, true)
    this.offset += 2
    return value
  }

  readInt32(): number {
    this.need(4)
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  readUint32(): number {
    this.need(4)
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  readFloat32(): number {
    this.need(4)
    const value = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return value
  }

  readString(): string {
    const length = this.readInt32()
    if (length <= 0) return ''
    this.need(length)
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return this.decoder.decode(slice)
  }

  readFloatArray(): number[] {
    const count = this.readInt32()
    const out = new Array<number>(count)
    for (let i = 0; i < count; i++) out[i] = this.readFloat32()
    return out
  }

  readIntArray(): number[] {
    const count = this.readInt32()
    const out = new Array<number>(count)
    for (let i = 0; i < count; i++) out[i] = this.readInt32()
    return out
  }

  readStringArray(): string[] {
    const count = this.readInt32()
    const out = new Array<string>(count)
    for (let i = 0; i < count; i++) out[i] = this.readString()
    return out
  }

  readMatrix(): Float32Array {
    const out = new Float32Array(16)
    for (let i = 0; i < 16; i++) out[i] = this.readFloat32()
    return out
  }
}
