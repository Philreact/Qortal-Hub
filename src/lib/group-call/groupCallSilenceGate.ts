export const GROUP_CALL_SILENCE_SUPPRESSION_ENABLED = true;
export const GROUP_CALL_SILENCE_PREROLL_MS = 120;
export const GROUP_CALL_SILENCE_HANGOVER_MS = 600;

const GROUP_CALL_AUDIO_FRAME_MS = 20;
const GROUP_CALL_SILENCE_PREROLL_FRAMES = Math.ceil(
  GROUP_CALL_SILENCE_PREROLL_MS / GROUP_CALL_AUDIO_FRAME_MS
);
const GROUP_CALL_SILENCE_MAX_PREROLL_AGE_MS =
  GROUP_CALL_SILENCE_PREROLL_MS + GROUP_CALL_AUDIO_FRAME_MS * 2;
const GROUP_CALL_SILENCE_CAPTURE_RESET_GAP_MS = 1_000;

export type GroupCallSilenceFrame = {
  opusFrame: Uint8Array;
  vad: boolean;
  capturePerfMs: number;
  encoderInputPerfMs: number;
  encodeOutPerfMs: number;
  pipelineGeneration: string;
};

export type GroupCallSilenceGateDecision = {
  framesToTransmit: GroupCallSilenceFrame[];
  enteredSilence: boolean;
  exitedSilence: boolean;
  discardedStalePreRollFrames: number;
};

export type GroupCallSilenceGateDiagnostics = {
  transmittedFrames: number;
  suppressedFrames: number;
  preRollFrames: number;
  silenceTransitions: number;
  suppressionDurationMs: number;
  estimatedBytesSaved: number;
  currentlySuppressing: boolean;
  bufferedPreRollFrames: number;
};

type BufferedFrame = {
  frame: GroupCallSilenceFrame;
  estimatedPacketBytes: number;
};

/**
 * A bounded, transport-agnostic gate. Encoding remains continuous; only packet
 * construction/transmission is suppressed. Its clock is the capture clock so
 * main-thread delays cannot extend or shorten the hangover.
 */
export class GroupCallSilenceGate {
  private preRoll: BufferedFrame[] = [];
  private openUntilPerfMs: number | null = null;
  private suppressing = false;
  private suppressionStartedPerfMs: number | null = null;
  private lastCapturePerfMs: number | null = null;
  private transmittedFrames = 0;
  private suppressedFrames = 0;
  private preRollFrames = 0;
  private silenceTransitions = 0;
  private completedSuppressionDurationMs = 0;
  private estimatedBytesSaved = 0;

  reset(options?: { initialOpen?: boolean; nowPerfMs?: number }): void {
    if (this.suppressing && this.suppressionStartedPerfMs !== null) {
      const endPerfMs =
        typeof options?.nowPerfMs === 'number'
          ? options.nowPerfMs
          : (this.lastCapturePerfMs ?? this.suppressionStartedPerfMs);
      this.completedSuppressionDurationMs += Math.max(
        0,
        endPerfMs - this.suppressionStartedPerfMs
      );
    }
    this.commitBufferedFramesAsSaved();
    this.preRoll = [];
    this.suppressing = false;
    this.suppressionStartedPerfMs = null;
    this.lastCapturePerfMs = null;
    const initialOpen = options?.initialOpen !== false;
    const nowPerfMs = options?.nowPerfMs;
    this.openUntilPerfMs =
      initialOpen && typeof nowPerfMs === 'number'
        ? nowPerfMs + GROUP_CALL_SILENCE_HANGOVER_MS
        : initialOpen
          ? Number.NaN
          : null;
  }

  resetDiagnostics(): void {
    this.transmittedFrames = 0;
    this.suppressedFrames = 0;
    this.preRollFrames = 0;
    this.silenceTransitions = 0;
    this.completedSuppressionDurationMs = 0;
    this.estimatedBytesSaved = 0;
  }

