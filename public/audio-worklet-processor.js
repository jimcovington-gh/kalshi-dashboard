/**
 * Low-latency Audio Worklet Processor for Voice Trader
 * 
 * Processes microphone audio with minimal latency (~3ms chunks at 8kHz)
 * and converts to mu-law for Twilio.
 * 
 * This replaces the deprecated ScriptProcessorNode which had minimum
 * 32ms latency (256 samples buffer minimum).
 * AudioWorklet processes in 128-sample blocks = ~16ms at 8kHz.
 */

// Mu-law encoding lookup table (pre-computed for speed)
const MULAW_TABLE = new Int8Array(65536);

// Initialize mu-law table
(function initMulawTable() {
  const MULAW_BIAS = 33;
  
  for (let i = 0; i < 65536; i++) {
    // Convert unsigned 16-bit to signed
    let sample = i >= 32768 ? i - 65536 : i;
    const sign = sample < 0 ? 0x80 : 0;
    
    if (sample < 0) sample = -sample;
    
    // Add bias
    sample += MULAW_BIAS;
    
    // Find segment
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    
    // Calculate mantissa
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    
    // Combine and complement
    MULAW_TABLE[i] = (~(sign | (exponent << 4) | mantissa)) & 0xFF;
  }
})();

/**
 * Fast mu-law encoding using lookup table
 * ~10x faster than computing each sample
 */
function linearToMulawFast(float32Sample) {
  // Clamp and scale to 16-bit signed range
  const clamped = Math.max(-1, Math.min(1, float32Sample));
  const int16 = Math.round(clamped * 32767);
  // Convert to unsigned index for table lookup
  const index = int16 < 0 ? int16 + 65536 : int16;
  return MULAW_TABLE[index];
}

class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._targetSamples = 256; // Send every 256 samples (~32ms at 8kHz)
    // Lower values = lower latency but more network overhead
    // 256 samples @ 8kHz = 32ms - good balance for voice
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const inputChannel = input[0];
    
    // Convert and buffer samples
    for (let i = 0; i < inputChannel.length; i++) {
      this._buffer.push(linearToMulawFast(inputChannel[i]));
    }

    // When buffer is full, send to main thread
    if (this._buffer.length >= this._targetSamples) {
      const mulaw = new Uint8Array(this._buffer);
      this._buffer = [];
      
      // Transfer to main thread (zero-copy via transferable)
      this.port.postMessage(mulaw.buffer, [mulaw.buffer]);
    }

    return true; // Keep processor alive
  }
}

registerProcessor('microphone-processor', MicrophoneProcessor);
