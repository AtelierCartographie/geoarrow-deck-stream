/**
 * GrowableBuffer - Dynamic TypedArray management
 * 
 * Provides efficient buffer growth without excessive reallocations.
 * Uses exponential growth strategy similar to std::vector.
 */

type TypedArray = Float32Array | Float64Array | Uint32Array | Int32Array;

/**
 * A growable typed array that minimizes reallocations
 */
export class GrowableBuffer<T extends TypedArray = Uint32Array> {
  private buffer: T;
  private _length: number = 0;
  private readonly ArrayConstructor: any;
  private readonly growthFactor: number;

  constructor(
    ArrayType: any,
    initialCapacity: number = 1024,
    growthFactor: number = 2.0
  ) {
    this.ArrayConstructor = ArrayType;
    this.growthFactor = growthFactor;
    this.buffer = new ArrayType(initialCapacity);
  }

  /**
   * Current number of elements written
   */
  get length(): number {
    return this._length;
  }

  /**
   * Set current length (truncate or extend)
   */
  set length(value: number) {
    if (value < 0) throw new Error("Length cannot be negative");
    if (value > this.buffer.length) {
      this.ensureCapacity(value);
    }
    this._length = value;
  }

  /**
   * Current buffer capacity
   */
  get capacity(): number {
    return this.buffer.length;
  }

  /**
   * Access underlying buffer (includes unused capacity)
   */
  get raw(): T {
    return this.buffer;
  }

  /**
   * Ensure capacity for at least `minCapacity` elements
   */
  ensureCapacity(minCapacity: number): void {
    if (minCapacity <= this.buffer.length) return;
    
    // Calculate new capacity with growth factor
    let newCapacity = this.buffer.length;
    while (newCapacity < minCapacity) {
      newCapacity = Math.ceil(newCapacity * this.growthFactor);
    }
    
    // Allocate and copy
    const newBuffer = new this.ArrayConstructor(newCapacity) as T;
    newBuffer.set(this.buffer.subarray(0, this._length));
    this.buffer = newBuffer;
  }

  /**
   * Push a single value
   */
  push(value: number): void {
    this.ensureCapacity(this._length + 1);
    this.buffer[this._length++] = value;
  }

  /**
   * Push two values (optimized for coordinate pairs)
   */
  push2(a: number, b: number): void {
    this.ensureCapacity(this._length + 2);
    this.buffer[this._length++] = a;
    this.buffer[this._length++] = b;
  }

  /**
   * Get value at index
   */
  get(index: number): number {
    return this.buffer[index];
  }

  /**
   * Set value at index (must be within length)
   */
  set(index: number, value: number): void {
    this.buffer[index] = value;
  }

  /**
   * Return a trimmed copy of the buffer with exact length
   */
  toArray(): T {
    return this.buffer.slice(0, this._length) as T;
  }

  /**
   * Return a view (subarray) of the used portion - no copy
   */
  view(): T {
    return this.buffer.subarray(0, this._length) as T;
  }

  /**
   * Reset length to zero (keeps capacity)
   */
  reset(): void {
    this._length = 0;
  }

  /**
   * Shrink buffer to fit current length
   */
  shrinkToFit(): void {
    if (this._length < this.buffer.length) {
      this.buffer = this.buffer.slice(0, this._length) as T;
    }
  }
}

/**
 * Pre-configured buffer factories
 */
export const Buffers = {
  /**
   * Create a Float32 buffer for positions
   */
  positions(initialCoords: number = 4096): GrowableBuffer<Float32Array> {
    return new GrowableBuffer(Float32Array, initialCoords * 2);
  },

  /**
   * Create a Uint32 buffer for indices
   */
  indices(initialCount: number = 1024): GrowableBuffer<Uint32Array> {
    return new GrowableBuffer(Uint32Array, initialCount);
  },

  /**
   * Create a Float64 buffer for high-precision coordinates
   */
  coords64(initialCoords: number = 4096): GrowableBuffer<Float64Array> {
    return new GrowableBuffer(Float64Array, initialCoords * 2);
  }
};

/**
 * Estimate initial buffer sizes based on input data
 */
export function estimateBufferSizes(
  inputCoordCount: number,
  featureCount: number,
  isIdentityProjection: boolean
): {
  positionCapacity: number;
  pathCapacity: number;
  featureIdCapacity: number;
} {
  if (isIdentityProjection) {
    // Identity: output size = input size (no clipping)
    return {
      positionCapacity: inputCoordCount * 2, // x,y pairs
      pathCapacity: featureCount,
      featureIdCapacity: featureCount
    };
  }
  
  // Reprojection: account for potential splitting
  // Clipping can both add points (at boundaries) and create multiple paths
  const splittingFactor = 1.5;
  const pointGrowthFactor = 1.2;
  
  return {
    positionCapacity: Math.ceil(inputCoordCount * 2 * pointGrowthFactor),
    pathCapacity: Math.ceil(featureCount * splittingFactor),
    featureIdCapacity: Math.ceil(featureCount * splittingFactor)
  };
}