  process(
    frame: GroupCallSilenceFrame,
    estimatedPacketBytes: number
  ): GroupCallSilenceGateDecision {
    const capturePerfMs = frame.capturePerfMs;
    if (
      this.lastCapturePerfMs !== null &&
      (capturePerfMs < this.lastCapturePerfMs ||
        capturePerfMs - this.lastCapturePerfMs >
          GROUP_CALL_SILENCE_CAPTURE_RESET_GAP_MS)
    ) {
      // A capture-clock discontinuity means sleep/wake, device replacement or
      // an encoder pipeline restart. Never carry pre-roll across that boundary.
      this.reset({ initialOpen: true, nowPerfMs: capturePerfMs });
    }
    this.lastCapturePerfMs = capturePerfMs;
    if (Number.isNaN(this.openUntilPerfMs)) {
      this.openUntilPerfMs = capturePerfMs + GROUP_CALL_SILENCE_HANGOVER_MS;
    }

    if (frame.vad) {
      this.openUntilPerfMs = capturePerfMs + GROUP_CALL_SILENCE_HANGOVER_MS;
      if (!this.suppressing) {
        this.preRoll = [];
        this.transmittedFrames++;
        return this.decision([frame]);
      }

      const oldestAllowedPerfMs =
        capturePerfMs - GROUP_CALL_SILENCE_MAX_PREROLL_AGE_MS;
      const freshPreRoll = this.preRoll.filter(
        (entry) => entry.frame.capturePerfMs >= oldestAllowedPerfMs
      );
      const discardedStalePreRollFrames =
        this.preRoll.length - freshPreRoll.length;
      for (const entry of this.preRoll) {
        if (entry.frame.capturePerfMs < oldestAllowedPerfMs) {
          this.estimatedBytesSaved += entry.estimatedPacketBytes;
        }
      }
      this.preRoll = [];
      this.finishSuppression(capturePerfMs);
      this.preRollFrames += freshPreRoll.length;
      this.transmittedFrames += freshPreRoll.length + 1;
      return {
        framesToTransmit: [...freshPreRoll.map((entry) => entry.frame), frame],
        enteredSilence: false,
        exitedSilence: true,
        discardedStalePreRollFrames,
      };
    }

    if (
      !this.suppressing &&
      this.openUntilPerfMs !== null &&
      capturePerfMs <= this.openUntilPerfMs
    ) {
      this.transmittedFrames++;
      return this.decision([frame]);
    }

    const enteredSilence = !this.suppressing;
    if (enteredSilence) {
      this.suppressing = true;
      this.suppressionStartedPerfMs = capturePerfMs;
      this.silenceTransitions++;
    }
    this.suppressedFrames++;
    this.preRoll.push({ frame, estimatedPacketBytes });
    while (this.preRoll.length > GROUP_CALL_SILENCE_PREROLL_FRAMES) {
      const evicted = this.preRoll.shift();
      if (evicted) this.estimatedBytesSaved += evicted.estimatedPacketBytes;
    }
    return {
      framesToTransmit: [],
      enteredSilence,
      exitedSilence: false,
      discardedStalePreRollFrames: 0,
    };
  }

  getDiagnostics(nowPerfMs: number): GroupCallSilenceGateDiagnostics {
    const activeDuration =
      this.suppressing && this.suppressionStartedPerfMs !== null
        ? Math.max(0, nowPerfMs - this.suppressionStartedPerfMs)
        : 0;
    return {
      transmittedFrames: this.transmittedFrames,
      suppressedFrames: this.suppressedFrames,
      preRollFrames: this.preRollFrames,
      silenceTransitions: this.silenceTransitions,
      suppressionDurationMs:
        this.completedSuppressionDurationMs + activeDuration,
      estimatedBytesSaved: this.estimatedBytesSaved,
      currentlySuppressing: this.suppressing,
      bufferedPreRollFrames: this.preRoll.length,
    };
  }

  private decision(
    framesToTransmit: GroupCallSilenceFrame[]
  ): GroupCallSilenceGateDecision {
    return {
      framesToTransmit,
      enteredSilence: false,
      exitedSilence: false,
      discardedStalePreRollFrames: 0,
    };
  }

  private finishSuppression(nowPerfMs: number): void {
    if (!this.suppressing) return;
    if (this.suppressionStartedPerfMs !== null) {
      this.completedSuppressionDurationMs += Math.max(
        0,
        nowPerfMs - this.suppressionStartedPerfMs
      );
    }
    this.suppressing = false;
    this.suppressionStartedPerfMs = null;
    this.silenceTransitions++;
  }

  private commitBufferedFramesAsSaved(): void {
    for (const entry of this.preRoll) {
      this.estimatedBytesSaved += entry.estimatedPacketBytes;
    }
  }
}
