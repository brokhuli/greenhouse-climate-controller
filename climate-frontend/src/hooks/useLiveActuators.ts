import { useEffect, useRef, useState } from "react";
import type { ActuatorName, TelemetryFrame } from "../api/schemas";
import { useStream } from "../app/stream-context";

/**
 * Latest commanded/observed position per actuator for one greenhouse, kept live off the stream
 * (the detail view's `ActuatorStatePanel`). Actuator samples are low-frequency, so a state update
 * per frame is fine.
 */
export type LiveActuator = { commanded: number; observed: number | null; ts: Date };
export type LiveActuators = ReadonlyMap<ActuatorName, LiveActuator>;

export function useLiveActuators(greenhouseId: string): LiveActuators {
  const { subscribeTelemetry } = useStream();
  const latest = useRef(new Map<ActuatorName, LiveActuator>());
  const [actuators, setActuators] = useState<LiveActuators>(() => new Map());

  useEffect(() => {
    latest.current = new Map();
    setActuators(new Map());

    return subscribeTelemetry((frame: TelemetryFrame) => {
      if (frame.greenhouse_id !== greenhouseId || !frame.actuators?.length) return;
      const ts = new Date(frame.ts);
      for (const sample of frame.actuators) {
        latest.current.set(sample.actuator, {
          commanded: sample.commanded,
          observed: sample.observed,
          ts,
        });
      }
      setActuators(new Map(latest.current));
    });
  }, [greenhouseId, subscribeTelemetry]);

  return actuators;
}
